/**
 * Feishu/Lark channel for AgentForge.
 *
 * The implementation keeps the Python channel's public method names and JSON
 * shapes, but uses Bun/TypeScript primitives and the official
 * @larksuiteoapi/node-sdk at runtime. SDK calls are deliberately structural so
 * tests can inject small fake clients without depending on SDK internals.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  Channel,
  InboundMessageType,
  MessageBus,
  OutboundMessageType,
  type InboundMessage,
  type OutboundMessage,
  type TaskDBLike,
} from "../bus.ts";
import {
  makeTask,
  ScheduleType,
  type PromptImage,
  type Task,
} from "../types.ts";
import {
  handle_agent_command,
  resolve_agent,
  type SettingsDB,
} from "./agent_utils.ts";
import {
  build_brief_payload,
  build_runbook_payload,
  format_brief_created_reply,
  format_brief_discarded_reply,
  format_brief_help,
  format_brief_started_reply,
  format_runbook_brief_reply,
  format_runbook_created_reply,
  format_skill_suggestion_action_reply,
  format_skill_suggestion_help,
  parse_brief_command,
  parse_runbook_fallback,
  parse_skill_suggestion_command,
  type BriefCommand,
  type ParsedRunbookCommand,
  type SkillSuggestionCommand,
} from "./brief_utils.ts";
import { handle_dir_command, resolve_working_dir } from "./dir_utils.ts";

type Row = Record<string, any>;

export const HELP_TEXT = `**AgentForge Bot** 👋
发送任意消息即可创建任务。回复任务完成/失败通知即可继续对话。

**命令列表：**
• \`/status <id>\` — 查看任务详情
• \`/cancel <id>\` — 取消任务
• \`/resume <id> <message>\` — 继续执行任务
• \`/dir <path>\` — 设置默认工作目录
　　例如：\`/dir ~/workspace/myproject\`
• \`/agent <name>\` — 切换 coding agent（\`claude\` / \`codex\`）
• \`/ccu\` — 查看 Claude Code 当前用量（ccu-blocks）
• \`/help\` — 显示此帮助

**自定义命令：**
• 先在 AgentForge 里创建自定义命令，或从已用过的任务生成命令。
• 然后在聊天里输入：\`/看报错 TypeError: Cannot read properties of undefined\`
• 命令可以是中文，也可以配置 alias，例如：\`/err ...\`
• 如果命令需要确认，Bot 会返回 Draft task。
　用 \`/run-draft <id>\` 开始执行，用 \`/cancel-draft <id>\` 取消。

**小技巧：**
• 消息中直接提到路径，Bot 会自动识别并使用。
　例如：_在 ~/myapp 里帮我修复登录 bug_
• 回复任意结果通知即可继续对话。
`;

export const FEISHU_CARD_MARKDOWN_CHUNK = 7000;
export const FEISHU_FALLBACK_MARKDOWN_LIMIT = 8000;
export const FEISHU_CARD_MAX_ELEMENTS = 200;
export const FEISHU_PANEL_MAX_LINE_ELEMENTS = 80;
export const FEISHU_PANEL_PLAIN_TEXT_CHUNK = 1800;
export const FEISHU_THINKING_PREFIX = "[thinking] ";
export const FEISHU_UPLOADABLE_IMAGE_SUFFIXES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);
export const FEISHU_STREAM_EVENT_TYPES = new Set([
  "assistant",
  "tool_call",
  "tool_result",
  "command_execution",
  "file_change",
  "web_search",
  "error",
]);

const FEISHU_MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)\n]+)\)/g;

export let FEISHU_AVAILABLE = true;

export function _set_feishu_available(value: boolean): void {
  FEISHU_AVAILABLE = value;
}

export const _hooks = {
  import_lark: async (): Promise<any> =>
    await import("@larksuiteoapi/node-sdk"),
};

export interface FeishuTaskDB extends TaskDBLike, SettingsDB {
  update_task(task_id: number, updates: Record<string, unknown>): void;
  get_task_runs(task_id: number, limit?: number): Row[];
  get_run_output_events(run_id: number, limit?: number): Row[];
  get_task_by_feishu_root_msg(root_msg_id: string): Row | null;
}

export interface FeishuScheduler {
  submit_task(task: Task): number;
  handle_inbound_message?(msg: InboundMessage): Record<string, unknown>;
  add_output_listener(cb: OutputListener): void;
  remove_output_listener(cb: OutputListener): void;
}

export type OutputListener = (
  task_id: number,
  run_id: number,
  event_type: string,
  content: string,
) => void;

function isPlainObject(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyCard(card: Row): string {
  return JSON.stringify(card);
}

function responseSuccess(response: any): boolean {
  if (!response) return false;
  if (typeof response.success === "function")
    return Boolean(response.success());
  if (typeof response.code === "number") return response.code === 0;
  return Boolean(response.success);
}

function responseMessageId(response: any): string | null {
  return (
    response?.data?.message_id ??
    response?.data?.messageId ??
    response?.message_id ??
    response?.messageId ??
    null
  );
}

function responseImageKey(response: any): string | null {
  return (
    response?.data?.image_key ??
    response?.data?.imageKey ??
    response?.image_key ??
    null
  );
}

function callMaybeAsync<T>(value: T | Promise<T>): Promise<T> {
  return Promise.resolve(value);
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function getSenderOpenId(sender: Row): string {
  const senderId = sender["sender_id"];
  if (typeof senderId === "string") return senderId;
  return senderId?.["open_id"] ?? senderId?.["openId"] ?? "unknown";
}

function localImageMediaType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function expandUser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function fileUrlPath(target: string): string {
  try {
    return new URL(target).pathname;
  } catch {
    const rest = target.slice("file://".length);
    const slash = rest.indexOf("/");
    return slash >= 0 ? rest.slice(slash) : "";
  }
}

function decodePath(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function extractEvent(data: any): Row {
  return data?.event ?? data?.data?.event ?? data ?? {};
}

function extractMessage(data: any): Row {
  return extractEvent(data)["message"] ?? {};
}

function extractSender(data: any): Row {
  return extractEvent(data)["sender"] ?? {};
}

function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export class _FeishuStreamWriter {
  static readonly MIN_INTERVAL = 0.25;

  task_id: number;
  msg_id: string;
  _channel: FeishuChannel;
  _task_title: string;
  _run_id: number | null = null;
  _parts: string[] = [];
  _last_patch = 0;
  _timer: ReturnType<typeof setTimeout> | null = null;
  _stopped = false;
  _patch_in_flight = false;
  _dirty = false;

  constructor(
    task_id: number,
    msg_id: string,
    channel: FeishuChannel,
    task_title: string,
  ) {
    this.task_id = task_id;
    this.msg_id = msg_id;
    this._channel = channel;
    this._task_title = task_title;
  }

  on_event(
    task_id: number,
    run_id: number,
    event_type: string,
    content: string,
  ): void {
    if (this._stopped || task_id !== this.task_id) return;
    if (!FEISHU_STREAM_EVENT_TYPES.has(event_type) || content === "") return;
    let display_content = this._display_content(event_type, content);
    if (!display_content) return;
    if (this._run_id === null) {
      this._run_id = run_id;
    } else if (this._run_id !== run_id) {
      this._run_id = run_id;
      this._parts = [];
    }
    if (
      event_type !== "assistant" &&
      this._parts.length &&
      !this._parts.at(-1)!.endsWith("\n")
    ) {
      display_content = "\n" + display_content;
    }
    this._parts.push(display_content);
    this._schedule();
  }

  _display_content(event_type: string, content: string): string {
    if (event_type !== "assistant")
      return this._format_trace_event(event_type, content);
    return content.startsWith(FEISHU_THINKING_PREFIX)
      ? content.slice(FEISHU_THINKING_PREFIX.length)
      : content;
  }

  _load_trace_payload(content: string): Row {
    try {
      const payload = JSON.parse(content);
      return isPlainObject(payload) ? payload : { content: payload };
    } catch {
      return { content };
    }
  }

  _format_trace_value(value: unknown): string {
    return this._compact_trace_summary(value);
  }

  _compact_trace_summary(value: unknown, limit = 140): string {
    if (
      value === null ||
      value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0) ||
      (isPlainObject(value) && Object.keys(value).length === 0)
    ) {
      return "";
    }
    if (isPlainObject(value)) {
      for (const key of [
        "command",
        "query",
        "path",
        "file",
        "message",
        "content",
        "text",
      ]) {
        if (value[key]) return this._compact_trace_summary(value[key], limit);
      }
      const safe_parts: string[] = [];
      for (const [key, item] of Object.entries(value)) {
        if (item === null || item === undefined || item === "") continue;
        if (
          ["token", "secret", "password", "key"].some((s) =>
            key.toLowerCase().includes(s),
          )
        ) {
          continue;
        }
        safe_parts.push(`${key}=${this._compact_trace_summary(item, 48)}`);
        if (safe_parts.length >= 2) break;
      }
      return this._truncate_trace_text(safe_parts.join(", "), limit);
    }
    if (Array.isArray(value)) {
      const first = this._compact_trace_summary(
        value[0],
        Math.max(24, limit - 20),
      );
      const suffix = value.length > 1 ? ` 等 ${value.length} 项` : "";
      return this._truncate_trace_text(`${first}${suffix}`, limit);
    }
    return this._truncate_trace_text(String(value), limit);
  }

  _truncate_trace_text(value: string, limit = 140): string {
    const lines = String(value)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const normalized = (lines[0] ?? "").split(/\s+/).join(" ");
    return normalized.length <= limit
      ? normalized
      : normalized.slice(0, limit - 1).trimEnd() + "…";
  }

  _trace_line(icon: string, label: string, ...parts: unknown[]): string {
    const compact_parts = parts.map((part) =>
      typeof part === "string"
        ? this._truncate_trace_text(part)
        : this._compact_trace_summary(part),
    );
    const suffix = compact_parts.filter(Boolean).join(" · ");
    return `${icon} ${label}${suffix ? " " + suffix : ""}`;
  }

  _format_trace_event(event_type: string, content: string): string {
    const payload = this._load_trace_payload(content);
    let line = "";
    if (event_type === "tool_call") {
      let name = payload["name"] || payload["tool"] || "unknown";
      if (payload["server"]) name = `${payload["server"]}.${name}`;
      line = this._trace_line(
        "▣",
        "调用工具",
        name,
        payload["input"] || payload["arguments"],
        payload["result"],
        payload["status"],
        payload["error"]
          ? `错误 ${this._format_trace_value(payload["error"])}`
          : "",
      );
    } else if (event_type === "tool_result") {
      line = this._trace_line(
        "↵",
        payload["is_error"] ? "工具错误" : "工具返回",
        payload["tool_use_id"],
        payload["content"],
      );
    } else if (event_type === "command_execution") {
      line = this._trace_line(
        "$",
        "执行命令",
        payload["command"] || payload["content"] || "",
        payload["output"],
        payload["exit_code"] !== undefined && payload["exit_code"] !== null
          ? `退出码 ${payload["exit_code"]}`
          : "",
        payload["status"],
      );
    } else if (event_type === "file_change") {
      let summary = "";
      const changes = payload["changes"];
      if (Array.isArray(changes)) {
        const summaries = changes
          .filter(isPlainObject)
          .map((change) =>
            `${change["kind"] || change["type"] || "changed"}: ${change["path"] || change["file"] || ""}`.trim(),
          );
        summary = summaries.slice(0, 3).join("；");
        if (summaries.length > 3) summary += ` 等 ${summaries.length} 项`;
      } else if (changes) {
        summary = this._format_trace_value(changes);
      }
      line = this._trace_line("◇", "文件变更", summary, payload["status"]);
    } else if (event_type === "web_search") {
      line = this._trace_line(
        "⌕",
        "网页搜索",
        payload["query"] || payload["content"] || "",
        payload["status"],
      );
    } else if (event_type === "error") {
      line = this._trace_line(
        "!",
        "错误",
        payload["message"] || payload["content"] || content,
      );
    } else {
      line = this._trace_line("•", `[${event_type}]`, content);
    }
    return line ? `${line}\n` : "";
  }

  _schedule(): void {
    if (this._stopped) return;
    this._dirty = true;
    this._schedule_dirty_locked();
  }

  _schedule_dirty_locked(): void {
    if (this._stopped || !this._dirty || this._patch_in_flight || this._timer)
      return;
    const delay = Math.max(
      0,
      _FeishuStreamWriter.MIN_INTERVAL - (Date.now() / 1000 - this._last_patch),
    );
    if (delay <= 0) {
      this._start_patch_locked();
      return;
    }
    this._timer = setTimeout(() => this._timer_fired(), delay * 1000);
  }

  _start_patch_locked(): void {
    this._patch_in_flight = true;
    this._dirty = false;
    void this._do_patch();
  }

  _timer_fired(): void {
    this._timer = null;
    this._schedule_dirty_locked();
  }

  async _do_patch(): Promise<void> {
    const text = this._parts.join("");
    const card = this._channel._build_streaming_card(
      this.task_id,
      this._task_title,
      text,
    );
    try {
      await this._channel._patch_message(this.msg_id, card);
    } finally {
      this._last_patch = Date.now() / 1000;
      this._patch_in_flight = false;
      this._schedule_dirty_locked();
    }
  }

  snapshot_text(): string {
    return this._parts.join("");
  }

  stop(): void {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

export class FeishuChannel extends Channel {
  declare db: FeishuTaskDB;
  scheduler: FeishuScheduler;
  _client: any = null;
  _ws_client: any = null;
  _ws_promise: Promise<void> | null = null;
  _event_dispatcher: any = null;
  _lark: any = null;

  _task_origin: Map<number, [string, string, string]> = new Map();
  _notification_map: Map<string, number> = new Map();
  _root_msg_map: Map<string, number> = new Map();
  _writers: Map<number, _FeishuStreamWriter> = new Map();
  _writer_listeners: Map<number, OutputListener> = new Map();
  _streaming_msg: Map<number, string> = new Map();

  constructor(bus: MessageBus, db: FeishuTaskDB, scheduler: FeishuScheduler) {
    super("feishu", bus, db);
    this.scheduler = scheduler;
    bus.subscribe_outbound(this._on_outbound);
  }

  start(): void {
    void this._start().catch((e) => {
      console.log(`[Feishu] ERROR during initialization: ${e}`);
    });
  }

  async _start(): Promise<void> {
    if (!FEISHU_AVAILABLE) {
      console.log(
        "[Feishu] @larksuiteoapi/node-sdk not installed. Run: bun add @larksuiteoapi/node-sdk",
      );
      return;
    }
    const appId = this.db.get_setting("feishu_app_id") || "";
    const appSecret = this.db.get_setting("feishu_app_secret") || "";
    if (!appId || !appSecret) {
      console.log(
        "[Feishu] Not configured - set feishu_app_id / feishu_app_secret in settings",
      );
      return;
    }
    try {
      const lark = await _hooks.import_lark();
      this._lark = lark;
      this._client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType?.SelfBuild,
        domain: lark.Domain?.Feishu,
      });
      const wsCtor = lark.WSClient ?? lark.ws?.Client;
      if (wsCtor) {
        const eventDispatcher = this._build_event_dispatcher(lark);
        this._ws_client = new wsCtor({
          appId,
          appSecret,
        });
        this._event_dispatcher = eventDispatcher;
      }
      this._running = true;
      if (this._ws_client) {
        this._ws_promise = this._run_ws(this._event_dispatcher);
      }
      console.log("[Feishu] Initialization complete");
    } catch (e) {
      console.log(`[Feishu] ERROR during initialization: ${e}`);
      this._client = null;
      this._ws_client = null;
      this._event_dispatcher = null;
    }
  }

  _build_event_dispatcher(lark: any): any {
    const handlers: Row = {
      "im.message.receive_v1": (data: any) => this._on_message_sync(data),
      "im.chat.member.bot.added_v1": (data: any) => this._on_bot_added(data),
      "im.message.reaction.created_v1": (data: any) => this._on_reaction(data),
      "im.message.reaction.deleted_v1": (data: any) => this._on_reaction(data),
      "im.message.message_read_v1": () => undefined,
      "im.message.recalled_v1": () => undefined,
    };
    if (typeof lark.EventDispatcher === "function") {
      return new lark.EventDispatcher({}).register(handlers);
    }
    return { register: handlers };
  }

  stop(): void {
    console.log("[Feishu] Stopping WebSocket bot...");
    this._running = false;
    this.bus.unsubscribe_outbound(this._on_outbound);
    for (const [task_id, writer] of this._writers) {
      const listener = this._writer_listeners.get(task_id);
      if (listener) this.scheduler.remove_output_listener(listener);
      writer.stop();
    }
    this._writers.clear();
    this._writer_listeners.clear();
    this._streaming_msg.clear();
    try {
      if (typeof this._ws_client?.stop === "function") this._ws_client.stop();
      else if (typeof this._ws_client?.disconnect === "function")
        void this._ws_client.disconnect();
      else if (typeof this._ws_client?.close === "function")
        this._ws_client.close({ force: true });
    } catch (e) {
      console.log(`[Feishu] Error stopping ws_client: ${e}`);
    }
    this._client = null;
    this._ws_client = null;
    this._ws_promise = null;
    this._event_dispatcher = null;
  }

  async _run_ws(eventDispatcher: any = null): Promise<void> {
    try {
      if (!this._running || !this._ws_client) return;
      if (typeof this._ws_client.start === "function") {
        await this._ws_client.start({ eventDispatcher });
        return;
      } else if (typeof this._ws_client.connect === "function") {
        await this._ws_client.connect();
      }
    } catch (e) {
      if (this._running) console.log(`[Feishu] WebSocket error: ${e}`);
      this._running = false;
    }
  }

  send(msg: OutboundMessage): void {
    void this._send(msg).catch((e) => console.log(`[Feishu] send error: ${e}`));
  }

  async _send(msg: OutboundMessage): Promise<void> {
    if (
      msg.type !== OutboundMessageType.TASK_COMPLETED &&
      msg.type !== OutboundMessageType.TASK_FAILED
    )
      return;
    if (!this._should_handle_outbound(msg)) return;
    const task_id = msg.task_id;
    if (!this._client) {
      console.log(
        `[Feishu] Client not initialized, skipping notification for task ${task_id}`,
      );
      return;
    }
    const task = this.db.get_task(task_id) as Row | null;
    if (!task) {
      console.log(`[Feishu] Task ${task_id} not found in database`);
      return;
    }

    const is_completed = msg.type === OutboundMessageType.TASK_COMPLETED;
    let content: string;
    if (is_completed) {
      const result_text = asString(
        msg.payload["result"] ?? task["result"],
      ).trim();
      content = result_text || "Done.";
    } else {
      content = asString(
        msg.payload["error"] ?? task["error"] ?? "Unknown error",
      )
        .trim()
        .slice(0, 800);
    }

    const origin = this._task_origin.get(task_id);
    const streaming_msg_id = this._streaming_msg.get(task_id) ?? null;
    this._streaming_msg.delete(task_id);
    const streaming_history = this._stop_streaming(task_id);

    let image_keys: string[] = [];
    if (is_completed) {
      const image_paths = this._collect_generated_image_paths(
        task_id,
        content,
        task,
      );
      const uploaded_images = await this._upload_image_entries(image_paths);
      image_keys = uploaded_images.map(([, image_key]) => image_key);
      if (image_keys.length) {
        content = this._hide_generated_image_paths(
          content,
          image_keys.length,
          uploaded_images.map(([image_path]) => image_path),
        );
      }
    }

    const card = this._build_notification_card({
      task_id,
      task,
      is_completed,
      body_text: content,
      streaming_history,
      image_keys,
    });

    let sent_id: string | null = null;
    if (origin) {
      const [, root_msg_id, reaction_msg_id] = origin;
      this._add_reaction(reaction_msg_id, is_completed ? "DONE" : "Cry");
      if (
        streaming_msg_id &&
        (await this._patch_message(streaming_msg_id, card))
      ) {
        sent_id = streaming_msg_id;
      }
      if (!sent_id) {
        sent_id = await this._reply_message(root_msg_id, content, card);
      }
    }

    if (!sent_id) {
      const chat_id = this.db.get_setting("feishu_default_chat_id");
      if (chat_id) {
        sent_id = await this._send_message(
          chat_id,
          content,
          card,
          this._truncate_text(content, FEISHU_FALLBACK_MARKDOWN_LIMIT),
        );
      }
    }

    if (sent_id) {
      this._notification_map.set(sent_id, task_id);
      console.log(
        `[Feishu] Notification message_id=${sent_id} mapped to task #${task_id}`,
      );
    } else {
      console.log(`[Feishu] Failed to send notification for task ${task_id}`);
    }
    this._task_origin.delete(task_id);
  }

  _on_outbound = (msg: OutboundMessage): void => {
    this.send(msg);
  };

  _generated_image_paths_for_task(task_id: number): string[] {
    let runs: Row[];
    try {
      runs = this.db.get_task_runs(task_id, 1);
    } catch (e) {
      console.log(`[Feishu] Failed to load runs for generated images: ${e}`);
      return [];
    }
    if (!Array.isArray(runs) || !runs.length) return [];
    const run_id = runs[0]?.["id"];
    if (!run_id) return [];
    let events: Row[];
    try {
      events = this.db.get_run_output_events(run_id, 1000);
    } catch (e) {
      console.log(
        `[Feishu] Failed to load output events for generated images: ${e}`,
      );
      return [];
    }
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (!isPlainObject(event) || event["event_type"] !== "generated_image")
        continue;
      try {
        const payload = JSON.parse(event["content"] || "{}");
        const imagePath = payload?.path;
        if (
          imagePath &&
          !seen.has(imagePath) &&
          fs.existsSync(imagePath) &&
          fs.statSync(imagePath).isFile()
        ) {
          seen.add(imagePath);
          paths.push(imagePath);
        }
      } catch {
        // Ignore malformed generated-image event payloads.
      }
    }
    return paths;
  }

  _collect_generated_image_paths(
    task_id: number,
    content: string,
    task: Row | null = null,
  ): string[] {
    const paths = this._generated_image_paths_for_task(task_id);
    paths.push(
      ...this._generated_image_paths_from_markdown(
        content,
        task?.["working_dir"],
      ),
    );
    return this._dedupe_image_paths(paths);
  }

  _generated_image_paths_from_markdown(
    content: string,
    working_dir: string | null = null,
  ): string[] {
    const paths: string[] = [];
    FEISHU_MARKDOWN_IMAGE_RE.lastIndex = 0;
    for (const match of content.matchAll(FEISHU_MARKDOWN_IMAGE_RE)) {
      const imagePath = this._local_image_path_from_reference(
        match[1] ?? "",
        working_dir,
      );
      if (imagePath) paths.push(imagePath);
    }
    return paths;
  }

  _local_image_path_from_reference(
    reference: string,
    working_dir: string | null = null,
  ): string | null {
    let target = this._markdown_image_reference_target(reference);
    if (
      !target ||
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("data:")
    ) {
      return null;
    }
    if (target.startsWith("file://")) target = fileUrlPath(target);
    else if (target.startsWith("sandbox:"))
      target = target.slice("sandbox:".length);
    target = decodePath(target).trim();
    if (!target) return null;
    let imagePath = expandUser(target);
    if (!path.isAbsolute(imagePath) && working_dir)
      imagePath = path.join(expandUser(working_dir), imagePath);
    if (
      !FEISHU_UPLOADABLE_IMAGE_SUFFIXES.has(
        path.extname(imagePath).toLowerCase(),
      )
    )
      return null;
    try {
      if (!fs.statSync(imagePath).isFile()) return null;
      return fs.realpathSync(imagePath);
    } catch {
      return null;
    }
  }

  _markdown_image_reference_target(reference: string): string {
    const raw = (reference || "").trim();
    if (!raw) return "";
    if (raw.startsWith("<")) {
      const end = raw.indexOf(">");
      if (end >= 0) return raw.slice(1, end).trim();
    }
    if (raw[0] === "'" || raw[0] === '"') {
      const end = raw.indexOf(raw[0], 1);
      if (end > 0) return raw.slice(1, end).trim();
    }
    const titled = raw.match(/(.+?)\s+['"][^'"]*['"]\s*$/);
    return (titled ? titled[1]! : raw).trim();
  }

  _dedupe_image_paths(image_paths: string[]): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const imagePath of image_paths) {
      const canonical = this._canonical_image_path(imagePath);
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      deduped.push(canonical);
    }
    return deduped;
  }

  _canonical_image_path(imagePath: string | null): string | null {
    if (!imagePath) return null;
    try {
      const expanded = expandUser(imagePath);
      if (!fs.statSync(expanded).isFile()) return null;
      return fs.realpathSync(expanded);
    } catch {
      return null;
    }
  }

  async _upload_images(image_paths: string[]): Promise<string[]> {
    return (await this._upload_image_entries(image_paths)).map(
      ([, image_key]) => image_key,
    );
  }

  async _upload_image_entries(
    image_paths: string[],
  ): Promise<Array<[string, string]>> {
    const entries: Array<[string, string]> = [];
    for (const imagePath of image_paths) {
      const imageKey = await this._upload_image(imagePath);
      if (imageKey) entries.push([imagePath, imageKey]);
    }
    return entries;
  }

  async _upload_image(imagePath: string): Promise<string | null> {
    if (!this._client) return null;
    try {
      const image = fs.readFileSync(imagePath);
      let response: any;
      if (this._client.im?.v1?.image?.create) {
        response = await callMaybeAsync(
          this._client.im.v1.image.create({
            request_body: { image_type: "message", image },
            data: { image_type: "message", image },
          }),
        );
      } else {
        response = await callMaybeAsync(
          this._client.im.image.create({
            data: { image_type: "message", image },
          }),
        );
      }
      if (responseSuccess(response)) return responseImageKey(response);
      console.log(
        `[Feishu] Image upload failed: ${response?.code} ${response?.msg}`,
      );
      return null;
    } catch (e) {
      console.log(
        `[Feishu] Failed to upload generated image ${imagePath}: ${e}`,
      );
      return null;
    }
  }

  _hide_generated_image_paths(
    content: string,
    image_count: number,
    uploaded_paths: string[] = [],
  ): string {
    const uploaded = new Set(
      uploaded_paths
        .map((p) => this._canonical_image_path(p))
        .filter((p): p is string => Boolean(p)),
    );
    const lines: string[] = [];
    for (const line of (content || "").split(/\r?\n/)) {
      const stripped = line.trim();
      if (!stripped) {
        lines.push("");
        continue;
      }
      if (this._line_is_uploaded_image_path(stripped, uploaded)) continue;
      const cleaned = this._remove_uploaded_markdown_image_refs(line, uploaded);
      const visible = cleaned.trim();
      if (visible && !["-", "*", "+"].includes(visible))
        lines.push(cleaned.trimEnd());
    }
    const cleaned = lines.join("\n").trim();
    if (!cleaned || cleaned.startsWith("已生成"))
      return `已生成 ${image_count} 张图片。`;
    return cleaned;
  }

  _line_is_uploaded_image_path(
    stripped_line: string,
    uploaded_paths: Set<string>,
  ): boolean {
    if (!stripped_line.startsWith("- ")) return false;
    const canonical = this._canonical_image_path(stripped_line.slice(2).trim());
    return Boolean(
      (canonical && uploaded_paths.has(canonical)) ||
      stripped_line.includes("/.codex/generated_images/"),
    );
  }

  _remove_uploaded_markdown_image_refs(
    line: string,
    uploaded_paths: Set<string>,
  ): string {
    if (!uploaded_paths.size) return line;
    return line.replace(FEISHU_MARKDOWN_IMAGE_RE, (full, target) => {
      const imagePath = this._local_image_path_from_reference(target);
      const canonical = this._canonical_image_path(imagePath);
      return canonical && uploaded_paths.has(canonical) ? "" : full;
    });
  }

  async _send_message(
    chat_id: string,
    content: string,
    card: Row | null = null,
    fallback_content: string | null = null,
  ): Promise<string | null> {
    if (!this._client) return null;
    try {
      const receive_id_type = chat_id.startsWith("oc_") ? "chat_id" : "open_id";
      const card_payload = card ?? this._build_legacy_markdown_card(content);
      const message_id = await this._create_message(
        receive_id_type,
        chat_id,
        card_payload,
      );
      if (message_id) return message_id;
      if (card !== null) {
        return await this._create_message(
          receive_id_type,
          chat_id,
          this._build_legacy_markdown_card(fallback_content ?? content),
        );
      }
      return null;
    } catch (e) {
      console.log(`[Feishu] Error sending message: ${e}`);
      return null;
    }
  }

  async _reply_message(
    parent_message_id: string,
    content: string,
    card: Row | null = null,
  ): Promise<string | null> {
    if (!this._client) return null;
    try {
      const reply_card = card ?? this._build_legacy_markdown_card(content);
      const message_id = await this._create_reply(
        parent_message_id,
        reply_card,
      );
      if (message_id) return message_id;
      if (card !== null)
        return await this._create_reply(
          parent_message_id,
          this._build_legacy_markdown_card(content),
        );
      return null;
    } catch (e) {
      console.log(`[Feishu] Error replying to message: ${e}`);
      return null;
    }
  }

  async _create_message(
    receive_id_type: string,
    chat_id: string,
    card: Row,
  ): Promise<string | null> {
    if (!this._client) return null;
    const request = {
      receive_id_type,
      params: { receive_id_type },
      request_body: {
        receive_id: chat_id,
        msg_type: "interactive",
        content: stringifyCard(card),
      },
      data: {
        receive_id: chat_id,
        msg_type: "interactive",
        content: stringifyCard(card),
      },
    };
    const response = this._client.im?.v1?.message?.create
      ? await callMaybeAsync(this._client.im.v1.message.create(request))
      : await callMaybeAsync(this._client.im.message.create(request));
    if (responseSuccess(response)) return responseMessageId(response);
    console.log(`[Feishu] Send failed: ${response?.code} ${response?.msg}`);
    return null;
  }

  async _create_reply(
    parent_message_id: string,
    card: Row,
  ): Promise<string | null> {
    if (!this._client) return null;
    const request = {
      message_id: parent_message_id,
      path: { message_id: parent_message_id },
      request_body: {
        msg_type: "interactive",
        content: stringifyCard(card),
        reply_in_thread: true,
      },
      data: {
        msg_type: "interactive",
        content: stringifyCard(card),
        reply_in_thread: true,
      },
    };
    const response = this._client.im?.v1?.message?.reply
      ? await callMaybeAsync(this._client.im.v1.message.reply(request))
      : await callMaybeAsync(this._client.im.message.reply(request));
    if (responseSuccess(response)) return responseMessageId(response);
    console.log(`[Feishu] Reply failed: ${response?.code} ${response?.msg}`);
    return null;
  }

  async _patch_message(message_id: string, card: Row): Promise<boolean> {
    if (!this._client) return false;
    try {
      const request = {
        message_id,
        path: { message_id },
        request_body: { content: stringifyCard(card) },
        data: { content: stringifyCard(card) },
      };
      const response = this._client.im?.v1?.message?.patch
        ? await callMaybeAsync(this._client.im.v1.message.patch(request))
        : await callMaybeAsync(this._client.im.message.patch(request));
      if (responseSuccess(response)) return true;
      console.log(`[Feishu] Patch failed: ${response?.code} ${response?.msg}`);
      return false;
    } catch (e) {
      console.log(`[Feishu] Error patching message ${message_id}: ${e}`);
      return false;
    }
  }

  _build_streaming_card(
    task_id: number,
    task_title: string,
    output_text: string,
    done = false,
  ): Row {
    let elements: Row[];
    if (done) {
      const display_text = output_text.trim() || "完成";
      elements = [
        {
          tag: "markdown",
          content: this._preserve_feishu_markdown_linebreaks(display_text),
        },
      ];
    } else if (!output_text.trim()) {
      elements = [{ tag: "markdown", content: "Thinking ▌" }];
    } else {
      elements = [this._build_streaming_history_panel(output_text, true)];
    }
    return {
      schema: "2.0",
      config: { wide_screen_mode: true, width_mode: "fill" },
      body: { elements },
    };
  }

  _build_streaming_history_panel(output_text: string, expanded = false): Row {
    return {
      tag: "collapsible_panel",
      expanded,
      header: {
        title: { tag: "plain_text", content: "执行过程" },
        vertical_align: "center",
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          color: "",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "5px" },
      vertical_spacing: "8px",
      padding: "8px 8px 8px 8px",
      elements: this._build_streaming_history_elements(output_text),
    };
  }

  _build_streaming_history_elements(output_text: string): Row[] {
    const normalized = output_text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n+$/g, "");
    if (!normalized) return [];
    const line_elements =
      this._build_streaming_history_line_elements(normalized);
    return line_elements.length <= FEISHU_PANEL_MAX_LINE_ELEMENTS
      ? line_elements
      : this._build_streaming_history_markdown_elements(normalized);
  }

  _build_streaming_history_markdown_elements(text: string): Row[] {
    return this._chunk_text(text, FEISHU_CARD_MARKDOWN_CHUNK - 16).map(
      (chunk) => ({
        tag: "markdown",
        content: chunk,
      }),
    );
  }

  _build_streaming_history_line_elements(text: string): Row[] {
    const elements: Row[] = [];
    for (const line of text.split("\n")) {
      for (const chunk of line
        ? this._chunk_text(line, FEISHU_PANEL_PLAIN_TEXT_CHUNK)
        : [" "]) {
        elements.push(this._build_streaming_history_line(chunk));
      }
    }
    return elements;
  }

  _build_streaming_history_line(content: string): Row {
    return {
      tag: "div",
      text: {
        tag: "plain_text",
        text_color: "grey",
        text_size: "notation",
        content,
      },
    };
  }

  _preserve_feishu_markdown_linebreaks(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  _start_streaming(
    task_id: number,
    running_msg_id: string,
    task_title: string,
  ): void {
    this._stop_streaming(task_id);
    const writer = new _FeishuStreamWriter(
      task_id,
      running_msg_id,
      this,
      task_title,
    );
    this._writers.set(task_id, writer);
    this._streaming_msg.set(task_id, running_msg_id);
    const listener = writer.on_event.bind(writer);
    this._writer_listeners.set(task_id, listener);
    this.scheduler.add_output_listener(listener);
  }

  _stop_streaming(task_id: number): string | null {
    const writer = this._writers.get(task_id);
    if (!writer) return null;
    this._writers.delete(task_id);
    const listener = this._writer_listeners.get(task_id);
    if (listener) {
      this.scheduler.remove_output_listener(listener);
      this._writer_listeners.delete(task_id);
    }
    const history = writer.snapshot_text();
    writer.stop();
    return history;
  }

  _build_notification_card(args: {
    task_id: number;
    task: Row;
    is_completed: boolean;
    body_text: string;
    streaming_history?: string | null;
    image_keys?: string[] | null;
  }): Row {
    const clean_body =
      (args.body_text || "").trim() ||
      (args.is_completed ? "Done." : "Unknown error");
    const summary = clean_body
      ? this._truncate_text(clean_body.split(/\r?\n/)[0] ?? "", 120)
      : "";
    let elements = this._build_result_elements(
      clean_body,
      args.image_keys ?? [],
    );
    if (args.streaming_history?.trim()) {
      let panel_text = args.streaming_history;
      if (args.is_completed) {
        const stripped = this._strip_final_result_from_history(
          args.streaming_history,
          clean_body,
        );
        if (stripped.trim()) panel_text = stripped;
      }
      elements = [this._build_streaming_history_panel(panel_text)].concat(
        elements,
      );
    }
    if (!args.is_completed) {
      elements.push({
        tag: "markdown",
        content: `\`/status ${args.task_id}\` for full details`,
      });
    }
    return {
      schema: "2.0",
      config: {
        wide_screen_mode: true,
        enable_forward: true,
        width_mode: "fill",
        summary: { content: summary },
      },
      body: { elements },
    };
  }

  _strip_final_result_from_history(
    history: string,
    final_text: string,
  ): string {
    const final_body = (final_text || "").trim();
    if (!final_body) return history;
    const trimmed = history.trimEnd();
    return trimmed.endsWith(final_body)
      ? trimmed.slice(0, -final_body.length).trimEnd()
      : history;
  }

  _build_result_elements(
    body_text: string,
    image_keys: string[] | null = null,
  ): Row[] {
    const clean_body = (body_text || "").trim() || "Done.";
    const elements: Row[] = this._chunk_text(
      clean_body,
      FEISHU_CARD_MARKDOWN_CHUNK,
    ).map((chunk) => ({
      tag: "markdown",
      content: chunk,
    }));
    for (const [index, image_key] of (image_keys ?? []).entries()) {
      elements.push({
        tag: "img",
        img_key: image_key,
        alt: { tag: "plain_text", content: `generated image ${index + 1}` },
      });
    }
    return elements;
  }

  _build_legacy_markdown_card(content: string): Row {
    return {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content }],
    };
  }

  _truncate_text(text: string, limit: number): string {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    return normalized.length <= limit
      ? normalized
      : normalized.slice(0, limit).trimEnd() + "\n…(truncated)";
  }

  _chunk_text(text: string, limit: number): string[] {
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized) return [""];
    const chunks: string[] = [];
    for (let i = 0; i < normalized.length; i += limit)
      chunks.push(normalized.slice(i, i + limit));
    return chunks;
  }

  _escape_feishu_markdown(text: string): string {
    return text.replace(/\\/g, "\\\\");
  }

  _add_reaction(message_id: string, emoji_type = "THUMBSUP"): void {
    if (!this._client) return;
    void (async () => {
      try {
        const request = {
          message_id,
          path: { message_id },
          request_body: { reaction_type: { emoji_type } },
          data: { reaction_type: { emoji_type } },
        };
        if (this._client.im?.v1?.message_reaction?.create) {
          await this._client.im.v1.message_reaction.create(request);
        } else if (this._client.im?.messageReaction?.create) {
          await this._client.im.messageReaction.create(request);
        }
      } catch (e) {
        console.log(`[Feishu] Failed to add reaction to ${message_id}: ${e}`);
      }
    })();
  }

  _get_usage_stats(): string {
    return "📊 Claude Code 用量统计在 TypeScript 运行时暂不可用";
  }

  _extract_forwarded_content(message: Row): Row | null {
    const msg_type = message["message_type"];
    if (msg_type === "forward") {
      try {
        const content = JSON.parse(message["content"]);
        return {
          type: "forward",
          sender_name: content["sender_name"] ?? "Unknown",
          sender_id: content["sender_id"] ?? null,
          timestamp: content["create_time"] ?? null,
          text: content["text"] ?? "",
          images: content["images"] ?? [],
        };
      } catch {
        return null;
      }
    }
    if (msg_type === "post") {
      try {
        const post_body = JSON.parse(message["content"]);
        const lang_body =
          post_body["content"] ??
          post_body["zh_cn"] ??
          post_body["en_us"] ??
          Object.values(post_body)[0] ??
          {};
        const paragraphs = Array.isArray(lang_body)
          ? lang_body
          : (lang_body["content"] ?? []);
        for (const para of paragraphs) {
          for (const elem of para) {
            if (elem?.tag === "quote") {
              const user = elem["user"] ?? {};
              return {
                type: "quote",
                sender_name: user["name"] ?? "未知用户",
                sender_id: user["open_id"] ?? null,
                text: elem["text"] ?? "",
                timestamp: elem["create_time"] ?? null,
              };
            }
            if (elem?.tag === "nested_message") {
              const nested = elem["nested_message"] ?? {};
              return {
                type: "forward",
                sender_name: nested["sender_name"] ?? "未知用户",
                sender_id: nested["sender_id"] ?? null,
                timestamp: nested["create_time"] ?? null,
                text: nested["text"] ?? "",
                images: nested["images"] ?? [],
              };
            }
          }
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  _format_forwarded_prompt(
    original_content: string,
    forwarded: Row | null,
  ): string {
    if (!forwarded) return original_content;
    const parts = [
      "📨 [转发消息]",
      `转发自: ${forwarded["sender_name"] ?? "未知用户"}`,
    ];
    if (forwarded["timestamp"]) {
      const dt = new Date(Number(forwarded["timestamp"]) * 1000);
      const fmt = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(dt);
      parts.push(`时间: ${fmt.replaceAll("/", "-")}`);
    }
    parts.push("\n--- 转发内容 ---");
    parts.push(forwarded["text"] ?? "");
    const images = Array.isArray(forwarded["images"])
      ? forwarded["images"]
      : [];
    if (images.length) parts.push(`\n[包含 ${images.length} 张图片]`);
    if (original_content.trim()) {
      parts.push("\n--- 用户附加消息 ---");
      parts.push(original_content);
    }
    return parts.join("\n");
  }

  async _download_image(
    message_id: string,
    image_key: string,
  ): Promise<string | null> {
    if (!this._client) return null;
    try {
      const request = {
        message_id,
        file_key: image_key,
        type: "image",
        path: { message_id, file_key: image_key },
        params: { type: "image" },
      };
      const response = this._client.im?.v1?.message_resource?.get
        ? await callMaybeAsync(this._client.im.v1.message_resource.get(request))
        : await callMaybeAsync(this._client.im.messageResource.get(request));
      if (!responseSuccess(response)) return null;
      const image_data: Buffer = Buffer.from(
        response?.raw?.content ?? response?.data ?? [],
      );
      let extension = "jpg";
      if (image_data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
        extension = "jpg";
      else if (
        image_data
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      )
        extension = "png";
      else if (
        image_data.subarray(0, 6).toString() === "GIF87a" ||
        image_data.subarray(0, 6).toString() === "GIF89a"
      )
        extension = "gif";
      else if (
        image_data.subarray(0, 4).toString() === "RIFF" &&
        image_data.subarray(8, 12).toString() === "WEBP"
      )
        extension = "webp";
      const downloads_dir = path.join(
        os.homedir(),
        ".agentforge",
        "feishu_images",
      );
      fs.mkdirSync(downloads_dir, { recursive: true });
      const filePath = path.join(downloads_dir, `${image_key}.${extension}`);
      fs.writeFileSync(filePath, image_data);
      return filePath;
    } catch (e) {
      console.log(`[Feishu] Error downloading image ${image_key}: ${e}`);
      return null;
    }
  }

  _on_reaction(_data: unknown): void {
    return;
  }

  _on_bot_added(data: any): void {
    const event = extractEvent(data);
    const chat_id = event["chat_id"];
    if (chat_id) void this._send_message(chat_id, HELP_TEXT);
  }

  _on_message_sync(data: any): void {
    if (!this._running) return;
    void this._handle_inbound(data).catch((e) =>
      console.log(`[Feishu] Inbound handler error: ${e}`),
    );
  }

  async _handle_inbound(data: any): Promise<void> {
    const event = extractEvent(data);
    const message = event["message"] ?? {};
    const sender = event["sender"] ?? {};
    if (sender["sender_type"] === "bot") return;

    const parsed = await this._parse_message_content(message);
    if (!parsed) return;
    let { content, image_paths } = parsed;
    const forwarded = this._extract_forwarded_content(message);
    if (forwarded) {
      content = this._format_forwarded_prompt(content, forwarded);
      for (const img of forwarded["images"] ?? []) {
        const img_key = img?.["image_key"];
        if (img_key) {
          const img_path = await this._download_image(
            message["message_id"],
            img_key,
          );
          if (img_path) image_paths.push(img_path);
        }
      }
    }
    if (!content) return;

    this._add_reaction(message["message_id"], "OK");
    const sender_id = getSenderOpenId(sender);
    const chat_type = message["chat_type"];
    const chat_id = message["chat_id"];
    const reply_to = chat_type === "group" ? chat_id : sender_id;

    if (content.trim() === "/help" || content.trim() === "/start") {
      await this._send_message(reply_to, HELP_TEXT);
      return;
    }
    const brief_cmd = parse_brief_command(content);
    if (brief_cmd !== null) {
      await this._handle_brief_command(brief_cmd, reply_to, message, sender_id);
      return;
    }
    const runbook_cmd = parse_runbook_fallback(content, this.db);
    if (runbook_cmd !== null) {
      await this._handle_runbook_command(
        runbook_cmd,
        reply_to,
        message,
        sender_id,
      );
      return;
    }
    const skill_suggestion_cmd = parse_skill_suggestion_command(content);
    if (skill_suggestion_cmd !== null) {
      await this._handle_skill_suggestion_command(
        skill_suggestion_cmd,
        reply_to,
        message,
        sender_id,
      );
      return;
    }
    if (content.startsWith("/dir ") || content.startsWith("/cd ")) {
      const reply = handle_dir_command(content, "feishu", this.db);
      if (reply) await this._send_message(reply_to, reply);
      return;
    }
    if (content.startsWith("/agent ")) {
      const reply = handle_agent_command(content, "feishu", this.db);
      if (reply) await this._send_message(reply_to, reply);
      return;
    }
    if (content.trim().toLowerCase().startsWith("/ccu")) {
      await this._send_message(reply_to, this._get_usage_stats());
      return;
    }
    if (content.startsWith("/resume ")) {
      await this._handle_resume_command(content, reply_to, message);
      return;
    }
    if (content.startsWith("/status ")) {
      await this._handle_status_command(content, reply_to);
      return;
    }
    if (
      [
        "notification",
        "任务完成",
        "任务失败",
        "任务状态",
        "任务已",
        "task completed",
        "task failed",
        "task status",
      ].some((keyword) => content.toLowerCase().includes(keyword))
    ) {
      return;
    }

    const parent_id = message["parent_id"] || null;
    const root_id = message["root_id"] || null;
    if (parent_id || root_id) {
      const resumed = await this._try_resume_thread_message(
        content,
        reply_to,
        message,
        parent_id,
        root_id,
      );
      if (resumed) return;
    }
    await this._create_task_from_message(
      content,
      image_paths,
      reply_to,
      message,
    );
  }

  async _parse_message_content(
    message: Row,
  ): Promise<{ content: string; image_paths: string[] } | null> {
    const msg_type = message["message_type"];
    const image_paths: string[] = [];
    if (msg_type === "text") {
      try {
        return {
          content: String(JSON.parse(message["content"])["text"] ?? "").trim(),
          image_paths,
        };
      } catch {
        return {
          content: String(message["content"] ?? "").trim(),
          image_paths,
        };
      }
    }
    if (msg_type === "post") {
      try {
        const post_body = JSON.parse(message["content"]);
        const lang_body = post_body["content"]
          ? post_body
          : post_body["zh_cn"] ||
            post_body["en_us"] ||
            Object.values(post_body)[0] ||
            {};
        const text_parts: string[] = [];
        for (const para of lang_body["content"] ?? []) {
          for (const elem of para) {
            if (elem?.tag === "text") text_parts.push(elem["text"] ?? "");
            if (elem?.tag === "img" && elem["image_key"]) {
              const imagePath = await this._download_image(
                message["message_id"],
                elem["image_key"],
              );
              if (imagePath) image_paths.push(imagePath);
            }
          }
        }
        const content = [
          String(lang_body["title"] ?? "").trim(),
          text_parts.join("").trim(),
        ]
          .filter(Boolean)
          .join("\n");
        return {
          content:
            content || (image_paths.length ? "请分析这些图片的内容" : ""),
          image_paths,
        };
      } catch {
        return { content: "", image_paths };
      }
    }
    if (msg_type === "image") {
      try {
        const image_key = JSON.parse(message["content"])["image_key"];
        if (image_key) {
          const imagePath = await this._download_image(
            message["message_id"],
            image_key,
          );
          if (imagePath) image_paths.push(imagePath);
        }
      } catch {
        // Keep default prompt for malformed image payloads.
      }
      return { content: "请分析这张图片的内容", image_paths };
    }
    return null;
  }

  async _handle_resume_command(
    content: string,
    reply_to: string,
    message: Row,
  ): Promise<void> {
    const parts = content.slice(8).trim().split(" ");
    const tid = Number(parts.shift());
    const resume_msg = parts.join(" ").trim();
    if (!Number.isInteger(tid) || !resume_msg) {
      await this._send_message(
        reply_to,
        "Usage: `/resume <task_id> <message>`",
      );
      return;
    }
    const task = this.db.get_task(tid) as Row | null;
    if (task?.["session_id"]) {
      this.db.update_task(tid, {
        status: "pending",
        prompt: resume_msg,
        result: null,
        error: null,
        question: null,
      });
      this._task_origin.set(tid, [
        reply_to,
        message["message_id"],
        message["message_id"],
      ]);
      this._remember_task_source(tid);
      const title =
        (this.db.get_task(tid) as Row | null)?.["title"] ?? `Task #${tid}`;
      const running_msg_id = await this._create_reply(
        message["message_id"],
        this._build_streaming_card(tid, title, ""),
      );
      if (running_msg_id) this._start_streaming(tid, running_msg_id, title);
    } else {
      await this._send_message(
        reply_to,
        `❌ Task #${tid} not found or has no saved session.`,
      );
    }
  }

  async _handle_status_command(
    content: string,
    reply_to: string,
  ): Promise<void> {
    const tid = Number(content.slice(8).trim().split(/\s+/)[0]);
    if (!Number.isInteger(tid)) return;
    const task = this.db.get_task(tid) as Row | null;
    if (!task) {
      await this._send_message(reply_to, `❌ Task #${tid} not found.`);
      return;
    }
    const icons: Record<string, string> = {
      completed: "✅",
      failed: "❌",
      running: "⏳",
      pending: "🕐",
      cancelled: "🚫",
    };
    const icon = icons[String(task["status"])] ?? "❓";
    await this._send_message(
      reply_to,
      `${icon} **Task #${tid}** — ${task["status"]}\n\n**${task["title"]}**`,
    );
  }

  async _handle_brief_command(
    command: BriefCommand,
    reply_to: string,
    message: Row,
    sender_id: string,
  ): Promise<void> {
    if (command.action === "help") {
      await this._send_message(reply_to, format_brief_help(command.reason));
      return;
    }
    if (!this.scheduler.handle_inbound_message) {
      await this._send_message(
        reply_to,
        "❌ Draft task flow is not available in this scheduler.",
      );
      return;
    }

    const message_id = asString(message["message_id"], reply_to);
    const metadata = this._brief_source_metadata(message, sender_id);
    try {
      if (command.action === "create") {
        const payload = build_brief_payload({
          channel: "feishu",
          goal: command.goal,
          source_ref: message_id,
          source_metadata: metadata,
          working_dir: await resolve_working_dir(
            command.goal,
            "feishu",
            this.db,
          ),
          agent: resolve_agent("feishu", this.db),
        });
        const result = this.scheduler.handle_inbound_message(
          this._make_inbound(
            InboundMessageType.CREATE_BRIEF,
            payload,
            reply_to,
            metadata,
          ),
        );
        const brief_id = Number(result["brief_id"]);
        await this._send_message(
          reply_to,
          format_brief_created_reply(brief_id, String(payload["title"])),
        );
        return;
      }

      if (command.action === "confirm") {
        const result = this.scheduler.handle_inbound_message(
          this._make_inbound(
            InboundMessageType.CONFIRM_BRIEF,
            { brief_id: command.brief_id },
            reply_to,
            metadata,
          ),
        );
        const task_id = Number(result["task_id"]);
        if (!Number.isInteger(task_id) || task_id <= 0) {
          await this._send_message(
            reply_to,
            "❌ Draft task confirmation failed.",
          );
          return;
        }

        this._task_origin.set(task_id, [reply_to, message_id, message_id]);
        this._root_msg_map.set(message_id, task_id);
        this._remember_task_source(task_id);
        const title =
          (this.db.get_task(task_id) as Row | null)?.["title"] ??
          `Task #${task_id}`;
        const running_msg_id = await this._create_reply(
          message_id,
          this._build_legacy_markdown_card(
            format_brief_started_reply(command.brief_id, task_id),
          ),
        );
        if (running_msg_id)
          this._start_streaming(task_id, running_msg_id, String(title));
        return;
      }

      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.DISCARD_BRIEF,
          { brief_id: command.brief_id },
          reply_to,
          metadata,
        ),
      );
      await this._send_message(
        reply_to,
        format_brief_discarded_reply(Number(result["brief_id"])),
      );
    } catch (e) {
      await this._send_message(
        reply_to,
        `❌ ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async _handle_runbook_command(
    command: ParsedRunbookCommand,
    reply_to: string,
    message: Row,
    sender_id: string,
  ): Promise<void> {
    if (!this.scheduler.handle_inbound_message) {
      await this._send_message(
        reply_to,
        "❌ Custom command flow is not available in this scheduler.",
      );
      return;
    }

    const message_id = asString(message["message_id"], reply_to);
    const metadata = this._brief_source_metadata(message, sender_id);
    try {
      const payload = build_runbook_payload({
        channel: "feishu",
        command,
        source_ref: message_id,
        source_metadata: metadata,
        working_dir: await resolve_working_dir(
          command.raw_args || command.name,
          "feishu",
          this.db,
        ),
        agent: resolve_agent("feishu", this.db),
      });
      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.RUN_RUNBOOK,
          payload,
          reply_to,
          metadata,
        ),
      );
      if (result["status"] === "created") {
        const task_id = Number(result["task_id"]);
        this._task_origin.set(task_id, [reply_to, message_id, message_id]);
        this._root_msg_map.set(message_id, task_id);
        this._remember_task_source(task_id);
        const title =
          (this.db.get_task(task_id) as Row | null)?.["title"] ??
          `Task #${task_id}`;
        const running_msg_id = await this._create_reply(
          message_id,
          this._build_legacy_markdown_card(
            format_runbook_created_reply(task_id, command.name),
          ),
        );
        if (running_msg_id)
          this._start_streaming(task_id, running_msg_id, String(title));
        return;
      }
      if (result["status"] === "draft") {
        await this._send_message(
          reply_to,
          format_runbook_brief_reply(Number(result["brief_id"]), command.name),
        );
        return;
      }
      await this._send_message(reply_to, "❌ Custom command failed.");
    } catch (e) {
      await this._send_message(
        reply_to,
        `❌ ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async _handle_skill_suggestion_command(
    command: SkillSuggestionCommand,
    reply_to: string,
    message: Row,
    sender_id: string,
  ): Promise<void> {
    if (command.action === "help") {
      await this._send_message(
        reply_to,
        format_skill_suggestion_help(command.reason),
      );
      return;
    }
    if (!this.scheduler.handle_inbound_message) {
      await this._send_message(
        reply_to,
        "❌ Skill suggestion flow is not available in this scheduler.",
      );
      return;
    }

    const metadata = this._brief_source_metadata(message, sender_id);
    try {
      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.SKILL_SUGGESTION_ACTION,
          {
            action: command.action,
            pattern_id: command.pattern_id,
            source_channel: "feishu",
            target: reply_to,
            source_metadata: metadata,
          },
          reply_to,
          metadata,
        ),
      );
      await this._send_message(
        reply_to,
        format_skill_suggestion_action_reply(result),
      );
    } catch (e) {
      await this._send_message(
        reply_to,
        `❌ ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  _brief_source_metadata(
    message: Row,
    sender_id: string,
  ): Record<string, unknown> {
    return {
      chat_id: asString(message["chat_id"]),
      chat_type: asString(message["chat_type"]),
      message_id: asString(message["message_id"]),
      sender_id,
    };
  }

  async _try_resume_thread_message(
    content: string,
    reply_to: string,
    message: Row,
    parent_id: string | null,
    root_id: string | null,
  ): Promise<boolean> {
    let task_id: number | undefined;
    if (parent_id) task_id = this._notification_map.get(parent_id);
    if (!task_id && root_id) task_id = this._notification_map.get(root_id);
    if (!task_id && root_id) task_id = this._root_msg_map.get(root_id);
    if (!task_id && parent_id) task_id = this._root_msg_map.get(parent_id);
    if (!task_id) {
      for (const msg_id of [root_id, parent_id].filter(Boolean) as string[]) {
        const db_task = this.db.get_task_by_feishu_root_msg(msg_id);
        if (db_task) {
          task_id = db_task["id"];
          break;
        }
      }
    }
    if (!task_id) return false;
    const task = this.db.get_task(task_id) as Row | null;
    const thread_root = root_id || parent_id!;
    if (task?.["session_id"]) {
      this.db.update_task(task_id, {
        status: "pending",
        prompt: content,
        result: null,
        error: null,
        question: null,
      });
      this._task_origin.set(task_id, [
        reply_to,
        thread_root,
        message["message_id"],
      ]);
      this._remember_task_source(task_id);
      const title =
        (this.db.get_task(task_id) as Row | null)?.["title"] ??
        `Task #${task_id}`;
      const running_msg_id = await this._create_reply(
        thread_root,
        this._build_streaming_card(task_id, title, ""),
      );
      if (running_msg_id) this._start_streaming(task_id, running_msg_id, title);
    } else {
      await this._reply_message(
        thread_root,
        `❌ Task #${task_id} not found or has no saved session.`,
      );
    }
    return true;
  }

  async _create_task_from_message(
    content: string,
    image_paths: string[],
    reply_to: string,
    message: Row,
  ): Promise<void> {
    const working_dir = await resolve_working_dir(content, "feishu", this.db);
    const title = content.slice(0, 60) + (content.length > 60 ? "…" : "");
    const prompt_images: PromptImage[] = [];
    for (const imagePath of image_paths) {
      try {
        prompt_images.push({
          name: path.basename(imagePath),
          media_type: localImageMediaType(imagePath),
          data: fs.readFileSync(imagePath).toString("base64"),
        });
      } catch (e) {
        console.log(
          `[Feishu] Failed to convert image ${imagePath} to base64: ${e}`,
        );
      }
    }
    const task = makeTask({
      title: `[Feishu] ${title}`,
      prompt: content,
      working_dir,
      schedule_type: ScheduleType.IMMEDIATE,
      tags: "feishu",
      image_paths,
      prompt_images,
      feishu_root_msg_id: message["message_id"] ?? null,
      agent: resolve_agent("feishu", this.db),
    });
    const task_id = this.scheduler.submit_task(task);
    const running_msg_id = await this._create_reply(
      message["message_id"],
      this._build_streaming_card(task_id, task.title, ""),
    );
    this._task_origin.set(task_id, [
      reply_to,
      message["message_id"],
      message["message_id"],
    ]);
    this._remember_task_source(task_id);
    this._root_msg_map.set(message["message_id"], task_id);
    if (running_msg_id)
      this._start_streaming(task_id, running_msg_id, task.title);
  }
}
