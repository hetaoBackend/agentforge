/**
 * AgentForge Slack Channel — ported from channels/slack_channel.py.
 *
 * Listens for @bot mentions and DMs via Slack Socket Mode (no public IP
 * required). Send any message to create a task; reply to a completion
 * notification to resume. Slash commands (/status, /cancel, /resume) are also
 * supported.
 *
 * Required environment variables:
 *   SLACK_BOT_TOKEN   — xoxb-... bot token
 *   SLACK_APP_TOKEN   — xapp-... app-level token (for Socket Mode)
 *
 * Porting notes:
 * - Python used slack-sdk's WebClient + SocketModeClient. The TS port uses
 *   @slack/web-api + @slack/socket-mode, wrapped in thin adapters so the
 *   channel keeps the exact Python calling surface (chat_postMessage,
 *   reactions_add, conversations_open, auth_test,
 *   socket_mode_request_listeners, connect/disconnect). Tests inject fake
 *   client objects with the same surface.
 * - Python's lazy `_require_slack()` import guard is mirrored: the dynamic
 *   import goes through the `_hooks.import_slack` test seam and import
 *   failures raise the same error message.
 * - Python's daemon threads (reaction adds, notification sends) become
 *   fire-and-forget async functions; threading.Lock dropped (single-threaded
 *   event loop).
 */

import { Channel, OutboundMessageType } from "../bus.ts";
import type { MessageBus, OutboundMessage, TaskDBLike } from "../bus.ts";
import { makeTask, ScheduleType } from "../types.ts";
import { handle_agent_command, resolve_agent } from "./agent_utils.ts";
import type { SettingsDB } from "./agent_utils.ts";
import { handle_dir_command, resolve_working_dir } from "./dir_utils.ts";
import type { Task } from "../types.ts";

// ── injected client surfaces (≙ slack_sdk WebClient / SocketModeClient) ──

/** Structural view of the web client the channel talks to (Python names). */
export interface WebClientLike {
  auth_test(): Promise<any>;
  chat_postMessage(args: {
    channel: string;
    thread_ts?: string | null;
    text: string;
    mrkdwn?: boolean;
  }): Promise<any>;
  reactions_add(args: {
    channel: string;
    timestamp: string;
    name: string;
  }): Promise<any>;
  conversations_open(args: { users: string }): Promise<any>;
}

/** ≙ slack_sdk SocketModeRequest (type / envelope_id / payload). */
export interface SocketModeRequestLike {
  type: string;
  envelope_id: string;
  payload: Record<string, any>;
}

/** The "client" passed to socket-mode listeners; used only to ack. */
export interface SocketAckClientLike {
  send_socket_mode_response(resp: { envelope_id: string }): void;
}

export type SocketModeRequestListener = (
  client: SocketAckClientLike,
  req: SocketModeRequestLike,
) => void | Promise<void>;

/** Structural view of the socket-mode client (Python calling surface). */
export interface SocketModeClientLike {
  socket_mode_request_listeners: SocketModeRequestListener[];
  connect(): void | Promise<void>;
  disconnect(): void | Promise<void>;
}

/** What `_require_slack()` returns: the two client constructors. */
export interface SlackSDK {
  WebClient: new (token?: string) => WebClientLike;
  SocketModeClient: new (opts: {
    app_token?: string;
    web_client?: WebClientLike | null;
  }) => SocketModeClientLike;
}

// ── lazy import guard (≙ Python _require_slack) ───────────────────────────

