/**
 * Weixin channel for AgentForge — ported from channels/weixin_channel.py.
 *
 * Text-only MVP backed by a sidecar bridge process that communicates with the
 * backend via newline-delimited JSON over stdio. The Python original spawned
 * the Node bridge (`node weixin_bridge/index.mjs`); this port spawns the
 * TypeScript bridge under Bun (`bun weixin_bridge/index.ts`). Protocol
 * strings, NDJSON command/event shapes, and user-facing strings are kept
 * byte-identical to the Python source.
 *
 * Porting notes
 * ─────────────
 * - subprocess.Popen → the injectable `_hooks.spawn_bridge` seam returning a
 *   WeixinBridgeProcess (stdin writer + stdout line iterable + poll/terminate/
 *   wait). Tests inject a fake process exactly where the pytest suite
 *   monkeypatched `channels.weixin_channel.subprocess.Popen`.
 * - The stdout reader daemon thread → an async loop (`_read_bridge_events`)
 *   whose promise is kept in `_reader_promise` (≙ `_reader_thread`).
 * - Python merged the bridge's stderr into stdout (stderr=subprocess.STDOUT);
 *   here the default spawn inherits stderr so bridge logs go straight to the
 *   backend's stderr instead of through the "Ignoring non-JSON" logger.
 * - threading.Lock fields are dropped (single-threaded event loop).
 * - resolve_working_dir is async in TS, so _handle_message_event (and thus
 *   _handle_bridge_event) is async.
 */

import crypto from "node:crypto";
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

export const WEIXIN_UPLOADABLE_IMAGE_SUFFIXES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);
const WEIXIN_MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)]+)\)/g;
// ≙ re.compile(r"^/new(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL)
const WEIXIN_NEW_SESSION_RE = /^\/new(?:\s+([\s\S]*))?$/i;

// ── injectable process seam ───────────────────────────────────────

/** Writable stdin of the bridge process (≙ Popen.stdin in text mode). */
export interface WeixinBridgeStdin {
  write(data: string): unknown;
  flush?(): unknown;
}

/**
 * Minimal view of the spawned bridge process (≙ subprocess.Popen). `stdout`
 * yields lines (like iterating Popen.stdout in text mode); tests supply a
 * plain string[].
 */
export interface WeixinBridgeProcess {
  stdin: WeixinBridgeStdin | null;
  stdout: AsyncIterable<string> | Iterable<string> | null;
  /** ≙ Popen.poll(): null while alive, exit code once exited. */
  poll(): number | null;
  terminate(): void;
  /** ≙ Popen.wait(timeout=...); may return a promise (not awaited). */
  wait(timeout?: number | null): unknown;
}

export type SpawnBridge = (
  cmd: string[],
  env: Record<string, string | undefined>,
) => WeixinBridgeProcess;

/** Split a byte stream into lines (trailing newline included, like Python). */
async function* _iter_lines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffered.indexOf("\n")) !== -1) {
      yield buffered.slice(0, idx + 1);
      buffered = buffered.slice(idx + 1);
    }
  }
  buffered += decoder.decode();
  if (buffered) yield buffered;
}

/**
 * Default spawn implementation (≙ subprocess.Popen(..., text=True)).
 * Bun.spawn throws synchronously with code "ENOENT" when the executable is
 * missing, matching Python's FileNotFoundError handling in start().
 */
function _default_spawn_bridge(
  cmd: string[],
  env: Record<string, string | undefined>,
): WeixinBridgeProcess {
  const proc = Bun.spawn({
    cmd: cmd as [string, ...string[]],
    env,
    stdin: "pipe",
    stdout: "pipe",
    // Python used stderr=subprocess.STDOUT; inheriting keeps bridge logs
    // visible without routing them through the NDJSON event reader.
    stderr: "inherit",
  });
  return {
    stdin: proc.stdin,
    stdout: _iter_lines(proc.stdout),
    poll: () => proc.exitCode,
    terminate: () => {
      proc.kill();
    },
    wait: (_timeout?: number | null) => proc.exited,
  };
}

/** ≙ shutil.which — the backend itself runs under Bun, so the current
 * executable is the most reliable full path to the runtime (it survives the
 * minimal PATH a Finder/Dock-launched macOS app inherits). */
