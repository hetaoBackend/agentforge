/**
 * Telegram channel for AgentForge — ported from channels/telegram_channel.py.
 *
 * Send any message to create a task. Reply to a completion/failure notification
 * to resume that task. Slash commands also supported:
 *
 *   /help                     — show help
 *   /status <id>              — task details
 *   /cancel <id>              — cancel a task
 *   /resume <id> <message>    — resume a task with a message
 *   /dir <path>               — set default working directory
 *
 * When a task completes or fails the bot sends a notification to the chat where
 * the task was created.
 *
 * Configuration via environment variables:
 *   TELEGRAM_BOT_TOKEN        — required, bot token from @BotFather
 *   TELEGRAM_ALLOWED_USERS    — optional, comma-separated Telegram user IDs
 *                               (numeric).  When set, any other user is rejected.
 *
 * Porting notes
 * ─────────────
 * The Python original uses the python-telegram-bot SDK (Application + Update +
 * polling on a dedicated thread/event loop). This port talks to the raw
 * Telegram Bot API over fetch instead:
 *   - a long-polling loop calls getUpdates with offset/timeout and routes
 *     message updates to the same handler logic as the Python handlers;
 *   - sending uses sendMessage / setMessageReaction directly.
 * The HTTP transport is an injectable seam (`_api`, default = fetch against
 * https://api.telegram.org/bot<token>/<method>) so tests can intercept calls
 * exactly where the pytest suite mocked `Application.bot`. Method names and
 * user-facing strings are kept byte-identical to the Python source.
 *
 * Threading-model mapping:
 *   _loop / _thread          → _poll_promise (the async polling loop)
 *   _loop_ready (Event)      → _ready (boolean, set when the loop starts)
 *   _app (Application)       → _api (TelegramApi seam; null ≙ missing app)
 *   asyncio.run_coroutine_threadsafe(coro) → plain `await` (single runtime)
 */

import {
  Channel,
  MessageBus,
  OutboundMessageType,
  type OutboundMessage,
  type TaskDBLike,
} from "../bus.ts";
import { makeTask, ScheduleType, type Task } from "../types.ts";
import {
  handle_agent_command,
  resolve_agent,
  type SettingsDB,
} from "./agent_utils.ts";
import { handle_dir_command, resolve_working_dir } from "./dir_utils.ts";

// ≙ Python's try/except ImportError guard around the telegram SDK import.
// fetch is always available on Bun, so this is true by default; the setter is
// the test seam matching `monkeypatch.setattr(telegram_channel,
// "TELEGRAM_AVAILABLE", False)`.
export let TELEGRAM_AVAILABLE = true;

export function _set_telegram_available(value: boolean): void {
  TELEGRAM_AVAILABLE = value;
}

export const HELP_TEXT =
  "👋 *AgentForge Bot*\n\n" +
  "Send me any message and I'll continue this chat's session\\.\n" +
  "Use /new when you want to start a fresh session\\.\n\n" +
  "*Commands:*\n" +
  "/new `<message>` — start a fresh session\n" +
  "/dir `<path>` — set default working directory\n" +
  "　　　　e\\.g\\. `/dir ~/workspace/myproject`\n" +
  "/agent `<name>` — switch coding agent \\(`claude` / `codex`\\)\n" +
  "/help — show this message\n\n" +
  "*Tips:*\n" +
  "• You can also mention a path in your message and it will be used automatically\\.\n" +
  "　e\\.g\\. _在 ~/myapp 里帮我修复登录 bug_\n" +
  "• Reply to any result notification to continue the conversation\\.";

// ── Bot-API-shaped update types ───────────────────────────────────

