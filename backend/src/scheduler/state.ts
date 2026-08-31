// Scheduler state: every field the scheduler modules share, the constructor,
// task submission/completion bookkeeping, listener plumbing, and the thin
// forwarders onto AgentStreamParser.
//
// This is the bottom of the mixin chain, so it is also where the shared
// mutable state lives; the mixins above it only add behaviour.

import os from "node:os";
import path from "node:path";
import { BusAwareSchedulerMixin, type MessageBus } from "../bus.ts";
import type { TaskDB } from "../db.ts";
import { AgentExecutor, type PopenFn, default_popen } from "../executor.ts";
import { AgentStreamParser } from "../agent_stream.ts";
import { logger } from "../log.ts";
import { ScheduleType, type Task, TaskStatus } from "../types.ts";
import { errStr, normalizeDatetimeForStorage } from "../util.ts";
import {
  type ActiveHandle,
  type ChannelLike,
  type DependsOn,
  type OsOps,
  type OutputListener,
  type Row,
  cron_next_iso,
  default_os,
  sleepSeconds,
} from "./shared.ts";

/**
 * Methods supplied by mixins further up the chain. Declared here (via
 * interface merging, which emits nothing) so a lower module can call a
 * higher one without importing it — these five are the only such calls.
 */
export interface SchedulerSeams {
  _run_agent_prompt_once(
    agent: string,
    prompt: string,
    working_dir: string,
  ): Promise<[boolean, string]>;
  _run_agent_command(
    agent: string,
    cmd: string[],
    working_dir_expanded: string,
    on_stdout_line?: ((line: string) => void) | null,
    on_stderr_line?: ((line: string) => void) | null,
  ): Promise<[boolean, string]>;
  approve_skill(
    pattern_id: number,
    name: string,
    description: string,
    body: string,
  ): Row | null;
  dismiss_skill_pattern(pattern_id: number): void;
  trigger_skill_draft(pattern_id: number, agent?: string | null): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SchedulerState extends SchedulerSeams {}

export class SchedulerState extends BusAwareSchedulerMixin {
  db: TaskDB;
  executor: AgentExecutor;
  on_task_update: ((task_id: number) => void) | null;
  _channels: ChannelLike[] = []; // generic Channel instances (e.g. TelegramChannel)
  _output_event_listeners: OutputListener[] = []; // callables(task_id, run_id, event_type, content)
  _running = false;
  _shutting_down = false;
  _loop_promise: Promise<void> | null = null; // ≙ self._thread
  _active_tasks: Map<number, ActiveHandle> = new Map();
  _active_heartbeats: Map<number, ActiveHandle> = new Map();
  _live_output: Map<number, string> = new Map(); // task_id -> accumulated stdout
  _live_heartbeat_output: Map<number, string> = new Map(); // tick_id -> accumulated stdout/stderr
  _active_pgids: Map<number, number> = new Map(); // task_id -> process group id
  /** Owns agent stream parsing + the per-run delta state it needs. */
  _stream: AgentStreamParser;
  /** Codex per-item accumulated text (owned by `_stream`). */
  get _codex_item_text(): Map<string, string> {
    return this._stream._codex_item_text;
  }
  /** Claude per-message accumulated text (owned by `_stream`). */
  get _claude_message_text(): Map<string, string> {
    return this._stream._claude_message_text;
  }
  // Skill Library sweep state (manual + scheduled share this guard)
  _skill_sweep_running = false;
  _last_skill_sweep: Row | null = null;

  // ── injectable seams (≙ pytest monkeypatching) ────────────────────────
  /** ≙ subprocess.Popen */
  _popen: PopenFn = default_popen;
  /** ≙ os.getpgid / os.killpg / os.kill */
  _os: OsOps = default_os;
  /** ≙ time.sleep */
  _sleep: (seconds: number) => Promise<void> = sleepSeconds;

  readonly SKILL_SWEEP_RUN_LIMIT = 50;

  constructor(
    db: TaskDB,
    on_task_update: ((task_id: number) => void) | null = null,
    bus: MessageBus | null = null,
  ) {
    super();
    this.db = db;
    this._stream = new AgentStreamParser(db, (t, r, event_type, content) =>
      this._fire_output_listeners(t, r, event_type, content),
    );
    this.executor = new AgentExecutor();
    this.on_task_update = on_task_update;
    this.bus = bus; // MessageBus integration (optional)
  }

  _notify(task_id: number): void {
    if (this.on_task_update) {
      this.on_task_update(task_id);
    }
    for (const ch of this._channels) {
      // ≙ a daemon thread per channel notify
      setTimeout(() => {
        try {
          ch.notify_task(task_id);
        } catch (e) {
          logger.error(`Channel notify error: ${errStr(e)}`);
        }
      }, 0);
    }
    // Publish to MessageBus (non-blocking; subscribers notified synchronously)
    this._bus_notify(task_id);
  }