function _default_which(cmd: string): string | null {
  const execPath = process.execPath || "";
  if (path.basename(execPath) === cmd) {
    return execPath;
  }

  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Locate the Bun binary used to run the sidecar bridge.
 *
 * ≙ Python's _find_node_executable (the bridge ran on Node there): macOS apps
 * launched from Finder/Dock inherit a minimal PATH that excludes Homebrew
 * (`/opt/homebrew/bin`), so fall back to the common install locations when
 * the primary lookup misses.
 */
export function _find_bun_executable(): string | null {
  const found = _hooks.which("bun");
  if (found) {
    return found;
  }
  for (const candidate of [
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
  ]) {
    if (_hooks.path_exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function _is_bridge_script(entrypoint: string): boolean {
  return new Set([".ts", ".js", ".mjs", ".cjs"]).has(
    path.extname(entrypoint).toLowerCase(),
  );
}

// Test seams (≙ the pytest monkeypatch targets):
//   spawn_bridge        ≙ channels.weixin_channel.subprocess.Popen
//   which               ≙ channels.weixin_channel.shutil.which
//   path_exists         ≙ channels.weixin_channel.os.path.exists
//   handle_dir_command  ≙ channels.dir_utils.handle_dir_command (Python
//   handle_agent_command  imports these inside _handle_message_event, so
//                         module-attribute patches took effect there)
export const _hooks = {
  spawn_bridge: _default_spawn_bridge as SpawnBridge,
  which: _default_which,
  path_exists: (p: string): boolean => fs.existsSync(p),
  handle_dir_command,
  handle_agent_command,
};

// ── structural dependency interfaces ──────────────────────────────

/** Minimal structural view of TaskDB used by this channel. */
export interface WeixinTaskDB extends TaskDBLike, SettingsDB {
  update_task(task_id: number, updates: Record<string, unknown>): void;
  get_task_runs(task_id: number, limit?: number): unknown;
  get_run_output_events(run_id: number, limit?: number): unknown;
}

/**
 * Minimal structural view of TaskScheduler (do NOT import scheduler.ts).
 * Python source: TaskScheduler.submit_task(self, task, depends_on=None) -> int;
 * this channel only ever calls submit_task(task).
 */
export interface WeixinScheduler {
  submit_task(task: Task): number;
  handle_inbound_message?(msg: InboundMessage): Record<string, unknown>;
}

/** Status snapshot consumed by _build_weixin_channel_status in taskboard. */
interface WeixinStatus {
  configured: boolean;
  login_status: string;
  qr_code_url: string;
  last_error: string;
  account_id: string;
  user_id: string;
}

// ── helpers (≙ urllib.parse / pathlib bits) ───────────────────────

/** ≙ urlparse(target).path for file:// references (scheme + netloc dropped). */
function _file_url_path(target: string): string {
  const rest = target.slice("file://".length);
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "";
}

/** ≙ urllib.parse.unquote (left untouched when percent-decoding fails). */
function _unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** ≙ Path.expanduser(). */
function _expanduser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function _is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff]);

// ── WeixinChannel ─────────────────────────────────────────────────

/** Weixin integration using a sidecar bridge process. */
export class WeixinChannel extends Channel {
  declare db: WeixinTaskDB;
  scheduler: WeixinScheduler;
  bridge_cmd: string[];
  _bridge_proc: WeixinBridgeProcess | null = null;
  /** ≙ self._reader_thread (daemon thread joining the bridge stdout). */
  _reader_promise: Promise<void> | null = null;

  // task_id -> origin metadata used for notifications and resume
  _task_origin: Map<number, Record<string, string>> = new Map();

  // account_id:peer_id -> current task_id. Weixin has no thread, so this
  // gives each peer a current AgentForge session until /new starts another.
  _peer_current_task: Map<string, number> = new Map();

  // request_id -> task_id for sent acknowledgements from the bridge
  _pending_notifications: Map<string, number> = new Map();

  _status: WeixinStatus = {
    configured: false,
    login_status: "idle",
    qr_code_url: "",
    last_error: "",
    account_id: "",
    user_id: "",
  };

  constructor(
    bus: MessageBus,
    db: WeixinTaskDB,
    scheduler: WeixinScheduler,
    bridge_cmd: string[] | null = null,
  ) {
    super("weixin", bus, db);
    this.scheduler = scheduler;
    this.bridge_cmd = bridge_cmd ?? this._default_bridge_cmd();

    bus.subscribe_outbound(this._on_outbound);
  }

  _bridge_script_path(): string {
    // ≙ the PyInstaller sys._MEIPASS branch: the Python build shipped the
    // bridge via --add-data and resolved it under sys._MEIPASS when frozen.
    // The Bun single-binary build (`bun build --compile`) cannot resolve
    // source-relative paths either, so the packaged app sets
    // AGENTFORGE_WEIXIN_BRIDGE to the bridge entrypoint it ships alongside
    // the binary; dev falls back to the source tree next to this module.
    const override = process.env.AGENTFORGE_WEIXIN_BRIDGE;
    if (override) {
      return override;
    }
    const packagedBridge = path.join(
      path.dirname(process.execPath),
      "weixin-bridge",
    );
    if (_hooks.path_exists(packagedBridge)) {
      return packagedBridge;
    }
    return path.join(import.meta.dir, "weixin_bridge", "index.ts");
  }

  _default_bridge_cmd(): string[] {
    const bridgeEntrypoint = this._bridge_script_path();
    if (!_is_bridge_script(bridgeEntrypoint)) {
      return [bridgeEntrypoint];
    }

    // Resolve bun to a full path so it's found even under the minimal PATH
    // a packaged macOS app inherits. Falls back to bare "bun" when missing;
    // start() then surfaces the spawn ENOENT as an error status.
    return [_find_bun_executable() || "bun", bridgeEntrypoint];
  }

  start(): void {
    this._running = true;
    try {
      const env: Record<string, string | undefined> = { ...process.env };
      if (env["AGENTFORGE_WEIXIN_DATA_DIR"] === undefined) {
        env["AGENTFORGE_WEIXIN_DATA_DIR"] = path.join(
          os.homedir(),
          ".agentforge",
          "weixin",
        );
      }
      if (env["AGENTFORGE_WEIXIN_BASE_URL"] === undefined) {
        env["AGENTFORGE_WEIXIN_BASE_URL"] =
          this.db.get_setting(
            "weixin_base_url",
            "https://ilinkai.weixin.qq.com",
          ) ?? "https://ilinkai.weixin.qq.com";
      }
      if (env["AGENTFORGE_WEIXIN_ACCOUNT_ID"] === undefined) {
        env["AGENTFORGE_WEIXIN_ACCOUNT_ID"] =
          this.db.get_setting("weixin_account_id", "") ?? "";
      }
      this._bridge_proc = _hooks.spawn_bridge(this.bridge_cmd, env);
    } catch (exc) {
      this._running = false;
      this._bridge_proc = null;
      if ((exc as NodeJS.ErrnoException)?.code === "ENOENT") {
        const msg =
          "Bun not found. Install Bun (https://bun.sh) to use the Weixin channel.";
        console.log(`[Weixin] ${msg}`);
        this._update_status({ login_status: "error", last_error: msg });
        return;
      }
      const msg = `Failed to start Weixin bridge: ${exc}`;
      console.log(`[Weixin] ${msg}`);
      this._update_status({ login_status: "error", last_error: msg });
      return;
    }

    this._reader_promise = this._read_bridge_events().catch((exc) => {
      console.log(`[Weixin] Bridge reader error: ${exc}`);
    });
    console.log("[Weixin] Bridge started");
  }

  stop(): void {
    this._running = false;
    this.bus.unsubscribe_outbound(this._on_outbound);
    if (this._bridge_proc && this._bridge_proc.poll() === null) {
      try {
        this._bridge_proc.terminate();
        void this._bridge_proc.wait(5);
      } catch {
        /* pass */
      }
    }
    this._bridge_proc = null;
  }

  send(msg: OutboundMessage): void {
    if (!this._running) {
      return;
    }
    if (
      msg.type !== OutboundMessageType.TASK_COMPLETED &&
      msg.type !== OutboundMessageType.TASK_FAILED
    ) {
      return;
    }
    if (!this._should_handle_outbound(msg)) {
      return;
    }

    const task_id = msg.task_id;
    const origin = this._task_origin.get(task_id);
    if (!origin) {
      console.log(
        `[Weixin] No origin for task #${task_id}, skipping outbound notification`,
      );
      return;
    }

    const task = this.db.get_task(task_id) ?? {};
    let text: string;
    let image_paths: string[];
    if (msg.type === OutboundMessageType.TASK_COMPLETED) {
      let body =
        ((msg.payload["result"] as string | null | undefined) || "").trim() ||
        "Done.";
      image_paths = this._collect_generated_image_paths(task_id, body, task);
      if (image_paths.length > 0) {
        body = this._hide_generated_image_paths(
          body,
          image_paths.length,
          image_paths,
        );
      }
      text = body;
    } else {
      const body = (
        (msg.payload["error"] as string | null | undefined) || "Unknown error"
      ).trim();
      image_paths = [];
      text = `❌\n${body}`;
    }

    const request_id = crypto.randomUUID().replaceAll("-", ""); // ≙ uuid.uuid4().hex
    this._pending_notifications.set(request_id, task_id);
    const command: Record<string, unknown> = {
      type: "send_message",
      request_id,
      account_id: origin["account_id"] ?? "",
      peer_id: origin["peer_id"],
      context_token: origin["context_token"] ?? "",
      text,
    };
    if (image_paths.length > 0) {
      command["image_paths"] = image_paths;
    }
    this._send_command(command);

    this._task_origin.delete(task_id);
  }

  /** Arrow-function property so subscribe/unsubscribe get a stable bound ref. */
  _on_outbound = (msg: OutboundMessage): void => {
    this.send(msg);
  };

  async _read_bridge_events(): Promise<void> {
    const proc = this._bridge_proc;
    if (!proc || !proc.stdout) {
      return;
    }

    for await (const raw_line of proc.stdout) {
      if (!this._running) {
        return;
      }
      const line = raw_line.trim();
      if (!line) {
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        console.log(`[Weixin] Ignoring non-JSON bridge output: ${line}`);
        continue;
      }
      await this._handle_bridge_event(event);
    }
  }

  async _handle_bridge_event(event: Record<string, unknown>): Promise<void> {
    const event_type = event["type"];
    if (event_type === "message") {
      await this._handle_message_event(event);
    } else if (event_type === "sent") {
      this._handle_sent_event(event);
    } else if (event_type === "qr") {
      const qr_value =
        ((event["qrcode_url"] as string | undefined) ?? "") || "";
      console.log(
        `[Weixin] QR payload len=${qr_value.length} prefix=${JSON.stringify(qr_value.slice(0, 80))}`,
      );
      this._update_status({
        login_status: "waiting_for_scan",
        qr_code_url: qr_value,
        account_id: (event["account_id"] as string | undefined) ?? "",
        last_error: "",
      });
      console.log("[Weixin] Bridge event: qr");
    } else if (event_type === "scaned") {
      this._update_status({ login_status: "scanned", last_error: "" });
      console.log("[Weixin] Bridge event: scaned");
    } else if (event_type === "login_success") {
      this._update_status({
        configured: true,
        login_status: "connected",
        qr_code_url: "",
        account_id: (event["account_id"] as string | undefined) ?? "",
        user_id: (event["user_id"] as string | undefined) ?? "",
        last_error: "",
      });
      console.log("[Weixin] Bridge event: login_success");
    } else if (event_type === "ready") {
      this._update_status({
        configured: true,
        login_status: "connected",
        qr_code_url: "",
        account_id: (event["account_id"] as string | undefined) ?? "",
        last_error: "",
      });
      console.log("[Weixin] Bridge event: ready");
    } else if (event_type === "logged_out") {
      this._update_status({
        configured: false,
        login_status: "idle",
        qr_code_url: "",
        last_error: "",
        user_id: "",
      });
      console.log("[Weixin] Bridge event: logged_out");
    } else if (event_type === "error") {
      this._update_status({
        login_status: "error",
        last_error: (event["message"] as string | undefined) ?? "unknown_error",
      });
      console.log("[Weixin] Bridge event: error");
    }
  }

  _handle_sent_event(event: Record<string, unknown>): void {
    const request_id =
      ((event["request_id"] as string | undefined) || "") ?? "";
    const message_id =
      ((event["message_id"] as string | undefined) || "") ?? "";
    const quoted_message_id =
      ((event["quoted_message_id"] as string | undefined) || "") ?? "";
    if (!request_id || (!message_id && !quoted_message_id)) {
      return;
    }
    if (!this._pending_notifications.has(request_id)) {
      return;
    }
    this._pending_notifications.delete(request_id);
  }

  async _handle_message_event(event: Record<string, unknown>): Promise<void> {
    let text = ((event["text"] as string | null | undefined) || "").trim();
    const image_paths = this._extract_image_paths(event);
    if (!text && image_paths.length === 0) {
      return;
    }

    const peer_id =
      (event["peer_id"] as string | undefined) ||
      (event["from_user_id"] as string | undefined) ||
      "";
    const account_id = (event["account_id"] as string | undefined) || "";
    const context_token = (event["context_token"] as string | undefined) || "";
    const message_id = (event["message_id"] as string | undefined) || "";
    const peer_key = this._peer_key(account_id, peer_id);

    const new_match = text ? WEIXIN_NEW_SESSION_RE.exec(text) : null;
    const force_new_session = Boolean(new_match);
    if (new_match) {
      text = (new_match[1] || "").trim();
      this._clear_peer_current_task(peer_key);
      if (!text && image_paths.length === 0) {
        this._reply_to_event(
          event,
          "🆕 已开启新的 Weixin session，请发送新的任务内容。",
        );
        return;
      }
    }

    const dir_reply = _hooks.handle_dir_command(text, "weixin", this.db);
    if (dir_reply !== null) {
      this._reply_to_event(event, dir_reply);
      return;
    }

    const agent_reply = _hooks.handle_agent_command(text, "weixin", this.db);
    if (agent_reply !== null) {
      this._reply_to_event(event, agent_reply);
      return;
    }

    const brief_command = parse_brief_command(text);
    if (brief_command !== null) {
      await this._handle_brief_command(brief_command, event, {
        account_id,
        peer_id,
        context_token,
        message_id,
        peer_key,
      });
      return;
    }
    const runbook_command = parse_runbook_fallback(text, this.db);
    if (runbook_command !== null) {
      await this._handle_runbook_command(runbook_command, event, {
        account_id,
        peer_id,
        context_token,
        message_id,
        peer_key,
      });
      return;
    }
    const skill_suggestion_command = parse_skill_suggestion_command(text);
    if (skill_suggestion_command !== null) {
      await this._handle_skill_suggestion_command(
        skill_suggestion_command,
        event,
        {
          account_id,
          peer_id,
          context_token,
          message_id,
          peer_key,
        },
      );
      return;
    }

    const task_id = force_new_session
      ? null
      : this._get_peer_current_task(peer_key);

    if (task_id !== null) {
      const task = this.db.get_task(task_id);
      if (task && task["session_id"]) {
        const updates = this._build_resume_updates(text, image_paths);
        this.db.update_task(task_id, updates);
        this._task_origin.set(task_id, {
          account_id,
          peer_id,
          context_token,
          message_id,
        });
        this._remember_task_source(task_id);
        this._set_peer_current_task(peer_key, task_id);
        this._reply_to_event(event, "收到，继续处理。");
        return;
      }
    }

    const prompt = text || this._default_image_prompt(image_paths);
    const prompt_images = this._build_prompt_images(image_paths);
    const task = makeTask({
      title: `[Weixin] ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`,
      prompt,
      working_dir: await resolve_working_dir(prompt, "weixin", this.db),
      schedule_type: ScheduleType.IMMEDIATE,
      tags: "weixin",
      image_paths,
      prompt_images,
      agent: resolve_agent("weixin", this.db),
    });
    const new_task_id = this.scheduler.submit_task(task);
    this._task_origin.set(new_task_id, {
      account_id,
      peer_id,
      context_token,
      message_id,
    });
    this._remember_task_source(new_task_id);
    this._set_peer_current_task(peer_key, new_task_id);
    this._reply_to_event(event, "收到，正在处理。");
  }

  async _handle_brief_command(
    command: BriefCommand,
    event: Record<string, unknown>,
    source: {
      account_id: string;
      peer_id: string;
      context_token: string;
      message_id: string;
      peer_key: string;
    },
  ): Promise<void> {
    if (command.action === "help") {
      this._reply_to_event(event, format_brief_help(command.reason));
      return;
    }
    if (!this.scheduler.handle_inbound_message) {
      this._reply_to_event(
        event,
        "❌ Task brief flow is not available in this scheduler.",
      );
      return;
    }

    const metadata = this._brief_source_metadata(source);
    const source_ref = source.message_id || source.peer_key;
    try {
      if (command.action === "create") {
        const payload = build_brief_payload({
          channel: "weixin",
          goal: command.goal,
          source_ref,
          source_metadata: metadata,
          working_dir: await resolve_working_dir(
            command.goal,
            "weixin",
            this.db,
          ),
          agent: resolve_agent("weixin", this.db),
        });
        const result = this.scheduler.handle_inbound_message(
          this._make_inbound(
            InboundMessageType.CREATE_BRIEF,
            payload,
            source.peer_id,
            metadata,
          ),
        );
        const brief_id = Number(result["brief_id"]);
        this._reply_to_event(
          event,
          format_brief_created_reply(brief_id, String(payload["title"])),
        );
        return;
      }

      if (command.action === "confirm") {
        const result = this.scheduler.handle_inbound_message(
          this._make_inbound(
            InboundMessageType.CONFIRM_BRIEF,
            { brief_id: command.brief_id },
            source.peer_id,
            metadata,
          ),
        );
        const task_id = Number(result["task_id"]);
        if (!Number.isInteger(task_id) || task_id <= 0) {
          this._reply_to_event(event, "❌ Brief confirmation failed.");
          return;
        }

        this._task_origin.set(task_id, {
          account_id: source.account_id,
          peer_id: source.peer_id,
          context_token: source.context_token,
          message_id: source.message_id,
        });
        this._remember_task_source(task_id);
        this._set_peer_current_task(source.peer_key, task_id);
        this._reply_to_event(
          event,
          format_brief_started_reply(command.brief_id, task_id),
        );
        return;
      }

      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.DISCARD_BRIEF,
          { brief_id: command.brief_id },
          source.peer_id,
          metadata,
        ),
      );
      this._reply_to_event(
        event,
        format_brief_discarded_reply(Number(result["brief_id"])),
      );
    } catch (exc) {
      this._reply_to_event(
        event,
        `❌ ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  async _handle_runbook_command(
    command: ParsedRunbookCommand,
    event: Record<string, unknown>,
    source: {
      account_id: string;
      peer_id: string;
      context_token: string;
      message_id: string;
      peer_key: string;
    },
  ): Promise<void> {
    if (!this.scheduler.handle_inbound_message) {
      this._reply_to_event(
        event,
        "❌ Runbook flow is not available in this scheduler.",
      );
      return;
    }

    const metadata = this._brief_source_metadata(source);
    const source_ref = source.message_id || source.peer_key;
    try {
      const payload = build_runbook_payload({
        channel: "weixin",
        command,
        source_ref,
        source_metadata: metadata,
        working_dir: await resolve_working_dir(
          command.raw_args || command.name,
          "weixin",
          this.db,
        ),
        agent: resolve_agent("weixin", this.db),
      });
      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.RUN_RUNBOOK,
          payload,
          source.peer_id,
          metadata,
        ),
      );
      if (result["status"] === "created") {
        const task_id = Number(result["task_id"]);
        this._task_origin.set(task_id, {
          account_id: source.account_id,
          peer_id: source.peer_id,
          context_token: source.context_token,
          message_id: source.message_id,
        });
        this._remember_task_source(task_id);
        this._set_peer_current_task(source.peer_key, task_id);
        this._reply_to_event(
          event,
          format_runbook_created_reply(task_id, command.name),
        );
        return;
      }
      if (result["status"] === "draft") {
        this._reply_to_event(
          event,
          format_runbook_brief_reply(Number(result["brief_id"]), command.name),
        );
        return;
      }
      this._reply_to_event(event, "❌ Runbook failed.");
    } catch (exc) {
      this._reply_to_event(
        event,
        `❌ ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  async _handle_skill_suggestion_command(
    command: SkillSuggestionCommand,
    event: Record<string, unknown>,
    source: {
      account_id: string;
      peer_id: string;
      context_token: string;
      message_id: string;
      peer_key: string;
    },
  ): Promise<void> {
    if (command.action === "help") {
      this._reply_to_event(
        event,
        format_skill_suggestion_help(command.reason),
      );
      return;
    }
    if (!this.scheduler.handle_inbound_message) {
      this._reply_to_event(
        event,
        "❌ Skill suggestion flow is not available in this scheduler.",
      );
      return;
    }

    const metadata = this._brief_source_metadata(source);
    try {
      const result = this.scheduler.handle_inbound_message(
        this._make_inbound(
          InboundMessageType.SKILL_SUGGESTION_ACTION,
          {
            action: command.action,
            pattern_id: command.pattern_id,
            source_channel: "weixin",
            target: source.peer_id,
            source_metadata: metadata,
          },
          source.peer_id,
          metadata,
        ),
      );
      this._reply_to_event(
        event,
        format_skill_suggestion_action_reply(result),
      );
    } catch (exc) {
      this._reply_to_event(
        event,
        `❌ ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  _brief_source_metadata(source: {
    account_id: string;
    peer_id: string;
    context_token: string;
    message_id: string;
  }): Record<string, unknown> {
    return {
      account_id: source.account_id,
      peer_id: source.peer_id,
      context_token: source.context_token,
      message_id: source.message_id,
    };
  }

  _peer_key(account_id: string, peer_id: string): string {
    return `${account_id}:${peer_id}`;
  }

  _peer_current_task_setting_key(peer_key: string): string {
    return `weixin_peer_current_task:${peer_key}`;
  }

  _get_peer_current_task(peer_key: string): number | null {
    const cached = this._peer_current_task.get(peer_key);
    if (cached !== undefined) return cached;

    const persisted = this.db.get_setting(
      this._peer_current_task_setting_key(peer_key),
      "",
    );
    if (!persisted || !/^\d+$/.test(persisted)) return null;

    const task_id = parseInt(persisted, 10);
    this._peer_current_task.set(peer_key, task_id);
    return task_id;
  }

  _set_peer_current_task(peer_key: string, task_id: number): void {
    if (!peer_key) {
      return;
    }
    this._peer_current_task.set(peer_key, task_id);
    this.db.set_setting(
      this._peer_current_task_setting_key(peer_key),
      String(task_id),
    );
  }

  _clear_peer_current_task(peer_key: string): void {
    this._peer_current_task.delete(peer_key);
    this.db.set_setting(this._peer_current_task_setting_key(peer_key), "");
  }

  _default_image_prompt(image_paths: string[]): string {
    if (image_paths.length === 1) {
      return "请分析这张图片。";
    }
    return `请分析这 ${image_paths.length} 张图片。`;
  }

  _extract_image_paths(event: Record<string, unknown>): string[] {
    const paths: string[] = [];
    const raw_paths = event["image_paths"];
    if (Array.isArray(raw_paths)) {
      for (const p of raw_paths) {
        if (p) paths.push(String(p));
      }
    }
    const raw_images = event["images"];
    if (Array.isArray(raw_images)) {
      for (const image of raw_images) {
        if (!_is_plain_object(image)) {
          continue;
        }
        const p = image["path"] || image["local_path"];
        if (p) {
          paths.push(String(p));
        }
      }
    }
    return this._dedupe_image_paths(paths);
  }

  _build_resume_updates(
    prompt: string,
    image_paths: string[],
  ): Record<string, unknown> {
    const resume_prompt = prompt || this._default_image_prompt(image_paths);
    const updates: Record<string, unknown> = {
      status: "pending",
      prompt: resume_prompt,
      result: null,
      error: null,
      question: null,
    };
    if (image_paths.length > 0) {
      updates["image_paths"] = JSON.stringify(image_paths);
      updates["prompt_images"] = JSON.stringify(
        this._build_prompt_images(image_paths),
      );
    }
    return updates;
  }

  _build_prompt_images(image_paths: string[]): PromptImage[] {
    const prompt_images: PromptImage[] = [];
    for (const image_path of image_paths) {
      let data: string;
      try {
        data = fs.readFileSync(image_path).toString("base64");
      } catch (exc) {
        console.log(
          `[Weixin] Failed to read inbound image ${image_path}: ${exc}`,
        );
        continue;
      }
      prompt_images.push({
        name: path.basename(image_path),
        media_type: this._image_media_type(image_path),
        data,
      });
    }
    return prompt_images;
  }

  _image_media_type(image_path: string): string {
    const suffix = path.extname(image_path).toLowerCase();
    if (suffix === ".png") {
      return "image/png";
    }
    if (suffix === ".jpg" || suffix === ".jpeg") {
      return "image/jpeg";
    }
    if (suffix === ".gif") {
      return "image/gif";
    }
    if (suffix === ".webp") {
      return "image/webp";
    }
    let header: Buffer;
    try {
      const fd = fs.openSync(image_path, "r");
      try {
        const buf = Buffer.alloc(12);
        const read = fs.readSync(fd, buf, 0, 12, 0);
        header = buf.subarray(0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "image/jpeg";
    }
    if (header.subarray(0, 8).equals(PNG_HEADER)) {
      return "image/png";
    }
    if (header.subarray(0, 3).equals(JPEG_HEADER)) {
      return "image/jpeg";
    }
    const gif_magic = header.subarray(0, 6).toString("latin1");
    if (gif_magic === "GIF87a" || gif_magic === "GIF89a") {
      return "image/gif";
    }
    if (
      header.subarray(0, 4).toString("latin1") === "RIFF" &&
      header.includes("WEBP")
    ) {
      return "image/webp";
    }
    return "image/jpeg";
  }

  _collect_generated_image_paths(
    task_id: number,
    content: string,
    task: Record<string, unknown> | null = null,
  ): string[] {
    const paths = this._generated_image_paths_for_task(task_id);
    paths.push(
      ...this._generated_image_paths_from_markdown(
        content,
        ((task ?? {})["working_dir"] as string | null | undefined) ?? null,
      ),
    );
    return this._dedupe_image_paths(paths);
  }

  _generated_image_paths_for_task(task_id: number): string[] {
    let runs: unknown;
    try {
      runs = this.db.get_task_runs(task_id, 1);
    } catch (exc) {
      console.log(`[Weixin] Failed to load runs for generated images: ${exc}`);
      return [];
    }
    if (!Array.isArray(runs) || runs.length === 0) {
      return [];
    }

    const first: unknown = runs[0];
    const run_id = _is_plain_object(first) ? first["id"] : null;
    if (!run_id) {
      return [];
    }
    let events: unknown;
    try {
      events = this.db.get_run_output_events(run_id as number, 1000);
    } catch (exc) {
      console.log(
        `[Weixin] Failed to load output events for generated images: ${exc}`,
      );
      return [];
    }
    if (!Array.isArray(events)) {
      return [];
    }

    const paths: string[] = [];
    for (const event of events) {
      if (
        !_is_plain_object(event) ||
        event["event_type"] !== "generated_image"
      ) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse((event["content"] as string | undefined) || "{}");
      } catch {
        continue;
      }
      const p = _is_plain_object(payload) ? payload["path"] : null;
      if (p) {
        paths.push(p as string);
      }
    }
    return paths;
  }

  _generated_image_paths_from_markdown(
    content: string,
    working_dir: string | null = null,
  ): string[] {
    const paths: string[] = [];
    for (const match of (content || "").matchAll(WEIXIN_MARKDOWN_IMAGE_RE)) {
      const image_path = this._local_image_path_from_reference(
        match[1]!,
        working_dir,
      );
      if (image_path) {
        paths.push(image_path);
      }
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
    if (target.startsWith("file://")) {
      target = _file_url_path(target);
    } else if (target.startsWith("sandbox:")) {
      target = target.slice("sandbox:".length);
    }
    target = _unquote(target).trim();
    if (!target) {
      return null;
    }

    let p = _expanduser(target);
    if (!path.isAbsolute(p) && working_dir) {
      p = path.join(_expanduser(working_dir), p);
    }
    return this._canonical_image_path(p);
  }

  _markdown_image_reference_target(reference: string): string {
    const raw = (reference || "").trim();
    if (!raw) {
      return "";
    }
    if (raw.startsWith("<")) {
      const end = raw.indexOf(">");
      if (end >= 0) {
        return raw.slice(1, end).trim();
      }
    }
    if (raw[0] === "'" || raw[0] === '"') {
      const end = raw.indexOf(raw[0]!, 1);
      if (end > 0) {
        return raw.slice(1, end).trim();
      }
    }
    const titled = /^(.+?)\s+['"][^'"]*['"]\s*$/.exec(raw);
    return (titled ? titled[1]! : raw).trim();
  }

  _dedupe_image_paths(image_paths: string[]): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const image_path of image_paths) {
      const canonical = this._canonical_image_path(image_path);
      if (!canonical || seen.has(canonical)) {
        continue;
      }
      seen.add(canonical);
      deduped.push(canonical);
    }
    return deduped;
  }

  _canonical_image_path(image_path: string): string | null {
    try {
      const p = _expanduser(image_path);
      if (
        !WEIXIN_UPLOADABLE_IMAGE_SUFFIXES.has(path.extname(p).toLowerCase())
      ) {
        return null;
      }
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) {
        return null;
      }
      return fs.realpathSync(path.resolve(p)); // ≙ Path.resolve()
    } catch {
      return null;
    }
  }

  _hide_generated_image_paths(
    content: string,
    image_count: number,
    uploaded_paths: string[] | null = null,
  ): string {
    const uploaded = new Set<string>();
    for (const p of uploaded_paths ?? []) {
      const canonical = this._canonical_image_path(p);
      if (canonical) {
        uploaded.add(canonical);
      }
    }
    const lines: string[] = [];
    for (const line of (content || "").split(/\r\n|\r|\n/)) {
      const stripped = line.trim();
      if (!stripped) {
        lines.push("");
        continue;
      }
      if (this._line_is_uploaded_image_path(stripped, uploaded)) {
        continue;
      }
      const cleaned_line = this._remove_uploaded_markdown_image_refs(
        line,
        uploaded,
      );
      const visible = cleaned_line.trim();
      if (visible && visible !== "-" && visible !== "*" && visible !== "+") {
        lines.push(cleaned_line.replace(/\s+$/, "")); // ≙ rstrip()
      }
    }
    const cleaned = lines.join("\n").trim();
    if (!cleaned || cleaned.startsWith("已生成")) {
      return `已生成 ${image_count} 张图片。`;
    }
    return cleaned;
  }

  _line_is_uploaded_image_path(
    stripped_line: string,
    uploaded_paths: Set<string>,
  ): boolean {
    if (!stripped_line.startsWith("- ")) {
      return false;
    }
    const candidate = stripped_line.slice(2).trim();
    const canonical = this._canonical_image_path(candidate);
    if (canonical && uploaded_paths.has(canonical)) {
      return true;
    }
    return stripped_line.includes("/.codex/generated_images/");
  }

  _remove_uploaded_markdown_image_refs(
    line: string,
    uploaded_paths: Set<string>,
  ): string {
    if (uploaded_paths.size === 0) {
      return line;
    }

    return line.replace(WEIXIN_MARKDOWN_IMAGE_RE, (match, ref: string) => {
      const image_path = this._local_image_path_from_reference(ref);
      const canonical = image_path
        ? this._canonical_image_path(image_path)
        : null;
      return canonical !== null && uploaded_paths.has(canonical) ? "" : match;
    });
  }

  _reply_to_event(event: Record<string, unknown>, text: string): void {
    const peer_id =
      (event["peer_id"] as string | undefined) ||
      (event["from_user_id"] as string | undefined);
    if (!peer_id) {
      return;
    }
    this._send_command({
      type: "send_message",
      account_id: (event["account_id"] as string | undefined) ?? "",
      peer_id,
      context_token: (event["context_token"] as string | undefined) ?? "",
      text,
    });
  }

  _send_command(payload: Record<string, unknown>): void {
    const proc_alive = Boolean(
      this._bridge_proc && this._bridge_proc.poll() === null,
    );
    const stdin_ok = Boolean(this._bridge_proc && this._bridge_proc.stdin);
    console.log(
      `[Weixin] _send_command: type=${payload["type"]} proc_alive=${proc_alive} stdin_ok=${stdin_ok}`,
    );
    if (!this._bridge_proc || !this._bridge_proc.stdin) {
      console.log(
        "[Weixin] _send_command: bridge not running, command dropped",
      );
      return;
    }
    this._bridge_proc.stdin.write(JSON.stringify(payload) + "\n");
    this._bridge_proc.stdin.flush?.();
  }

  request_login(): void {
    console.log("[Weixin] request_login: called");
    this._update_status({
      configured: false,
      login_status: "idle",
      qr_code_url: "",
      last_error: "",
      user_id: "",
    });
    this._send_command({ type: "login" });
  }

  request_logout(): void {
    console.log("[Weixin] request_logout: called");
    this._update_status({
      configured: false,
      login_status: "idle",
      qr_code_url: "",
      last_error: "",
      user_id: "",
    });
    this._send_command({ type: "logout" });
  }

  _update_status(updates: Partial<WeixinStatus>): void {
    for (const [k, v] of Object.entries(updates)) {
      if (v !== null && v !== undefined) {
        (this._status as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }

  get_status_snapshot(): Record<string, unknown> {
    return { ...this._status };
  }
}
