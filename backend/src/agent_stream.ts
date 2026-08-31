// Agent output-stream parsing, split out of scheduler.ts.
//
// Agent CLIs (Claude Code `--output-format stream-json`, Codex `--json`) emit
// one JSON event per stdout line. Turning those lines into the rows the UI
// renders — assistant text deltas, tool calls, traces, generated images — is
// executor-layer work: it depends only on the agent's wire format, not on
// scheduling. It lived on TaskScheduler purely because that is where the Python
// port put it.
//
// AgentStreamParser owns that translation plus the per-run delta state the
// cumulative-text protocols require. TaskScheduler holds one instance and
// forwards the method names the rest of the codebase (and the ported tests)
// already call.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskDB } from "./db.ts";
import { logger } from "./log.ts";
import { expanduser } from "./skills.ts";
import {
  GENERATED_IMAGE_MEDIA_TYPES,
  LIVE_OUTPUT_EVENT_TYPES,
  SECRET_KEY_FRAGMENTS,
} from "./types.ts";
import { errStr } from "./util.ts";

type Row = Record<string, any>;

/** ≙ the Python dict key tuple (run_id, item_id) for codex/claude delta state. */
function tupleKey(run_id: number | null, item_id: string): string {
  return JSON.stringify([run_id, item_id]);
}

/**
 * Sink for events that should also reach live-output listeners.
 * TaskScheduler passes its own `_fire_output_listeners`.
 */
export type OutputEventSink = (
  task_id: number,
  run_id: number,
  event_type: string,
  content: string,
) => void;

/** Translates agent stdout events into stored/streamed output events. */
export class AgentStreamParser {
  /** key = JSON.stringify([run_id, item_id]) */
  _codex_item_text: Map<string, string> = new Map();
  /** key = JSON.stringify([run_id, message_id]) */
  _claude_message_text: Map<string, string> = new Map();

  constructor(
    private readonly db: TaskDB,
    private readonly _fire_output_listeners: OutputEventSink,
  ) {}

  /** Return only the newly emitted text for a cumulative Codex message item. */
  _codex_text_delta(
    run_id: number | null,
    item_id: string,
    current_text: string,
  ): string | null {
    const key = tupleKey(run_id, item_id);
    const previous = this._codex_item_text.get(key) ?? "";
    this._codex_item_text.set(key, current_text);
    if (!current_text) {
      return null;
    }
    if (previous && current_text.startsWith(previous)) {
      const delta = current_text.slice(previous.length);
      return delta || null;
    }
    if (current_text === previous) {
      return null;
    }
    return current_text;
  }

  _codex_append_text_delta(
    run_id: number | null,
    item_id: string,
    delta: string,
  ): string | null {
    if (delta === "") {
      return null;
    }
    const key = tupleKey(run_id, item_id);
    this._codex_item_text.set(
      key,
      (this._codex_item_text.get(key) ?? "") + delta,
    );
    return delta;
  }

  _codex_event_delta_text(event: Row, item: Row): string | null {
    const delta = item["delta"] !== undefined ? item["delta"] : event["delta"];
    if (typeof delta === "string") {
      return delta;
    }
    if (delta && typeof delta === "object" && !Array.isArray(delta)) {
      const text = delta["text"];
      return typeof text === "string" ? text : null;
    }
    return null;
  }

  _clear_codex_run_state(run_id: number): void {
    for (const key of [...this._codex_item_text.keys()]) {
      if ((JSON.parse(key) as [number | null, string])[0] === run_id) {
        this._codex_item_text.delete(key);
      }
    }
  }