  /** Fire all registered output listeners (non-blocking; errors are swallowed). */
  _fire_output_listeners(
    task_id: number,
    run_id: number,
    event_type: string,
    content: string,
  ): void {
    const listeners = [...this._output_event_listeners];
    for (const cb of listeners) {
      try {
        cb(task_id, run_id, event_type, content);
      } catch (e) {
        logger.error(`Output listener error: ${errStr(e)}`);
      }
    }
  }

  /**
   * Register a callback invoked for each assistant output event.
   *
   * Signature: cb(task_id: int, run_id: int, event_type: str, content: str)
   * Called from the task execution path — must be non-blocking.
   */
  add_output_listener(cb: OutputListener): void {
    this._output_event_listeners.push(cb);
  }

  remove_output_listener(cb: OutputListener): void {
    const idx = this._output_event_listeners.indexOf(cb);
    if (idx !== -1) {
      this._output_event_listeners.splice(idx, 1);
    }
  }

  /**
   * Add and schedule a new task.
   *
   * depends_on: list of dicts [{task_id, inject_result}] or list of ints.
   * If any upstream task is not yet completed, the task starts as BLOCKED.
   */
  submit_task(task: Task, depends_on: DependsOn[] | null = null): number {
    const now = new Date();

    // Resolve depends_on to normalized list
    const dep_list: Array<{ task_id: number; inject_result: boolean }> = [];
    if (depends_on) {
      for (const dep of depends_on) {
        if (typeof dep === "number") {
          dep_list.push({ task_id: dep, inject_result: false });
        } else if (dep && typeof dep === "object") {
          dep_list.push({
            task_id: dep.task_id,
            inject_result: Boolean(dep.inject_result ?? false),
          });
        }
      }
    }

    // Determine initial status: BLOCKED if any upstream not completed
    let has_unmet = false;
    if (dep_list.length) {
      for (const dep of dep_list) {
        const upstream = this.db.get_task(dep.task_id);
        if (!upstream || upstream["status"] !== "completed") {
          has_unmet = true;
          break;
        }
      }
    }

    if (has_unmet) {
      task.status = TaskStatus.BLOCKED;
    } else if (task.schedule_type === ScheduleType.IMMEDIATE) {
      task.status = TaskStatus.PENDING;
    } else if (task.schedule_type === ScheduleType.DELAYED) {
      task.status = TaskStatus.PENDING;
    } else if (task.schedule_type === ScheduleType.SCHEDULED_AT) {
      task.status = TaskStatus.SCHEDULED;
      if (!task.next_run_at) {
        throw new Error("scheduled_at requires next_run_at to be set");
      }
      task.next_run_at = normalizeDatetimeForStorage(task.next_run_at);
    } else if (task.schedule_type === ScheduleType.CRON) {
      task.status = TaskStatus.SCHEDULED;
      if (task.cron_expr) {
        task.next_run_at = cron_next_iso(task.cron_expr, now);
      }
    }

    const task_id = this.db.add_task(task);

    // Store dependency rows atomically — if any insert fails the whole
    // batch is rolled back so we never leave a task with partial deps.
    if (dep_list.length) {
      this.db.add_dependencies_batch(task_id, dep_list);
    }

    return task_id;
  }

  // ──────────────────────── DAG helpers ────────────────────────

  /** Prepend upstream results to the prompt for deps with inject_result=True. */
  _build_injected_prompt(task: Row): string {
    const deps = this.db.get_dependencies(task["id"]);
    const injections: string[] = [];
    for (const dep of deps) {
      if (dep["inject_result"]) {
        const upstream = this.db.get_task(dep["depends_on_task_id"]);
        if (upstream && upstream["result"]) {
          injections.push(
            `=== Result from upstream task #${upstream["id"]} (${upstream["title"]}) ===\n` +
              `${upstream["result"]}\n` +
              `=== End of upstream result ===`,
          );
        }
      }
    }
    if (injections.length) {
      return injections.join("\n\n") + "\n\n---\n\n" + task["prompt"];
    }
    return task["prompt"];
  }