async function _import_slack(): Promise<SlackSDK> {
  const webApi: any = await import("@slack/web-api");
  const socketMode: any = await import("@slack/socket-mode");

  /** Adapter exposing the Python slack_sdk WebClient surface. */
  class WebClientAdapter implements WebClientLike {
    private _client: any;

    constructor(token?: string) {
      this._client = new webApi.WebClient(token);
    }

    auth_test(): Promise<any> {
      return this._client.auth.test();
    }

    chat_postMessage(args: {
      channel: string;
      thread_ts?: string | null;
      text: string;
      mrkdwn?: boolean;
    }): Promise<any> {
      return this._client.chat.postMessage({
        channel: args.channel,
        thread_ts: args.thread_ts ?? undefined,
        text: args.text,
        mrkdwn: args.mrkdwn,
      });
    }

    reactions_add(args: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<any> {
      return this._client.reactions.add({
        channel: args.channel,
        timestamp: args.timestamp,
        name: args.name,
      });
    }

    conversations_open(args: { users: string }): Promise<any> {
      return this._client.conversations.open({ users: args.users });
    }
  }

  /**
   * Adapter exposing the Python slack_sdk SocketModeClient surface
   * (socket_mode_request_listeners + connect/disconnect) on top of
   * @slack/socket-mode's EventEmitter API.
   */
  class SocketModeClientAdapter implements SocketModeClientLike {
    socket_mode_request_listeners: SocketModeRequestListener[] = [];
    private _client: any;

    constructor(opts: {
      app_token?: string;
      web_client?: WebClientLike | null;
    }) {
      this._client = new socketMode.SocketModeClient({
        appToken: opts.app_token,
      });
      this._client.on("slack_event", (args: any) => {
        const ack_client: SocketAckClientLike = {
          send_socket_mode_response: (_resp: { envelope_id: string }) => {
            void Promise.resolve(args.ack()).catch((e: unknown) => {
              console.log(`[Slack] ack failed: ${e}`);
            });
          },
        };
        const req: SocketModeRequestLike = {
          type: args.type,
          envelope_id: args.envelope_id,
          payload: args.body ?? {},
        };
        for (const listener of this.socket_mode_request_listeners) {
          void Promise.resolve(listener(ack_client, req)).catch(
            (e: unknown) => {
              console.log(`[Slack] socket request listener error: ${e}`);
            },
          );
        }
      });
    }

    async connect(): Promise<void> {
      await this._client.start();
    }

    async disconnect(): Promise<void> {
      await this._client.disconnect();
    }
  }

  return {
    WebClient: WebClientAdapter,
    SocketModeClient: SocketModeClientAdapter,
  };
}

// Test seam (≙ pytest monkeypatching the slack_sdk import / _require_slack).
export const _hooks = { import_slack: _import_slack };

export async function _require_slack(): Promise<SlackSDK> {
  try {
    return await _hooks.import_slack();
  } catch (e) {
    throw new Error(
      "@slack/web-api and @slack/socket-mode are required for SlackChannel",
      {
        cause: e,
      },
    );
  }
}

// ── help text (byte-identical to Python) ──────────────────────────────────

export const HELP_TEXT = `*AgentForge Bot* 👋
Send me any message and I'll create a task from it.
Reply to a completion/failure notification to resume that task.

*Commands:*
• \`/status <id>\` — show task details
• \`/cancel <id>\` — cancel a task
• \`/resume <id> <message>\` — resume a task with a message
• \`/dir <path>\` — set default working directory
　　e.g. \`/dir ~/workspace/myproject\`
• \`/agent <name>\` — switch coding agent (\`claude\` / \`codex\`)
• \`/help\` — show this message

*Tips:*
• You can also mention a path in your message and it will be used automatically.
　e.g. _在 ~/myapp 里帮我修复登录 bug_
• Reply to any result notification to continue the conversation.
`;

// ── structural dependencies ───────────────────────────────────────────────

/** Minimal structural view of TaskDB used by this channel. */
export interface SlackTaskDB extends TaskDBLike, SettingsDB {
  update_task(task_id: number, updates: Record<string, unknown>): void;
}

/**
 * Minimal structural view of TaskScheduler used by this channel
 * (≙ Python `TaskScheduler.submit_task(task) -> int`).
 */
export interface SchedulerLike {
  submit_task(task: Task): number;
}

// ── channel ───────────────────────────────────────────────────────────────

/** Slack channel integration using Socket Mode. */
export class SlackChannel extends Channel {
  declare db: SlackTaskDB;
  scheduler: SchedulerLike;

  bot_token: string;
  app_token: string;

  _web_client: WebClientLike | null = null;
  _socket_client: SocketModeClientLike | null = null;
  _bot_user_id: string | null = null;

  // Maps task_id → [channel_id, thread_ts, reaction_ts] for reply-back on completion
  // thread_ts: used for posting reply messages in the correct thread
  // reaction_ts: used for adding emoji reactions (may differ from thread_ts on resume)
  _task_origin: Map<number, [string, string | null, string | null]> = new Map();

  // DM channel cache for P2P fallback (user_id → DM channel_id)
  _dm_channel_cache: Map<string, string> = new Map();

  // Maps notification thread_ts → task_id for resume-by-reply
  _notification_map: Map<string, number> = new Map();

  // Maps thread root ts → task_id for thread-based session resume
  _thread_ts_map: Map<string, number> = new Map();

  constructor(
    bus: MessageBus,
    db: SlackTaskDB,
    scheduler: SchedulerLike,
    bot_token: string = "",
    app_token: string = "",
  ) {
    super("slack", bus, db);
    this.scheduler = scheduler;

    this.bot_token = bot_token || process.env.SLACK_BOT_TOKEN || "";
    this.app_token = app_token || process.env.SLACK_APP_TOKEN || "";

    // Subscribe to outbound bus messages for task notifications
    bus.subscribe_outbound(this._on_outbound);

    console.log(
      `[Slack] Initialized. bot_token=${this.bot_token ? "set" : "MISSING"}, ` +
        `app_token=${this.app_token ? "set" : "MISSING"}`,
    );
  }

  // ── lifecycle ────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.bot_token || !this.app_token) {
      console.log(
        "[Slack] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN — channel disabled",
      );
      return;
    }

    console.log("[Slack] Starting... importing slack_sdk");
    const { WebClient, SocketModeClient } = await _require_slack();
    console.log("[Slack] slack_sdk imported successfully");

    this._web_client = new WebClient(this.bot_token);
    console.log("[Slack] WebClient created, calling auth_test()...");

    // Resolve bot's own user ID so we can ignore self-messages
    try {
      const resp = await this._web_client.auth_test();
      this._bot_user_id = resp["user_id"];
      console.log(
        `[Slack] auth_test OK — bot_user_id=${this._bot_user_id}, ` +
          `team=${resp["team"] ?? "?"}, user=${resp["user"] ?? "?"}`,
      );
    } catch (e) {
      console.log(`[Slack] auth_test FAILED: ${e}`);
      console.error((e as Error)?.stack ?? e);
      return;
    }

    console.log("[Slack] Creating SocketModeClient...");
    this._socket_client = new SocketModeClient({
      app_token: this.app_token,
      web_client: this._web_client,
    });

    // Register event handler
    this._socket_client.socket_mode_request_listeners.push(
      this._handle_socket_request,
    );
    console.log("[Slack] Registered socket_mode_request_listeners");

    this._running = true;
    console.log("[Slack] Calling socket_client.connect()...");
    await this._socket_client.connect();
    console.log("[Slack] Socket Mode connected — listening for events");
  }

  stop(): void {
    console.log("[Slack] Stopping...");
    this._running = false;
    this.bus.unsubscribe_outbound(this._on_outbound);
    if (this._socket_client) {
      try {
        void Promise.resolve(this._socket_client.disconnect()).catch(() => {});
      } catch {
        /* ignore */
      }
    }
    console.log("[Slack] Stopped");
  }

  // ── socket mode handler ──────────────────────────────────────

  // Arrow property: a stable bound reference is pushed into
  // socket_mode_request_listeners (≙ Python bound method).
  _handle_socket_request = async (
    client: SocketAckClientLike,
    req: SocketModeRequestLike,
  ): Promise<void> => {
    console.log(
      `[Slack] <<< Socket request received: type=${req.type}, ` +
        `envelope_id=${req.envelope_id.slice(0, 12)}...`,
    );

    // Acknowledge immediately (Slack requires < 3s ack)
    client.send_socket_mode_response({ envelope_id: req.envelope_id });
    console.log(
      `[Slack]     ACK sent for envelope ${req.envelope_id.slice(0, 12)}`,
    );

    if (req.type !== "events_api") {
      console.log(
        `[Slack]     Ignoring non-events_api request type: ${req.type}`,
      );
      return;
    }

    const payload = req.payload ?? {};
    const event: Record<string, any> = payload["event"] ?? {};
    const event_type: string = event["type"] ?? "";

    console.log(
      `[Slack]     Event type=${event_type}, ` +
        `user=${event["user"] ?? "?"}, ` +
        `channel=${event["channel"] ?? "?"}, ` +
        `channel_type=${event["channel_type"] ?? "?"}, ` +
        `bot_id=${event["bot_id"] ?? "none"}, ` +
        `subtype=${event["subtype"] ?? "none"}, ` +
        `text=${JSON.stringify((event["text"] ?? "").slice(0, 80))}`,
    );

    // Handle message events
    try {
      if (event_type === "message") {
        await this._handle_message_event(event);
      } else if (event_type === "app_mention") {
        await this._handle_mention_event(event);
      } else if (event_type === "app_home_opened") {
        await this._handle_app_home_opened(event);
      } else {
        console.log(`[Slack]     Unhandled event type: ${event_type}`);
      }
    } catch (e) {
      console.log(`[Slack] ERROR handling ${event_type} event: ${e}`);
      console.error((e as Error)?.stack ?? e);
    }
  };

  /** Handle DM messages (channel_type == 'im'). */
  async _handle_message_event(event: Record<string, any>): Promise<void> {
    // Only process DMs, not channel messages (those come via app_mention)
    if (event["channel_type"] !== "im") {
      console.log(
        `[Slack]     message event skipped: channel_type=${JSON.stringify(
          event["channel_type"],
        )} (not 'im')`,
      );
      return;
    }
    // Ignore bot messages and message edits
    if (event["bot_id"] || event["subtype"]) {
      console.log(
        `[Slack]     message event skipped: bot_id=${event["bot_id"]}, ` +
          `subtype=${event["subtype"]}`,
      );
      return;
    }

    const user_id: string = event["user"] ?? "";
    if (user_id === this._bot_user_id) {
      console.log("[Slack]     message event skipped: message from self (bot)");
      return;
    }

    const text: string = (event["text"] ?? "").trim();
    const channel_id: string = event["channel"] ?? "";
    const thread_ts: string | null = event["thread_ts"] ?? null;
    const msg_ts: string = event["ts"];

    console.log(
      `[Slack]     DM from user=${user_id}, channel=${channel_id}, ` +
        `text=${JSON.stringify(text.slice(0, 80))}`,
    );
    await this._handle_user_message(text, channel_id, thread_ts, msg_ts);
  }

  /** Handle @bot mentions in channels. */
  async _handle_mention_event(event: Record<string, any>): Promise<void> {
    if (event["bot_id"] || event["subtype"]) {
      console.log(
        `[Slack]     mention event skipped: bot_id=${event["bot_id"]}, ` +
          `subtype=${event["subtype"]}`,
      );
      return;
    }

    const user_id: string = event["user"] ?? "";
    if (user_id === this._bot_user_id) {
      console.log("[Slack]     mention event skipped: mention from self (bot)");
      return;
    }

    // Strip the mention prefix (<@BOTID> ...) from the text
    let text: string = (event["text"] ?? "").trim();
    if (this._bot_user_id) {
      const mention_prefix = `<@${this._bot_user_id}>`;
      if (text.startsWith(mention_prefix)) {
        text = text.slice(mention_prefix.length).trim();
      }
    }

    const channel_id: string = event["channel"] ?? "";
    const thread_ts: string | null = event["thread_ts"] ?? null;
    const msg_ts: string = event["ts"];

    console.log(
      `[Slack]     Mention from user=${user_id}, channel=${channel_id}, ` +
        `text=${JSON.stringify(text.slice(0, 80))}`,
    );
    await this._handle_user_message(text, channel_id, thread_ts, msg_ts);
  }

  /** Handle app_home_opened event — send HELP_TEXT DM on first open. */
  async _handle_app_home_opened(event: Record<string, any>): Promise<void> {
    const user_id: string = event["user"] ?? "";
    if (!user_id || user_id === this._bot_user_id) {
      return;
    }
    // Only send on the first open (tab == "home", not "messages")
    const tab: string = event["tab"] ?? "";
    if (tab !== "home") {
      return;
    }
    console.log(
      `[Slack]     app_home_opened by user=${user_id}, sending HELP_TEXT via DM`,
    );
    const dm_ch = await this._open_dm_channel(user_id);
    if (dm_ch) {
      await this._reply(dm_ch, null, HELP_TEXT);
    } else {
      console.log(`[Slack]     Failed to open DM channel with user ${user_id}`);
    }
  }

  // ── unified message handler ───────────────────────────────────

  /** Handle any user message: commands, resume-by-reply, or create task. */
  async _handle_user_message(
    text: string,
    channel_id: string,
    thread_ts: string | null,
    msg_ts: string,
  ): Promise<void> {
    if (!text) {
      await this._reply(channel_id, msg_ts, HELP_TEXT);
      return;
    }

    // ── slash commands ────────────────────────────────────────
    if (text.startsWith("/")) {
      const ws = text.search(/\s/);
      const cmd = (ws === -1 ? text : text.slice(0, ws)).toLowerCase();
      const args = ws === -1 ? "" : text.slice(ws + 1).trim();

      if (cmd === "/status") {
        await this._cmd_status(args, channel_id, msg_ts);
      } else if (cmd === "/cancel") {
        await this._cmd_cancel(args, channel_id, msg_ts);
      } else if (cmd === "/resume") {
        await this._cmd_resume(args, channel_id, msg_ts);
      } else if (cmd === "/dir" || cmd === "/cd") {
        const reply = handle_dir_command(text, "slack", this.db);
        await this._reply(channel_id, msg_ts, reply ? reply : HELP_TEXT);
      } else if (cmd === "/agent") {
        const reply = handle_agent_command(text, "slack", this.db);
        await this._reply(channel_id, msg_ts, reply ? reply : HELP_TEXT);
      } else if (cmd === "/help") {
        await this._reply(channel_id, msg_ts, HELP_TEXT);
      } else {
        await this._reply(channel_id, msg_ts, HELP_TEXT);
      }
      return;
    }

    if (text.toLowerCase() === "help") {
      await this._reply(channel_id, msg_ts, HELP_TEXT);
      return;
    }

    // ── reply to a notification thread → resume task ──────────
    if (thread_ts) {
      // Look up task_id: first from notification_map, then from thread_ts_map
      let task_id = this._notification_map.get(thread_ts);
      if (!task_id) {
        task_id = this._thread_ts_map.get(thread_ts);
      }
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
          this._task_origin.set(task_id, [channel_id, thread_ts, msg_ts]);
          this._add_reaction(channel_id, msg_ts, "eyes");
          await this._reply(channel_id, thread_ts, ":arrow_forward:");
          console.log(
            `[Slack] Auto-resuming task ${task_id} from thread reply`,
          );
          return;
        } else {
          await this._reply(
            channel_id,
            thread_ts,
            `:x: Task *#${task_id}* has no saved session to resume.`,
          );
          return;
        }
      }
    }

    // ── default: create a new task from message text ──────────
    await this._create_task(text, channel_id, msg_ts);
  }

  // ── task creation ─────────────────────────────────────────────

  /** Create a new task from any message. */
  async _create_task(
    text: string,
    channel_id: string,
    thread_ts: string,
  ): Promise<void> {
    const title = text.slice(0, 60) + (text.length > 60 ? "…" : "");

    const task = makeTask({
      title: `[Slack] ${title}`,
      prompt: text,
      working_dir: await resolve_working_dir(text, "slack", this.db),
      schedule_type: ScheduleType.IMMEDIATE,
      tags: "slack",
      agent: resolve_agent("slack", this.db),
    });
    const task_id = this.scheduler.submit_task(task);
    console.log(`[Slack] Task #${task_id} created from message`);

    this._task_origin.set(task_id, [channel_id, thread_ts, thread_ts]);
    console.log(
      `[Slack] Origin set for task #${task_id}: channel=${channel_id}, ` +
        `thread_ts=${thread_ts}`,
    );

    // Track thread root ts → task_id so replies in the thread can resume
    this._thread_ts_map.set(thread_ts, task_id);

    // Acknowledge with an eyes reaction and a brief running hint
    this._add_reaction(channel_id, thread_ts, "eyes");
    await this._reply(channel_id, thread_ts, `Task #${task_id} is running…`);
  }

  // ── commands ──────────────────────────────────────────────────

  async _cmd_status(
    args: string,
    channel_id: string,
    thread_ts: string,
  ): Promise<void> {
    const task_id = SlackChannel._parse_task_id(args);
    if (task_id === null) {
      await this._reply(
        channel_id,
        thread_ts,
        ":warning: Usage: `/status <task_id>`",
      );
      return;
    }

    const task = this.db.get_task(task_id);
    if (!task) {
      await this._reply(
        channel_id,
        thread_ts,
        `:x: Task #${task_id} not found.`,
      );
      return;
    }

    const status_emoji: Record<string, string> = {
      pending: ":hourglass:",
      scheduled: ":calendar:",
      running: ":runner:",
      completed: ":white_check_mark:",
      failed: ":x:",
      cancelled: ":no_entry_sign:",
    };
    const emoji = status_emoji[task["status"] as string] ?? ":grey_question:";
    const lines = [
      `${emoji} *Task #${task["id"]}* — *${task["title"]}*`,
      `Status: \`${task["status"]}\``,
      `Created: ${task["created_at"] ?? "—"}`,
      `Last run: ${task["last_run_at"] || "—"}`,
    ];
    if (task["error"]) {
      lines.push(`Error: \`${(task["error"] as string).slice(0, 300)}\``);
    }
    if (task["result"]) {
      lines.push(`Result: ${(task["result"] as string).slice(0, 500)}`);
    }

    await this._reply(channel_id, thread_ts, lines.join("\n"));
  }

  async _cmd_cancel(
    args: string,
    channel_id: string,
    thread_ts: string,
  ): Promise<void> {
    const task_id = SlackChannel._parse_task_id(args);
    if (task_id === null) {
      await this._reply(
        channel_id,
        thread_ts,
        ":warning: Usage: `/cancel <task_id>`",
      );
      return;
    }

    const task = this.db.get_task(task_id);
    if (!task) {
      await this._reply(
        channel_id,
        thread_ts,
        `:x: Task #${task_id} not found.`,
      );
      return;
    }

    const status = task["status"] as string;
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      await this._reply(
        channel_id,
        thread_ts,
        `:information_source: Task #${task_id} is already \`${status}\`.`,
      );
      return;
    }

    this.db.update_task(task_id, { status: "cancelled" });
    await this._reply(
      channel_id,
      thread_ts,
      `:no_entry_sign: Task #${task_id} cancelled.`,
    );
  }

  async _cmd_resume(
    args: string,
    channel_id: string,
    thread_ts: string,
  ): Promise<void> {
    // ≙ Python args.strip().split(" ", 1)
    const stripped = args.trim();
    const sp = stripped.indexOf(" ");
    const head = sp === -1 ? stripped : stripped.slice(0, sp);
    const tail = sp === -1 ? null : stripped.slice(sp + 1);

    if (!/^[+-]?\d+$/.test(head.replace(/^#+/, ""))) {
      await this._reply(
        channel_id,
        thread_ts,
        ":warning: Usage: `/resume <task_id> <message>`",
      );
      return;
    }

    const tid = parseInt(head.replace(/^#+/, ""), 10);
    const resume_msg = tail !== null ? tail.trim() : "";
    if (!resume_msg) {
      await this._reply(
        channel_id,
        thread_ts,
        ":warning: Please provide a message to resume with.",
      );
      return;
    }

    const task = this.db.get_task(tid);
    if (!task || !task["session_id"]) {
      await this._reply(
        channel_id,
        thread_ts,
        `:x: Task #${tid} not found or has no saved session.`,
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
    this._task_origin.set(tid, [channel_id, thread_ts, thread_ts]);
    this._add_reaction(channel_id, thread_ts, "eyes");
    await this._reply(channel_id, thread_ts, ":arrow_forward:");
  }

  // ── Channel ABC: send outbound message ───────────────────────

  /** Forward task completion/failure to the originating Slack thread. */
  send(msg: OutboundMessage): void {
    // Python's send() is synchronous (its network calls run on threads); the
    // TS port keeps a synchronous signature and runs the async body
    // fire-and-forget.
    void this._send(msg).catch((e) => {
      console.log(`[Slack] send() error: ${e}`);
    });
  }

  private async _send(msg: OutboundMessage): Promise<void> {
    if (
      msg.type !== OutboundMessageType.TASK_COMPLETED &&
      msg.type !== OutboundMessageType.TASK_FAILED
    ) {
      return;
    }

    const task_id = msg.task_id;
    const origin = this._task_origin.get(task_id);
    console.log(
      `[Slack] send() task_id=${task_id} (type=${typeof task_id}), ` +
        `origin=${JSON.stringify(origin ?? null)}, ` +
        `keys=${JSON.stringify([...this._task_origin.keys()])}`,
    );

    // Build notification text
    let title: string;
    let text: string;
    if (msg.type === OutboundMessageType.TASK_COMPLETED) {
      const result_text = ((msg.payload["result"] as string | null) || "")
        .trim()
        .slice(0, 10000);
      title = (msg.payload["title"] as string | null) || `Task #${task_id}`;
      text = result_text || "Done.";
    } else {
      const error_text = (
        (msg.payload["error"] as string | null) || "Unknown error"
      )
        .trim()
        .slice(0, 800);
      title = (msg.payload["title"] as string | null) || `Task #${task_id}`;
      text = error_text;
    }

    let channel_id: string;
    let thread_ts: string | null;
    if (origin) {
      const [origin_channel, origin_thread, reaction_ts] = origin;
      channel_id = origin_channel;
      thread_ts = origin_thread;
      // Add emoji reaction to the message that triggered the task (or resume)
      const react_target = (reaction_ts || thread_ts) as string;
      if (msg.type === OutboundMessageType.TASK_COMPLETED) {
        this._add_reaction(channel_id, react_target, "white_check_mark");
      } else {
        this._add_reaction(channel_id, react_target, "x");
      }
    } else {
      // Fallback: P2P DM to configured user, or default channel
      const dm_user = this.db.get_setting("slack_default_user");
      const default_channel = this.db.get_setting("slack_default_channel");
      if (dm_user) {
        const dm_ch = await this._open_dm_channel(dm_user);
        if (dm_ch) {
          channel_id = dm_ch;
          thread_ts = null;
          const status_emoji =
            msg.type === OutboundMessageType.TASK_COMPLETED
              ? ":white_check_mark:"
              : ":x:";
          text = `${status_emoji} *${title}*\n${text}`;
          console.log(`[Slack] Falling back to P2P DM with user ${dm_user}`);
        } else {
          console.log(
            `[Slack] Failed to open DM with user ${dm_user}, skipping`,
          );
          return;
        }
      } else if (default_channel) {
        channel_id = default_channel;
        thread_ts = null;
        const status_emoji =
          msg.type === OutboundMessageType.TASK_COMPLETED
            ? ":white_check_mark:"
            : ":x:";
        text = `${status_emoji} *${title}*\n${text}`;
      } else {
        console.log(
          `[Slack] No origin, no known user, no slack_default_channel for ` +
            `task #${task_id}, skipping`,
        );
        return;
      }
    }

    console.log(
      `[Slack] Sending outbound notification for task #${task_id}: ${msg.type}`,
    );

    // ≙ Python's _send_and_track daemon thread
    const send_channel = channel_id;
    const send_thread = thread_ts;
    const send_text = text;
    void (async () => {
      const sent_ts = await this._reply_return_ts(
        send_channel,
        send_thread,
        send_text,
      );
      if (sent_ts) {
        this._notification_map.set(sent_ts, task_id);
        console.log(
          `[Slack] Notification ts=${sent_ts} mapped to task #${task_id}`,
        );
      }
    })();

    // Free origin memory after terminal state
    this._task_origin.delete(task_id);
  }

  /** MessageBus outbound subscriber callback (stable bound reference). */
  _on_outbound = (msg: OutboundMessage): void => {
    this.send(msg);
  };

  // ── helpers ──────────────────────────────────────────────────

  /** Open (or retrieve cached) DM channel with a user. */
  async _open_dm_channel(user_id: string): Promise<string | null> {
    const cached = this._dm_channel_cache.get(user_id);
    if (cached !== undefined) {
      return cached;
    }
    if (!this._web_client) {
      return null;
    }
    try {
      const resp = await this._web_client.conversations_open({
        users: user_id,
      });
      const ch_id: string = resp["channel"]["id"];
      this._dm_channel_cache.set(user_id, ch_id);
      console.log(`[Slack] Opened DM channel ${ch_id} with user ${user_id}`);
      return ch_id;
    } catch (e) {
      console.log(
        `[Slack] conversations.open failed for user ${user_id}: ${e}`,
      );
      return null;
    }
  }

  /** Add an emoji reaction to a message (non-blocking). */
  _add_reaction(channel_id: string, timestamp: string, emoji: string): void {
    const web_client = this._web_client;
    if (!web_client) {
      return;
    }

    // ≙ Python daemon thread running _do()
    void (async () => {
      try {
        await web_client.reactions_add({
          channel: channel_id,
          timestamp,
          name: emoji,
        });
      } catch (e) {
        if (String(e).includes("already_reacted")) {
          // Reaction already exists, ignore
        } else {
          console.log(`[Slack] Failed to add reaction ${emoji}: ${e}`);
        }
      }
    })();
  }

  async _reply(
    channel_id: string,
    thread_ts: string | null,
    text: string,
  ): Promise<void> {
    if (!this._web_client) {
      console.log("[Slack] _reply skipped: no web_client");
      return;
    }
    try {
      console.log(
        `[Slack] >>> Sending message to channel=${channel_id}, ` +
          `thread=${thread_ts}, len=${text.length}`,
      );
      await this._web_client.chat_postMessage({
        channel: channel_id,
        thread_ts,
        text,
        mrkdwn: true,
      });
      console.log("[Slack] >>> Message sent OK");
    } catch (e) {
      console.log(`[Slack] >>> chat_postMessage FAILED: ${e}`);
      console.error((e as Error)?.stack ?? e);
    }
  }

  /** Send a message and return its ts (for tracking notification threads). */
  async _reply_return_ts(
    channel_id: string,
    thread_ts: string | null,
    text: string,
  ): Promise<string | null> {
    if (!this._web_client) {
      return null;
    }
    try {
      const resp = await this._web_client.chat_postMessage({
        channel: channel_id,
        thread_ts,
        text,
        mrkdwn: true,
      });
      return resp?.["ts"] ?? null;
    } catch (e) {
      console.log(`[Slack] >>> chat_postMessage FAILED: ${e}`);
      console.error((e as Error)?.stack ?? e);
      return null;
    }
  }

  static _parse_task_id(s: string): number | null {
    const stripped = s.trim().replace(/^#+/, "");
    if (!/^[+-]?\d+$/.test(stripped)) {
      return null;
    }
    return parseInt(stripped, 10);
  }
}