  _extract_codex_thread_id(raw_stdout: string): string | null {
    for (let line of raw_stdout.split("\n")) {
      line = line.trim();
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type === "thread.started" && event?.thread_id) {
        return String(event.thread_id);
      }
    }
    return null;
  }

  private _codex_generated_images_root(): string {
    const codex_home =
      process.env.CODEX_HOME ||
      path.join(process.env.HOME || os.homedir(), ".codex");
    return path.join(expanduser(codex_home), "generated_images");
  }

  _find_codex_generated_images(
    thread_id: string | null,
    since_timestamp: number | null = null,
  ): string[] {
    if (!thread_id) {
      return [];
    }
    const image_dir = path.join(this._codex_generated_images_root(), thread_id);
    let isDir = false;
    try {
      isDir = fs.statSync(image_dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return [];
    }
    const paths: string[] = [];
    let entries: string[];
    try {
      entries = (
        fs.readdirSync(image_dir, { recursive: true }) as Array<string | Buffer>
      ).map((e) => String(e));
    } catch {
      return [];
    }
    for (const rel of entries) {
      const p = path.join(image_dir, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      if (
        !st.isFile() ||
        GENERATED_IMAGE_MEDIA_TYPES[path.extname(p).toLowerCase()] === undefined
      ) {
        continue;
      }
      if (since_timestamp !== null) {
        if (st.mtimeMs / 1000 < since_timestamp) {
          continue;
        }
      }
      paths.push(p);
    }
    return paths.sort();
  }

  _image_media_type(image_path: string): string {
    return (
      GENERATED_IMAGE_MEDIA_TYPES[path.extname(image_path).toLowerCase()] ??
      "image/png"
    );
  }

  _extract_codex_success_output(
    raw_stdout: string,
    generated_images: string[] | null = null,
  ): string {
    let out = "";
    for (let line of raw_stdout.split("\n")) {
      line = line.trim();
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        event?.type === "item.completed" &&
        event?.item?.type === "agent_message"
      ) {
        out = event.item.text ?? "";
      }
    }

    const parts: string[] = [];
    if (out.trim()) {
      parts.push(out.trim());
    }
    if (generated_images && generated_images.length) {
      const image_lines = generated_images.map((p) => `- ${p}`).join("\n");
      parts.push(`已生成 ${generated_images.length} 张图片：\n${image_lines}`);
    }
    return parts.join("\n\n");
  }

  _store_generated_image_events(
    task_id: number,
    run_id: number,
    generated_images: string[],
  ): void {
    for (const image_path of generated_images) {
      const media_type = this._image_media_type(image_path);
      const metadata = { path: image_path, media_type };
      this._store_output_event(
        task_id,
        run_id,
        "generated_image",
        this._trace_json(metadata),
      );
      let image_data: string;
      try {
        image_data = fs.readFileSync(image_path).toString("base64");
      } catch (e) {
        logger.warning(
          `Task ${task_id}: failed to read generated image ${image_path}: ${errStr(e)}`,
        );
        continue;
      }
      this.db.add_output_event(
        task_id,
        run_id,
        "image_content",
        JSON.stringify({ ...metadata, data: image_data }),
      );
    }
  }

  /** Return newly emitted text for Claude partial/cumulative assistant messages. */
  _claude_text_delta(
    run_id: number | null,
    message_id: string,
    current_text: string,
  ): string | null {
    const key = tupleKey(run_id, message_id);
    const previous = this._claude_message_text.get(key) ?? "";
    if (!current_text) {
      return null;
    }

    if (!previous) {
      this._claude_message_text.set(key, current_text);
      return current_text;
    }

    if (current_text === previous) {
      return null;
    }

    if (current_text.startsWith(previous)) {
      this._claude_message_text.set(key, current_text);
      const delta = current_text.slice(previous.length);
      return delta || null;
    }

    // Claude can emit either cumulative partial messages or text chunks. For
    // same-message non-cumulative chunks, keep our own accumulated state.
    this._claude_message_text.set(key, previous + current_text);
    return current_text;
  }

  _claude_message_id(event: Row, run_id: number | null): string {
    const message = event["message"] ?? {};
    if (message && typeof message === "object" && !Array.isArray(message)) {
      const message_id = message["id"] || message["message_id"];
      if (message_id) {
        return String(message_id);
      }
    }
    return `assistant:${run_id}`;
  }

  _clear_claude_run_state(run_id: number): void {
    for (const key of [...this._claude_message_text.keys()]) {
      if ((JSON.parse(key) as [number | null, string])[0] === run_id) {
        this._claude_message_text.delete(key);
      }
    }
  }

  private _redact_display_payload(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this._redact_display_payload(item));
    }
    if (value && typeof value === "object") {
      const redacted: Row = {};
      for (const [key, child] of Object.entries(value)) {
        const key_str = String(key).toLowerCase();
        if (
          SECRET_KEY_FRAGMENTS.some((fragment) => key_str.includes(fragment))
        ) {
          redacted[key] = "[redacted]";
        } else {
          redacted[key] = this._redact_display_payload(child);
        }
      }
      return redacted;
    }
    return value;
  }

  private _compact_payload(payload: Row): Row {
    const out: Row = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== null && value !== undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  private _trace_json(payload: Row): string {
    return JSON.stringify(this._redact_display_payload(payload));
  }

  _content_to_display_text(content: any): string {
    if (content === null || content === undefined) {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object" && item.type === "text") {
          parts.push(item.text ?? "");
        } else if (item && typeof item === "object" && item.type === "image") {
          parts.push("[image]");
        } else {
          parts.push(JSON.stringify(this._redact_display_payload(item)));
        }
      }
      return parts.join("");
    }
    if (typeof content === "object") {
      if (content.type === "text") {
        return content.text ?? "";
      }
      return JSON.stringify(this._redact_display_payload(content));
    }
    return String(content);
  }

  private _should_stream_event(event_type: string): boolean {
    return LIVE_OUTPUT_EVENT_TYPES.has(event_type);
  }

  _store_output_event(
    task_id: number,
    run_id: number,
    event_type: string,
    content: string,
  ): void {
    if (!content) {
      return;
    }
    this.db.add_output_event(task_id, run_id, event_type, content);
    if (this._should_stream_event(event_type)) {
      this._fire_output_listeners(task_id, run_id, event_type, content);
    }
  }

  /**
   * Normalize a Codex JSONL event into (event_type, content) for storage.
   *
   * Returns (null, null) to skip events that carry no displayable content.
   */
  _parse_codex_event(
    event: Row,
    run_id: number | null = null,
  ): [string | null, string | null] {
    const etype: string = event["type"] ?? "";
    if (etype === "item.updated" || etype === "item.completed") {
      const item: Row = event["item"] ?? {};
      const itype: string = item["type"] ?? "";
      if (itype === "agent_message") {
        const item_id = String(
          item["id"] || item["item_id"] || "agent_message",
        );
        const event_delta = this._codex_event_delta_text(event, item);
        let delta: string | null;
        if (etype === "item.updated" && event_delta !== null) {
          delta = this._codex_append_text_delta(run_id, item_id, event_delta);
        } else {
          delta = this._codex_text_delta(run_id, item_id, item["text"] ?? "");
        }
        return delta !== null ? ["assistant", delta] : [null, null];
      } else if (itype === "reasoning") {
        const item_id = String(item["id"] || item["item_id"] || "reasoning");
        const event_delta = this._codex_event_delta_text(event, item);
        let text: string;
        if (etype === "item.updated" && event_delta !== null) {
          text =
            this._codex_append_text_delta(run_id, item_id, event_delta) || "";
        } else {
          text =
            this._codex_text_delta(run_id, item_id, item["text"] ?? "") || "";
        }
        return text ? ["assistant", `[thinking] ${text}`] : [null, null];
      } else if (itype === "command_execution") {
        return [
          "command_execution",
          this._trace_json(
            this._compact_payload({
              id: item["id"] ?? item["item_id"],
              command: item["command"] ?? "",
              output: item["aggregated_output"] ?? "",
              exit_code: item["exit_code"],
              status: item["status"],
            }),
          ),
        ];
      } else if (itype === "mcp_tool_call" || itype === "collab_tool_call") {
        return [
          "tool_call",
          this._trace_json(
            this._compact_payload({
              id: item["id"] ?? item["item_id"],
              server: item["server"],
              name: item["tool"] ?? item["name"],
              input: item["arguments"] ?? item["input"],
              result: item["result"],
              status: item["status"],
              error: item["error"],
            }),
          ),
        ];
      } else if (itype === "web_search") {
        return [
          "web_search",
          this._trace_json(
            this._compact_payload({
              id: item["id"] ?? item["item_id"],
              query: item["query"],
              action: item["action"],
              status: item["status"],
            }),
          ),
        ];
      } else if (itype === "file_change") {
        return [
          "file_change",
          this._trace_json(
            this._compact_payload({
              id: item["id"] ?? item["item_id"],
              changes: item["changes"],
              status: item["status"],
            }),
          ),
        ];
      } else {
        return [etype, JSON.stringify(event)];
      }
    } else if (etype === "turn.failed") {
      const err = event["error"] ?? {};
      const msg =
        err && typeof err === "object" && !Array.isArray(err)
          ? (err["message"] ?? "")
          : String(err);
      return ["error", msg];
    } else if (etype === "error") {
      return ["error", event["message"] ?? ""];
    } else if (etype === "turn.completed") {
      // turn.completed only carries usage stats; final text comes from agent_message items
      return [null, null];
    } else if (
      etype === "thread.started" ||
      etype === "turn.started" ||
      etype === "item.started"
    ) {
      return [null, null];
    } else {
      return [etype, JSON.stringify(event)];
    }
  }

  /** Parse a line from the output stream and store it as an event. */
  _parse_and_store_event(
    task_id: number,
    run_id: number,
    line: string,
    agent: string = "claude",
  ) {
    if (!line.trim()) {
      return;
    }

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      // If it's not valid JSON, store as raw text
      if (line.trim() && line.trim().length > 10) {
        // Only store meaningful non-JSON lines
        this.db.add_output_event(task_id, run_id, "text", line.trim());
      }
      return;
    }

    if (agent === "codex") {
      const [event_type, content] = this._parse_codex_event(event, run_id);
      if (event_type && content) {
        this._store_output_event(task_id, run_id, event_type, content);
      }
      return;
    }

    // Claude stream-json
    const event_type: string = event?.type ?? "unknown";
    if (event_type === "assistant") {
      const [text0, image_events, trace_events] =
        this._extract_message_content(event);
      let text_content: string | null = text0;
      if (text_content) {
        const message_id = this._claude_message_id(event, run_id);
        text_content = this._claude_text_delta(
          run_id,
          message_id,
          text_content,
        );
      }
      if (text_content) {
        this._store_output_event(task_id, run_id, event_type, text_content);
      }
      for (const img_json of image_events) {
        this.db.add_output_event(task_id, run_id, "image_content", img_json);
      }
      for (const [trace_type, trace_content] of trace_events) {
        this._store_output_event(task_id, run_id, trace_type, trace_content);
      }
    } else if (event_type === "user") {
      const [text_content, image_events, trace_events] =
        this._extract_message_content(event);
      if (text_content) {
        this.db.add_output_event(task_id, run_id, event_type, text_content);
      }
      for (const img_json of image_events) {
        this.db.add_output_event(task_id, run_id, "image_content", img_json);
      }
      for (const [trace_type, trace_content] of trace_events) {
        this._store_output_event(task_id, run_id, trace_type, trace_content);
      }
    } else {
      let content = "";
      if (event_type === "result") {
        content = event?.result ?? "";
      } else if (event_type === "error") {
        content = event?.error ?? "";
      } else {
        // For other event types, store the full JSON
        content = JSON.stringify(event);
      }

      if (content) {
        this._store_output_event(task_id, run_id, event_type, content);
      }
    }
  }

  /**
   * Extract text and image content from user/assistant messages.
   *
   * Returns (text, image_events, trace_events), where image_events and
   * trace_events contain already serialized display payloads.
   */
  private _extract_message_content(
    event: Row,
  ): [string, string[], Array<[string, string]>] {
    const message = event["message"] ?? {};
    const content = message["content"] ?? [];
    const text_parts: string[] = [];
    const image_events: string[] = [];
    const trace_events: Array<[string, string]> = [];

    for (const item of content) {
      if (typeof item === "string") {
        text_parts.push(item);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        if (item.type === "text") {
          text_parts.push(item.text ?? "");
        } else if (item.type === "image") {
          const source = item.source ?? {};
          if (source.type === "base64") {
            const img_json = JSON.stringify({
              media_type: source.media_type ?? "image/jpeg",
              data: source.data ?? "",
            });
            image_events.push(img_json);
          }
          // Non-base64 image sources (url, etc.) are ignored silently
        } else if (item.type === "tool_use") {
          trace_events.push([
            "tool_call",
            this._trace_json(
              this._compact_payload({
                id: item.id,
                name: item.name,
                input: item.input,
              }),
            ),
          ]);
        } else if (item.type === "tool_result") {
          trace_events.push([
            "tool_result",
            this._trace_json(
              this._compact_payload({
                tool_use_id: item.tool_use_id,
                content: this._content_to_display_text(item.content),
                is_error: item.is_error ?? false,
              }),
            ),
          ]);
        }
      }
    }

    return [text_parts.join(""), image_events, trace_events];
  }

  /**
   * Extract a clean, human-readable error summary from raw CLI output.
   *
   * The full raw output is already stored in run.raw_output; this produces
   * a concise message for task.error and notification channels.
   */
  _extract_error_summary(raw_stderr: string, raw_stdout: string): string {
    // If stderr is short and not JSON, it's likely a plain error message
    if (raw_stderr && raw_stderr.length < 2000) {
      const first_line = (raw_stderr.trim().split("\n")[0] ?? "").trim();
      if (first_line && !first_line.startsWith("{")) {
        return raw_stderr.trim().slice(0, 1000);
      }
    }

    // Try to parse stdout as stream-json to find error events
    const error_messages: string[] = [];
    let last_assistant_text = "";
    const source = raw_stdout ? raw_stdout : raw_stderr;
    for (let line of source.split("\n")) {
      line = line.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        const event_type = event?.type ?? "";
        if (event_type === "error") {
          const err = event.error ?? "";
          if (err) {
            error_messages.push(err);
          }
        } else if (event_type === "result") {
          if (event.subtype === "error_during_execution") {
            const err = event.error ?? event.result ?? "";
            if (err) {
              error_messages.push(String(err));
            }
          }
        } else if (event_type === "assistant") {
          const msg = event.message ?? {};
          const content = msg.content ?? [];
          const text_parts: string[] = [];
          for (const c of content) {
            if (typeof c === "string") {
              text_parts.push(c);
            } else if (c && typeof c === "object" && c.type === "text") {
              text_parts.push(c.text ?? "");
            }
          }
          if (text_parts.length) {
            last_assistant_text = text_parts.join("");
          }
        }
      } catch {
        // not JSON — keep scanning
      }
    }

    if (error_messages.length) {
      return error_messages.join("\n").slice(0, 1000);
    }

    if (last_assistant_text) {
      return last_assistant_text.slice(0, 1000);
    }

    // Fall back to raw stderr or first 500 chars of stdout
    return (raw_stderr || raw_stdout || "Unknown error").trim().slice(0, 500);
  }
}