export interface TgUser {
  id: number;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export interface TgChat {
  id: number | string;
  type?: string | null;
  title?: string | null;
  username?: string | null;
}

export interface TgMessage {
  message_id: number;
  text?: string | null;
  chat: TgChat;
  from?: TgUser | null; // sender (≙ update.effective_user)
  reply_to_message?: { message_id: number } | null;
  forward_from?: TgUser | null;
  forward_from_chat?: TgChat | null;
  forward_date?: number | null;
}

export interface TgUpdate {
  update_id?: number;
  message?: TgMessage | null;
}

/** ≙ python-telegram-bot's `context` — only `args` is ever used. */
export interface TgContext {
  args: string[];
}

// ── structural dependency interfaces ──────────────────────────────

/** Minimal structural view of TaskDB used by this channel. */
export interface TelegramDB extends TaskDBLike, SettingsDB {
  update_task(task_id: number, updates: Record<string, unknown>): void;
}

/**
 * Minimal structural view of TaskScheduler (do NOT import scheduler.ts —
 * the channel only ever calls submit_task).
 */
export interface TelegramScheduler {
  submit_task(task: Task): number;
}

// ── injectable HTTP seam ──────────────────────────────────────────

/**
 * Calls a Telegram Bot API method and resolves with its `result` payload.
 * Rejects on transport errors or when the API answers `ok: false`.
 */
export type TelegramApi = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** Default TelegramApi implementation: fetch against api.telegram.org. */
export function make_fetch_api(token: string): TelegramApi {
  return async (method: string, params: Record<string, unknown> = {}) => {
    const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = (await resp.json()) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    };
    if (!data.ok) {
      throw new Error(
        `Telegram API ${method} failed: ${data.description ?? `HTTP ${resp.status}`}`,
      );
    }
    return data.result;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── TelegramChannel ───────────────────────────────────────────────

export class TelegramChannel extends Channel {
  declare db: TelegramDB;
  scheduler: TelegramScheduler;
  _token: string;
  _allowed_users: Set<number>;

  /** HTTP seam (≙ self._app / self._app.bot); null ≙ app not built. */
  _api: TelegramApi | null;
  /** ≙ self._loop_ready (threading.Event). */
  _ready = false;
  /** ≙ self._thread — the long-polling loop's promise. */
  _poll_promise: Promise<void> | null = null;
  /** getUpdates offset (next update_id to fetch). */
  _offset = 0;

  // Maps task_id → (chat_id, reply_message_id, reaction_message_id) for reply-back and reactions
  // reply_message_id: used for reply_to_message_id when posting completion
  // reaction_message_id: used for adding emoji reactions (may differ on resume)
  _task_origin: Map<number, [number | string, number, number]> = new Map();

  // Maps notification message_id → task_id for resume-by-reply
  _notification_map: Map<number, number> = new Map();

  // Telegram has no first-class thread/session primitive for ordinary chats.
  // Treat each chat as one active agent session until /new starts another.
  _chat_current_task: Map<string, number> = new Map();

  /** Slash-command routing table (≙ the CommandHandler registrations). */
  readonly _command_handlers: Record<
    string,
    (update: TgUpdate, context: TgContext) => Promise<void>
  >;

  constructor(
    bus: MessageBus,
    db: TelegramDB,
    scheduler: TelegramScheduler,
    token: string,
    allowed_users: number[] | null = null,
  ) {
    super("telegram", bus, db);
    this.scheduler = scheduler;
    this._token = token;
    this._allowed_users = new Set(allowed_users ?? []);
    this._api = make_fetch_api(token);

    this._command_handlers = {
      start: (u, c) => this._cmd_help(u, c),
      help: (u, c) => this._cmd_help(u, c),
      status: (u, c) => this._cmd_status(u, c),
      cancel: (u, c) => this._cmd_cancel(u, c),
      resume: (u, c) => this._cmd_resume(u, c),
    };

    // Subscribe to bus so send() is called on task updates
    bus.subscribe_outbound(this._on_outbound);
  }

  // ── lifecycle ────────────────────────────────────────────────

  start(): void {
    if (!TELEGRAM_AVAILABLE) {
      console.log(
        "[Telegram] Telegram Bot API transport unavailable in this runtime",
      );
      return;
    }
    this._running = true;
    this._poll_promise = this._run_bot();
    console.log("[Telegram] Bot thread started");
  }

  stop(): void {
    console.log("[Telegram] Stopping bot…");
    this._running = false;
    this.bus.unsubscribe_outbound(this._on_outbound);
    console.log("[Telegram] Bot stopped");
  }

  // ── Channel ABC: send outbound message ───────────────────────

  /**
   * MessageBus outbound subscriber callback. Arrow-function property so the
   * reference passed to subscribe/unsubscribe is stable (≙ bound method).
   */
  _on_outbound = (msg: OutboundMessage): void => {
    void this.send(msg);
  };

  /** Forward a task completion/failure notification to the originating chat. */
  async send(msg: OutboundMessage): Promise<void> {
    if (!this._running) return;
    if (
      msg.type !== OutboundMessageType.TASK_COMPLETED &&
      msg.type !== OutboundMessageType.TASK_FAILED
    ) {
      return;
    }
    if (!this._should_handle_outbound(msg)) {
      return;
    }
    if (!this._ready) {
      console.log(
        "[Telegram] send() called before event loop ready, dropping message",
      );
      return;
    }
    if (!this._api) return;
    const api = this._api;

    const task_id = msg.task_id;
    const origin = this._task_origin.get(task_id);

    const is_completed = msg.type === OutboundMessageType.TASK_COMPLETED;
    let body: string;
    if (is_completed) {
      let result_text = (
        (msg.payload["result"] as string | null | undefined) || ""
      ).trim();
      if (result_text.length > 10000) {
        result_text = result_text.slice(0, 10000) + "\n…(truncated)";
      }
      body = result_text || "Done.";
    } else {
      let error_text = (
        (msg.payload["error"] as string | null | undefined) || "Unknown error"
      ).trim();
      // Smart truncation: keep beginning (most informative) and signal cut
      if (error_text.length > 800) {
        error_text = error_text.slice(0, 800) + "\n…(truncated)";
      }
      body = error_text;
    }

    let chat_id: number | string;
    let orig_message_id: number | null = null;
    let reaction_message_id: number | null = null;
    let text: string;
    if (origin) {
      [chat_id, orig_message_id, reaction_message_id] = origin;
      const status_emoji = is_completed ? "✅" : "❌";
      text = `${status_emoji}\n${body}`;
    } else {
      const default_chat_id =
        this.db.get_setting("telegram_default_chat_id", "") ?? "";
      if (!default_chat_id) {
        console.log(
          `[Telegram] No origin and no telegram_default_chat_id configured for task #${task_id}, skipping`,
        );
        return;
      }
      // ≙ str(default_chat_id).lstrip("-").isdigit()
      chat_id = /^\d+$/.test(String(default_chat_id).replace(/^-+/, ""))
        ? parseInt(String(default_chat_id), 10)
        : default_chat_id;
      const status_emoji = is_completed ? "✅" : "❌";
      text = `${status_emoji}\n${body}`;
      console.log(
        `[Telegram] Using default chat_id=${chat_id} for task #${task_id}`,
      );
    }

    // Free origin memory after terminal state (Python pops right after
    // scheduling the coroutine; here we pop before awaiting the sends).
    this._task_origin.delete(task_id);

    // ≙ the _send_and_track() coroutine
    try {
      const react_target = reaction_message_id ?? orig_message_id;
      if (react_target) {
        // Add emoji reaction to the message that triggered the task (or resume)
        const emoji =
          msg.type === OutboundMessageType.TASK_COMPLETED ? "👍" : "👎";
        try {
          await api("setMessageReaction", {
            chat_id,
            message_id: react_target,
            reaction: [{ type: "emoji", emoji }],
          });
        } catch (e) {
          console.log(
            `[Telegram] Failed to set reaction on message ${react_target}: ${e}`,
          );
        }
      }

      const params: Record<string, unknown> = { chat_id, text };
      if (orig_message_id !== null)
        params["reply_to_message_id"] = orig_message_id;
      const sent = (await api("sendMessage", params)) as
        | { message_id: number }
        | null
        | undefined;
      if (sent) {
        this._notification_map.set(sent.message_id, task_id);
        console.log(
          `[Telegram] Notification msg_id=${sent.message_id} mapped to task #${task_id}`,
        );
      }
    } catch (e) {
      console.log(`[Telegram] Failed to send notification to ${chat_id}: ${e}`);
    }
  }

  // ── private helpers ──────────────────────────────────────────

  /** Entry point for the polling loop (≙ the bot thread's _run_bot). */
  async _run_bot(): Promise<void> {
    this._ready = true; // ≙ self._loop_ready.set()
    try {
      await this._start_app();
    } catch (e) {
      console.log(`[Telegram] Bot error: ${e}`);
    }
  }

  /** ≙ Application bootstrap + updater.start_polling(drop_pending_updates=True). */
  async _start_app(): Promise<void> {
    await this._drop_pending_updates();
    console.log("[Telegram] Bot polling started");

    while (this._running) {
      await this._poll_once();
    }
  }

  /** Skip the pending-update backlog (≙ drop_pending_updates=True). */
  async _drop_pending_updates(): Promise<void> {
    if (!this._api) return;
    try {
      const updates = (await this._api("getUpdates", {
        offset: -1,
        timeout: 0,
      })) as TgUpdate[] | null | undefined;
      if (updates && updates.length > 0) {
        const last = updates[updates.length - 1]!;
        this._offset = (last.update_id ?? 0) + 1;
      }
    } catch (e) {
      console.log(`[Telegram] Failed to drop pending updates: ${e}`);
    }
  }

  /** One getUpdates long-poll iteration; routes each update to the handlers. */
  async _poll_once(): Promise<void> {
    if (!this._api) return;
    try {
      const updates = (await this._api("getUpdates", {
        offset: this._offset,
        timeout: 30,
        allowed_updates: ["message"],
      })) as TgUpdate[] | null | undefined;
      for (const update of updates ?? []) {
        if (typeof update.update_id === "number") {
          this._offset = update.update_id + 1;
        }
        try {
          await this._handle_update(update);
        } catch (e) {
          console.log(`[Telegram] Error handling update: ${e}`);
        }
      }
    } catch (e) {
      console.log(`[Telegram] Polling error: ${e}`);
      await sleep(1000);
    }
  }

  /**
   * Route a Bot API update: registered slash commands go to their _cmd_*
   * handler, all other text goes to _handle_text_message (which itself deals
   * with /dir and /agent — same effective routing as the Python handlers).
   */
  async _handle_update(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || typeof msg.text !== "string" || !msg.text) return;
    const text = msg.text.trim();
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0]!.slice(1).split("@")[0]!.toLowerCase();
      const handler = this._command_handlers[cmd];
      if (handler) {
        await handler(update, { args: parts.slice(1) });
        return;
      }
    }
    await this._handle_text_message(update, { args: [] });
  }

  /** ≙ update.message.reply_text(...) */
  async _reply_text(
    update: TgUpdate,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this._api!("sendMessage", {
      chat_id: update.message!.chat.id,
      text,
      ...extra,
    });
  }

  async _send_text(chat_id: number | string, text: string): Promise<void> {
    try {
      await this._api!("sendMessage", { chat_id, text });
    } catch (e) {
      console.log(`[Telegram] Failed to send message to ${chat_id}: ${e}`);
    }
  }

  _is_allowed(user_id: number): boolean {
    if (this._allowed_users.size === 0) return true;
    return this._allowed_users.has(user_id);
  }

  // ── unified text message handler ──────────────────────────────

  /**
   * 格式化转发的消息文本，添加发送者和时间信息
   *
   * @param text 消息文本
   * @param update Telegram Update 对象
   * @returns 格式化后的文本
   */
  _format_forwarded_text(text: string, update: TgUpdate): string {
    const msg = update.message!;
    const is_forwarded = msg.forward_from || msg.forward_date;

    if (!is_forwarded) return text;

    const parts: string[] = ["📨 [转发消息]"];

    // 获取发送者信息
    let sender_name = "未知用户";
    if (msg.forward_from) {
      const sender = msg.forward_from;
      if (sender.username) {
        sender_name = `@${sender.username}`;
      } else {
        const name_parts: string[] = [sender.first_name || ""];
        if (sender.last_name) {
          name_parts.push(sender.last_name);
        }
        sender_name = name_parts.filter(Boolean).join(" ");
      }
      parts.push(`转发自: ${sender_name}`);
    } else if (msg.forward_from_chat) {
      const chat = msg.forward_from_chat;
      sender_name = chat.title || chat.username || "未知频道";
      if (chat.type === "channel") {
        parts.push(`转发自频道: ${sender_name}`);
      } else if (chat.type === "group" || chat.type === "supergroup") {
        parts.push(`转发自群组: ${sender_name}`);
      } else {
        parts.push(`转发自: ${sender_name}`);
      }
    } else {
      parts.push(`转发自: ${sender_name}`);
    }

    // 添加时间戳 (UTC+8, ≙ datetime.fromtimestamp(..., tz=timezone(timedelta(hours=8))))
    if (msg.forward_date) {
      const d = new Date((msg.forward_date + 8 * 3600) * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      const ts =
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      parts.push(`时间: ${ts}`);
    }

    parts.push("\n--- 转发内容 ---");
    parts.push(text);

    return parts.join("\n");
  }

  /** Handle any non-command text: resume-by-reply or create task. */
  async _handle_text_message(
    update: TgUpdate,
    _context: TgContext,
  ): Promise<void> {
    if (!this._is_allowed(update.message!.from!.id)) {
      await this._reply_text(
        update,
        "⛔ You are not authorised to use this bot.",
      );
      return;
    }

    let text = (update.message!.text || "").trim();
    if (!text) return;
    const chat_id = update.message!.chat.id;

    const new_match = /^\/new(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const force_new_session = Boolean(new_match);
    if (new_match) {
      text = (new_match[1] || "").trim();
      this._clear_chat_current_task(chat_id);
      if (!text) {
        await this._reply_text(
          update,
          "🆕 已开启新的 Telegram session，请发送新的内容。",
        );
        return;
      }
    }

    // ── /dir command: switch working directory ─────────────────
    const dir_reply = handle_dir_command(text, "telegram", this.db);
    if (dir_reply !== null) {
      await this._reply_text(update, dir_reply);
      return;
    }

    // ── /agent command: switch coding agent ──────────────────
    const agent_reply = handle_agent_command(text, "telegram", this.db);
    if (agent_reply !== null) {
      await this._reply_text(update, agent_reply);
      return;
    }

    // ── 检测转发消息 ───────────────────────────────────────
    text = this._format_forwarded_text(text, update);

    // ── reply to a notification → resume task ─────────────────
    const reply = update.message!.reply_to_message;
    if (reply && !force_new_session) {
      const task_id = this._notification_map.get(reply.message_id);
      if (task_id) {
        const task = this.db.get_task(task_id);
        if (task && task["session_id"]) {
          this.db.update_task(task_id, {
            status: "pending",
            prompt: text,
            result: null,
            error: null,
            question: null,
          });
          this._task_origin.set(task_id, [
            chat_id,
            update.message!.message_id,
            update.message!.message_id,
          ]);
          this._remember_task_source(task_id);
          this._set_chat_current_task(chat_id, task_id);

          // Add "eyes" reaction without sending an extra ack message.
          try {
            await this._api!("setMessageReaction", {
              chat_id,
              message_id: update.message!.message_id,
              reaction: [{ type: "emoji", emoji: "👀" }],
            });
          } catch (e) {
            console.log(`[Telegram] Failed to set resume reaction: ${e}`);
          }
          console.log(`[Telegram] Auto-resuming task ${task_id} from reply`);
          return;
        } else {
          await this._reply_text(update, "❌ 这条会话还没有可继续的上下文。");
          return;
        }
      }
    }

    const current_task_id = force_new_session
      ? null
      : this._get_chat_current_task(chat_id);
    if (current_task_id !== null) {
      const task = this.db.get_task(current_task_id);
      if (task && task["session_id"]) {
        this.db.update_task(current_task_id, {
          status: "pending",
          prompt: text,
          result: null,
          error: null,
          question: null,
        });
        this._task_origin.set(current_task_id, [
          chat_id,
          update.message!.message_id,
          update.message!.message_id,
        ]);
        this._remember_task_source(current_task_id);
        this._set_chat_current_task(chat_id, current_task_id);

        try {
          await this._api!("setMessageReaction", {
            chat_id,
            message_id: update.message!.message_id,
            reaction: [{ type: "emoji", emoji: "👀" }],
          });
        } catch (e) {
          console.log(`[Telegram] Failed to set resume reaction: ${e}`);
        }
        console.log(
          `[Telegram] Auto-resuming task ${current_task_id} from chat session`,
        );
        return;
      }
    }

    // ── default: create a new task ────────────────────────────
    await this._create_task(text, chat_id, update);
  }

  /** Create a new task from any message text. */
  async _create_task(
    text: string,
    chat_id: number | string,
    update: TgUpdate,
  ): Promise<void> {
    const msg = update.message!;

    // 检查是否为转发消息，用于添加标题标记
    const is_forwarded = Boolean(msg.forward_from || msg.forward_date);
    const title_prefix = is_forwarded ? "📨 " : "";
    const title = text.slice(0, 60) + (text.length > 60 ? "…" : "");

    const working_dir = await resolve_working_dir(text, "telegram", this.db);

    const task = makeTask({
      title: `[Telegram] ${title_prefix}${title}`,
      prompt: text,
      working_dir,
      schedule_type: ScheduleType.IMMEDIATE,
      tags: "telegram" + (is_forwarded ? ", forwarded" : ""),
      agent: resolve_agent("telegram", this.db),
    });
    const task_id = this.scheduler.submit_task(task);
    console.log(
      `[Telegram] Task #${task_id} created from message${is_forwarded ? " (forwarded)" : ""}`,
    );

    const message_id = msg.message_id;
    this._task_origin.set(task_id, [chat_id, message_id, message_id]);
    this._remember_task_source(task_id);
    this._set_chat_current_task(chat_id, task_id);

    // Acknowledge with an "eyes" reaction without exposing task IDs.
    // (≙ the _react() coroutine scheduled via run_coroutine_threadsafe)
    try {
      await this._api!("setMessageReaction", {
        chat_id,
        message_id,
        reaction: [{ type: "emoji", emoji: "👀" }],
      });
    } catch (e) {
      console.log(`[Telegram] Failed to set reaction: ${e}`);
    }
  }

  // ── command handlers ──────────────────────────────────────────

  async _cmd_help(update: TgUpdate, _context: TgContext): Promise<void> {
    if (!this._is_allowed(update.message!.from!.id)) {
      await this._reply_text(
        update,
        "⛔ You are not authorised to use this bot.",
      );
      return;
    }
    await this._reply_text(update, HELP_TEXT, { parse_mode: "MarkdownV2" });
  }

  async _cmd_status(update: TgUpdate, context: TgContext): Promise<void> {
    if (!this._is_allowed(update.message!.from!.id)) {
      await this._reply_text(update, "⛔ Not authorised.");
      return;
    }

    const arg0 =
      context.args.length > 0 ? context.args[0]!.replace(/^#+/, "") : "";
    if (!/^\d+$/.test(arg0)) {
      await this._reply_text(update, "Usage: /status <task_id>");
      return;
    }

    const task_id = parseInt(arg0, 10);
    const task = this.db.get_task(task_id);
    if (!task) {
      await this._reply_text(update, `❌ Task #${task_id} not found.`);
      return;
    }

    const status_icon: Record<string, string> = {
      pending: "🕐",
      scheduled: "📅",
      running: "⏳",
      completed: "✅",
      failed: "❌",
      cancelled: "🚫",
    };
    const icon = status_icon[task["status"] as string] ?? "•";
    const lines = [
      `${icon} Task #${task_id} — ${task["status"]}`,
      `${task["title"]}`,
      `Created: ${String(task["created_at"] ?? "—").slice(0, 16)}`,
      `Last run: ${String(task["last_run_at"] || "—").slice(0, 16)}`,
    ];
    if (task["error"]) {
      lines.push(`\nError: ${String(task["error"]).slice(0, 300)}`);
    }
    if (task["result"]) {
      lines.push(`\nResult: ${String(task["result"]).slice(0, 500)}`);
    }

    await this._reply_text(update, lines.join("\n"));
  }

  async _cmd_cancel(update: TgUpdate, context: TgContext): Promise<void> {
    if (!this._is_allowed(update.message!.from!.id)) {
      await this._reply_text(update, "⛔ Not authorised.");
      return;
    }

    const arg0 =
      context.args.length > 0 ? context.args[0]!.replace(/^#+/, "") : "";
    if (!/^\d+$/.test(arg0)) {
      await this._reply_text(update, "Usage: /cancel <task_id>");
      return;
    }

    const task_id = parseInt(arg0, 10);
    const task = this.db.get_task(task_id);
    if (!task) {
      await this._reply_text(update, `❌ Task #${task_id} not found.`);
      return;
    }
    const status = task["status"] as string;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      await this._reply_text(
        update,
        `ℹ️ Task #${task_id} is already ${status}.`,
      );
      return;
    }

    this.db.update_task(task_id, { status: "cancelled" });
    await this._reply_text(update, `🚫 Task #${task_id} cancelled.`);
  }

  async _cmd_resume(update: TgUpdate, context: TgContext): Promise<void> {
    if (!this._is_allowed(update.message!.from!.id)) {
      await this._reply_text(update, "⛔ Not authorised.");
      return;
    }

    const arg0 =
      context.args.length > 0 ? context.args[0]!.replace(/^#+/, "") : "";
    if (!/^\d+$/.test(arg0)) {
      await this._reply_text(update, "Usage: /resume <task_id> <message>");
      return;
    }

    const tid = parseInt(arg0, 10);
    const resume_msg = context.args.slice(1).join(" ").trim();
    if (!resume_msg) {
      await this._reply_text(
        update,
        "Please provide a message to resume with.",
      );
      return;
    }

    const task = this.db.get_task(tid);
    if (!task || !task["session_id"]) {
      await this._reply_text(
        update,
        `❌ Task #${tid} not found or has no saved session.`,
      );
      return;
    }

    this.db.update_task(tid, {
      status: "pending",
      prompt: resume_msg,
      result: null,
      error: null,
      question: null,
    });
    const chat_id = update.message!.chat.id;
    this._task_origin.set(tid, [
      chat_id,
      update.message!.message_id,
      update.message!.message_id,
    ]);
    this._remember_task_source(tid);
    this._set_chat_current_task(chat_id, tid);

    // Add "eyes" reaction to the user's command message
    try {
      await this._api!("setMessageReaction", {
        chat_id,
        message_id: update.message!.message_id,
        reaction: [{ type: "emoji", emoji: "👀" }],
      });
    } catch (e) {
      console.log(`[Telegram] Failed to set resume reaction: ${e}`);
    }
  }

  _chat_key(chat_id: number | string): string {
    return String(chat_id);
  }

  _chat_current_task_setting_key(chat_id: number | string): string {
    return `telegram_chat_current_task:${this._chat_key(chat_id)}`;
  }

  _get_chat_current_task(chat_id: number | string): number | null {
    const key = this._chat_key(chat_id);
    const cached = this._chat_current_task.get(key);
    if (cached !== undefined) return cached;

    const persisted = this.db.get_setting(
      this._chat_current_task_setting_key(chat_id),
      "",
    );
    if (!persisted || !/^\d+$/.test(persisted)) return null;

    const task_id = parseInt(persisted, 10);
    this._chat_current_task.set(key, task_id);
    return task_id;
  }

  _set_chat_current_task(chat_id: number | string, task_id: number): void {
    this._chat_current_task.set(this._chat_key(chat_id), task_id);
    this.db.set_setting(
      this._chat_current_task_setting_key(chat_id),
      String(task_id),
    );
  }

  _clear_chat_current_task(chat_id: number | string): void {
    this._chat_current_task.delete(this._chat_key(chat_id));
    this.db.set_setting(this._chat_current_task_setting_key(chat_id), "");
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Escape special MarkdownV2 characters. */
export function _escape_md(text: string): string {
  const special = "\\_*[]()~`>#+-=|{}.!";
  return [...text].map((c) => (special.includes(c) ? `\\${c}` : c)).join("");
}

// ── factory helper ───────────────────────────────────────────────────────────

/** Create a TelegramChannel from explicit params or environment variables. */
export function create_telegram_channel(
  db: TelegramDB,
  scheduler: TelegramScheduler,
  bus: MessageBus | null = null,
  token: string = "",
  allowed_users_str: string = "",
): TelegramChannel | null {
  token = (token || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) return null;

  const allowed_raw = (
    allowed_users_str ||
    process.env.TELEGRAM_ALLOWED_USERS ||
    ""
  ).trim();
  const allowed_users: number[] = [];
  if (allowed_raw) {
    for (const raw of allowed_raw.split(",")) {
      const uid = raw.trim();
      if (/^\d+$/.test(uid)) {
        allowed_users.push(parseInt(uid, 10));
      }
    }
  }

  return new TelegramChannel(
    bus ?? new MessageBus(),
    db,
    scheduler,
    token,
    allowed_users,
  );
}