  /** Check whether any blocked downstream tasks can now be unblocked. */
  _on_task_completed(task_id: number): void {
    const dependents = this.db.get_dependents(task_id);
    for (const dep of dependents) {
      const downstream_id = dep["task_id"];
      if (dep["task_status"] !== "blocked") {
        continue;
      }
      // Check all upstream deps of this downstream task
      const all_deps = this.db.get_dependencies(downstream_id);
      if (all_deps.every((d) => d["depends_on_status"] === "completed")) {
        // All upstream done — unblock
        const downstream = this.db.get_task(downstream_id);
        if (!downstream) {
          continue;
        }
        // Determine next status based on schedule_type
        const stype = downstream["schedule_type"] ?? "immediate";
        let new_status: string;
        if (stype === "immediate") {
          new_status = "pending";
        } else if (stype === "delayed") {
          new_status = "pending";
        } else if (stype === "scheduled_at") {
          new_status = "scheduled";
        } else if (stype === "cron") {
          new_status = "scheduled";
        } else {
          new_status = "pending";
        }
        this.db.update_task(downstream_id, { status: new_status });
        logger.info(`DAG: Task ${downstream_id} unblocked (all upstream done)`);
        this._notify(downstream_id);
      }
    }
  }

  /** Cascade-cancel all blocked downstream tasks recursively. */
  _on_task_failed(task_id: number): void {
    const to_cancel: Array<[number, number]> = [];
    const visited = new Set<number>();
    const queue: number[] = [task_id];
    while (queue.length) {
      const current = queue.pop()!;
      for (const dep of this.db.get_dependents(current)) {
        const downstream_id = dep["task_id"];
        if (visited.has(downstream_id)) {
          continue;
        }
        visited.add(downstream_id);
        const task_status = dep["task_status"];
        if (["blocked", "pending", "scheduled"].includes(task_status)) {
          to_cancel.push([downstream_id, task_id]);
          queue.push(downstream_id);
        }
      }
    }
    for (const [downstream_id, origin_id] of to_cancel) {
      this.db.update_task(downstream_id, {
        status: "cancelled",
        error: `Cancelled: upstream task #${origin_id} failed`,
      });
      logger.info(
        `DAG: Task ${downstream_id} cascade-cancelled (upstream #${origin_id} failed)`,
      );
      this._notify(downstream_id);
    }
  }

  // ── agent output-stream parsing ───────────────────────────────────────
  //
  // Implementations live in agent_stream.ts. These forwarders keep the method
  // names the rest of the backend and the ported tests already call.

  _codex_text_delta(
    run_id: number | null,
    item_id: string,
    current_text: string,
  ): string | null {
    return this._stream._codex_text_delta(run_id, item_id, current_text);
  }

  _codex_append_text_delta(
    run_id: number | null,
    item_id: string,
    delta: string,
  ): string | null {
    return this._stream._codex_append_text_delta(run_id, item_id, delta);
  }

  _codex_event_delta_text(event: Row, item: Row): string | null {
    return this._stream._codex_event_delta_text(event, item);
  }

  _clear_codex_run_state(run_id: number): void {
    this._stream._clear_codex_run_state(run_id);
  }

  _extract_codex_thread_id(raw_stdout: string): string | null {
    return this._stream._extract_codex_thread_id(raw_stdout);
  }

  _find_codex_generated_images(
    thread_id: string | null,
    since_timestamp: number | null = null,
  ): string[] {
    return this._stream._find_codex_generated_images(
      thread_id,
      since_timestamp,
    );
  }

  _image_media_type(image_path: string): string {
    return this._stream._image_media_type(image_path);
  }

  _extract_codex_success_output(
    raw_stdout: string,
    generated_images: string[] | null = null,
  ): string {
    return this._stream._extract_codex_success_output(
      raw_stdout,
      generated_images,
    );
  }

  _store_generated_image_events(
    task_id: number,
    run_id: number,
    generated_images: string[],
  ): void {
    this._stream._store_generated_image_events(
      task_id,
      run_id,
      generated_images,
    );
  }

  _claude_text_delta(
    run_id: number | null,
    message_id: string,
    current_text: string,
  ): string | null {
    return this._stream._claude_text_delta(run_id, message_id, current_text);
  }

  _claude_message_id(event: Row, run_id: number | null): string {
    return this._stream._claude_message_id(event, run_id);
  }

  _clear_claude_run_state(run_id: number): void {
    this._stream._clear_claude_run_state(run_id);
  }

  _content_to_display_text(content: any): string {
    return this._stream._content_to_display_text(content);
  }

  _store_output_event(
    task_id: number,
    run_id: number,
    event_type: string,
    content: string,
  ): void {
    this._stream._store_output_event(task_id, run_id, event_type, content);
  }

  _parse_codex_event(
    event: Row,
    run_id: number | null = null,
  ): [string | null, string | null] {
    return this._stream._parse_codex_event(event, run_id);
  }

  /** Parse a line from the output stream and store it as an event. */
  _parse_and_store_event(
    task_id: number,
    run_id: number,
    line: string,
    agent: string = "claude",
  ): void {
    this._stream._parse_and_store_event(task_id, run_id, line, agent);
  }

  _extract_error_summary(raw_stderr: string, raw_stdout: string): string {
    return this._stream._extract_error_summary(raw_stderr, raw_stdout);
  }
}
