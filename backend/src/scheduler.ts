// TaskScheduler, ported from taskboard.py (class TaskScheduler, lines 1787-3798).
//
// Method names, prompts, error messages and JSON keys are kept byte-identical
// to the Python source — tests assert on them. Python's per-task/heartbeat
// threads become async functions; the injectable seams (`_popen`, `_os`,
// `_sleep`, `AgentExecutor.subprocess_run`) replace the pytest monkeypatching
// of `taskboard.subprocess.*` / `taskboard.os.*` / `taskboard.time.sleep`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import {
  BusAwareSchedulerMixin,
  OutboundMessageType,
  type MessageBus,
} from "./bus.ts";
import type { TaskDB } from "./db.ts";
import {
  AgentExecutor,
  FileNotFoundError,
  OSError,
  PIPE,
  ProcessLookupError,
  TimeoutExpired,
  default_popen,
  type PopenFn,
  type PopenLike,
} from "./executor.ts";
import { logger } from "./log.ts";
import {
  _skill_creator_dir,
  _sanitize_skill_name,
  _compose_skill_md,
} from "./skills.ts";
import {
  _parse_skill_frontmatter,
  expanduser,
  link_skill,
  remove_skill_from_disk,
  unlink_skill,
  write_skill_to_disk,
} from "./skills.ts";
import {
  CLAUDE_STREAM_JSON_ARGS,
  DEFAULT_AGENT,
  DEFAULT_TIMEOUT_SECONDS,
  GENERATED_IMAGE_MEDIA_TYPES,
  HeartbeatDecisionType,
  LIVE_OUTPUT_EVENT_TYPES,
  ScheduleType,
  SECRET_KEY_FRAGMENTS,
  TaskStatus,
  makeHeartbeat,
  type Task,
} from "./types.ts";
import {
  getEnv,
  dateToLocalIso,
  normalizeDatetimeForStorage,
  nowIso,
  parseComparableDatetime,
  parseJsonObject,
} from "./util.ts";

type Row = Record<string, any>;

// ── small helpers ────────────────────────────────────────────────────────────

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Await a promise but give up after `seconds` (≙ Thread.join(timeout=...)). */
async function joinWithTimeout(
  p: Promise<unknown>,
  seconds: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, seconds * 1000);
  });
  try {
    await Promise.race([p.catch(() => {}), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** ≙ croniter.is_valid(expr) */
function croniter_is_valid(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/** ≙ croniter(expr, base).get_next(datetime).isoformat() (local-naive storage) */
function cron_next_iso(expr: string, base: Date): string {
  return dateToLocalIso(
    CronExpressionParser.parse(expr, { currentDate: base }).next().toDate(),
  );
}

/** ≙ the Python dict key tuple (run_id, item_id) for codex/claude delta state. */
function tupleKey(run_id: number | null, item_id: string): string {
  return JSON.stringify([run_id, item_id]);
}

/** ≙ os.path.realpath (non-strict: resolves as far as possible, never throws). */
function realpathNonStrict(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

const _int = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};

// ── injectable os seam (≙ monkeypatching taskboard.os.getpgid/killpg) ───────

export interface OsOps {
  getpgid(pid: number): number;
  killpg(pgid: number, sig: number | NodeJS.Signals): void;
  kill(pid: number, sig: number | NodeJS.Signals): void;
}

function mapKillError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ESRCH") return new ProcessLookupError(errStr(e));
  if (code === "EPERM") return new OSError(errStr(e));
  return e instanceof Error ? e : new OSError(String(e));
}

export const default_os: OsOps = {
  // start_new_session=True makes the child its own process-group leader,
  // so the group id equals the child pid (≙ os.getpgid for our children).
  getpgid(pid: number): number {
    return pid;
  },
  killpg(pgid: number, sig: number | NodeJS.Signals): void {
    try {
      process.kill(-pgid, sig);
    } catch (e) {
      throw mapKillError(e);
    }
  },
  kill(pid: number, sig: number | NodeJS.Signals): void {
    try {
      process.kill(pid, sig);
    } catch (e) {
      throw mapKillError(e);
    }
  },
};

// ── scheduler types ──────────────────────────────────────────────────────────

/** ≙ the threading.Thread handles stored in _active_tasks/_active_heartbeats. */
export interface ActiveHandle {
  is_alive(): boolean;
  promise?: Promise<void> | null;
}

export type OutputListener = (
  task_id: number,
  run_id: number,
  event_type: string,
  content: string,
) => void;

export interface ChannelLike {
  notify_task(task_id: number): void;
}

export type DependsOn = number | { task_id: number; inject_result?: unknown };

/** Background scheduler that checks and runs due tasks. */
export class TaskScheduler extends BusAwareSchedulerMixin {
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
  _codex_item_text: Map<string, string> = new Map(); // key = JSON.stringify([run_id, item_id])
  _claude_message_text: Map<string, string> = new Map(); // key = JSON.stringify([run_id, message_id])
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
    this.executor = new AgentExecutor();
    this.on_task_update = on_task_update;
    this.bus = bus; // MessageBus integration (optional)
  }

  start(): void {
    this._running = true;
    this._loop_promise = this._loop();
    logger.info("Scheduler started");
  }

  async stop(): Promise<void> {
    this._shutting_down = true;
    this._running = false;
    if (this._loop_promise) {
      await joinWithTimeout(this._loop_promise, 5);
    }
    // Wait up to 5 seconds for running tasks to finish
    let deadline = Date.now() / 1000 + 5;
    const running = [...this._active_tasks.entries()].filter(([, t]) =>
      t.is_alive(),
    );
    if (running.length) {
      logger.info(`Waiting for ${running.length} running task(s) to finish...`);
      for (const [, t] of running) {
        const remaining = Math.max(0, deadline - Date.now() / 1000);
        if (t.promise) await joinWithTimeout(t.promise, remaining);
      }
    }
    const heartbeat_running = [...this._active_heartbeats.entries()].filter(
      ([, t]) => t.is_alive(),
    );
    if (heartbeat_running.length) {
      logger.info(
        `Waiting for ${heartbeat_running.length} heartbeat(s) to finish...`,
      );
      for (const [, t] of heartbeat_running) {
        const remaining = Math.max(0, deadline - Date.now() / 1000);
        if (t.promise) await joinWithTimeout(t.promise, remaining);
      }
    }
    // Gracefully terminate any processes still alive, then force-kill if needed
    for (const [tid, pgid] of [...this._active_pgids.entries()]) {
      try {
        this._os.killpg(pgid, "SIGTERM");
        logger.info(`Sent SIGTERM to task ${tid} (pgid ${pgid})`);
      } catch (e) {
        if (e instanceof OSError) continue;
        throw e;
      }
      // Wait up to 5 seconds for the process group to exit
      deadline = Date.now() / 1000 + 5;
      let gone = false;
      while (Date.now() / 1000 < deadline) {
        try {
          this._os.killpg(pgid, 0); // check if still alive
        } catch (e) {
          if (e instanceof OSError) {
            gone = true; // process group is gone
            break;
          }
          throw e;
        }
        await this._sleep(0.1);
      }
      if (!gone) {
        // Still alive — escalate to SIGKILL
        logger.warning(
          `Force-killing task ${tid} (pgid ${pgid}) after SIGTERM timeout`,
        );
        try {
          this._os.killpg(pgid, "SIGKILL");
        } catch (e) {
          logger.error(`killpg(${pgid}) SIGKILL failed: ${errStr(e)}`);
        }
      }
    }
    logger.info("Scheduler stopped");
  }

  async _loop(): Promise<void> {
    while (this._running) {
      try {
        this._tick();
      } catch (e) {
        logger.error(`Scheduler error: ${errStr(e)}`);
      }
      await this._sleep(2); // check every 2 seconds
    }
  }

  _tick(): void {
    if (this._shutting_down) {
      return;
    }
    const due_tasks = this.db.get_due_tasks();
    for (const task of due_tasks) {
      const tid = task["id"];
      const handle = this._active_tasks.get(tid);
      if (handle && handle.is_alive()) {
        continue; // already running
      }
      // Check if it's time
      if (
        task["schedule_type"] === "immediate" &&
        task["status"] === "pending"
      ) {
        this._spawn_task(task);
      } else if (
        task["schedule_type"] === "delayed" &&
        task["status"] === "pending"
      ) {
        this._schedule_delayed(task);
      } else if (
        task["schedule_type"] === "delayed" &&
        task["status"] === "scheduled"
      ) {
        const nra = task["next_run_at"];
        const run_at = nra ? parseComparableDatetime(nra) : null;
        if (run_at && run_at.getTime() <= Date.now()) {
          this._spawn_task(task);
        }
      } else if (
        task["schedule_type"] === "scheduled_at" &&
        task["status"] === "scheduled"
      ) {
        const nra = task["next_run_at"];
        const run_at = nra ? parseComparableDatetime(nra) : null;
        if (run_at && run_at.getTime() <= Date.now()) {
          this._spawn_task(task);
        }
      } else if (
        task["schedule_type"] === "cron" &&
        task["status"] === "scheduled"
      ) {
        const nra = task["next_run_at"];
        const run_at = nra ? parseComparableDatetime(nra) : null;
        if (run_at && run_at.getTime() <= Date.now()) {
          this._spawn_task(task);
        }
      }
    }
    const due_heartbeats = this.db.get_due_heartbeats();
    for (const heartbeat of due_heartbeats) {
      const hid = heartbeat["id"];
      const handle = this._active_heartbeats.get(hid);
      if (handle && handle.is_alive()) {
        continue;
      }
      this._spawn_heartbeat(heartbeat);
    }
    this._maybe_run_scheduled_sweep();
  }

  /**
   * Built-in "skill-distiller": cron-driven auto sweep, gated by the toggle.
   *
   * Gated by skill_library_enabled (default OFF). Agent + cadence come from
   * skill_sweep_agent / skill_sweep_cron. The manual button bypasses this
   * entirely. When disabled, returns immediately — never calls an agent.
   */
  _maybe_run_scheduled_sweep(): void {
    if (
      !["1", "true", "True"].includes(
        this.db.get_setting("skill_library_enabled", "0") ?? "",
      )
    ) {
      return;
    }
    const cron = this.db.get_setting("skill_sweep_cron", "0 3 * * *");
    if (!cron || !croniter_is_valid(cron)) {
      return;
    }
    const now = new Date();
    const next_run_raw = this.db.get_setting("skill_sweep_next_run", "");
    if (!next_run_raw) {
      // First tick after enabling: schedule forward, don't run immediately.
      this.db.set_setting("skill_sweep_next_run", cron_next_iso(cron, now));
      return;
    }
    let next_run: Date | null;
    try {
      next_run = parseComparableDatetime(next_run_raw);
    } catch {
      next_run = null;
    }
    if (next_run === null || next_run.getTime() <= now.getTime()) {
      this.trigger_skill_sweep(this.db.get_setting("skill_sweep_agent", null));
      this.db.set_setting("skill_sweep_next_run", cron_next_iso(cron, now));
    }
  }

  _schedule_delayed(task: Row): void {
    const delay = task["delay_seconds"] || 0;
    const run_at = new Date(Date.now() + delay * 1000);
    this.db.update_task(task["id"], {
      status: "scheduled",
      next_run_at: dateToLocalIso(run_at),
    });
    this._notify(task["id"]);
  }

  _spawn_heartbeat(heartbeat: Row): void {
    let alive = true;
    const handle: ActiveHandle = { is_alive: () => alive, promise: null };
    this._active_heartbeats.set(heartbeat["id"], handle);
    handle.promise = (async () => {
      try {
        await this._execute_heartbeat(heartbeat);
      } catch (e) {
        logger.error(`Heartbeat ${heartbeat["id"]} thread error: ${errStr(e)}`);
      } finally {
        alive = false;
      }
    })();
  }

  _spawn_task(task: Row): void {
    // Register the handle in _active_tasks *before* updating the DB so
    // that if the run crashes immediately after the DB write, the task
    // is still visible in _active_tasks and won't be re-picked by _tick().
    let alive = true;
    const handle: ActiveHandle = { is_alive: () => alive, promise: null };
    this._active_tasks.set(task["id"], handle);
    this.db.update_task(task["id"], { status: "running" });
    handle.promise = (async () => {
      try {
        await this._execute_task(task);
      } catch (e) {
        logger.error(`Task ${task["id"]} thread error: ${errStr(e)}`);
      } finally {
        alive = false;
      }
    })();
  }

  _render_heartbeat_check_prompt(heartbeat: Row): string {
    const lines = [
      "You are AgentForge heartbeat decision engine.",
      "Return JSON only. No markdown, no explanation, no code fences.",
      "JSON schema:",
      '{"decision":"idle|trigger_task|error","reason":"string","dedupe_key":"string","title":"string","prompt":"string","metadata":{}}',
      "",
      `Heartbeat name: ${heartbeat["name"]}`,
      `Working directory: ${heartbeat["working_dir"]}`,
      `Current time: ${nowIso()}`,
      `Last tick at: ${heartbeat["last_tick_at"] || ""}`,
      `Last decision: ${heartbeat["last_decision"] || ""}`,
      `Last triggered at: ${heartbeat["last_triggered_at"] || ""}`,
      `Last dedupe key: ${heartbeat["last_dedupe_key"] || ""}`,
      "",
      "User-defined check instructions:",
      heartbeat["check_prompt"],
    ];
    if (heartbeat["action_prompt_template"]) {
      lines.push(
        "",
        "When decision is trigger_task, use this action prompt template as the base prompt to expand or adapt:",
        heartbeat["action_prompt_template"],
      );
    }
    return lines.join("\n");
  }

  _parse_heartbeat_decision(raw_text: string): Row {
    let text = raw_text.trim();
    if (text.startsWith("```")) {
      text = text
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith("```"))
        .join("\n")
        .trim();
    }
    if (!text.startsWith("{")) {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        text = text.slice(start, end + 1);
      }
    }
    const payload = JSON.parse(text) as Row;
    const decision = payload["decision"];
    if (
      !(Object.values(HeartbeatDecisionType) as string[]).includes(decision)
    ) {
      throw new Error(`Invalid heartbeat decision: ${decision}`);
    }
    const normalized: Row = {
      decision,
      reason: String(payload["reason"] ?? ""),
      dedupe_key: String(payload["dedupe_key"] ?? ""),
      title: String(payload["title"] ?? ""),
      prompt: String(payload["prompt"] ?? ""),
      metadata: payload["metadata"] || {},
    };
    if (
      typeof normalized["metadata"] !== "object" ||
      normalized["metadata"] === null ||
      Array.isArray(normalized["metadata"])
    ) {
      throw new Error("Heartbeat decision metadata must be an object");
    }
    return normalized;
  }

  // ── Skill Library: cross-run sweep ─────────────────────────────────────

  /**
   * Synchronous sweep core (tested directly).
   *
   * full=false (scheduled): only runs since the watermark — incremental, cheap.
   * full=true (manual button): re-scans the most recent completed runs ignoring
   * the watermark, so the button always analyzes something. Counting is
   * idempotent per run_id, so re-scanning never inflates recurrence counts.
   */
  async run_skill_sweep(
    agent: string | null = null,
    full: boolean = false,
  ): Promise<Row> {
    agent =
      agent ||
      this.db.get_setting("skill_sweep_agent", null) ||
      this.db.get_setting("default_agent", DEFAULT_AGENT);
    const watermark = this.db.get_setting("skill_sweep_watermark", "") || "";
    let runs: Row[];
    if (full) {
      runs = this.db.get_recent_completed_runs(this.SKILL_SWEEP_RUN_LIMIT);
    } else {
      runs = this.db.get_completed_runs_since(
        watermark,
        this.SKILL_SWEEP_RUN_LIMIT,
      );
    }
    if (!runs.length) {
      const result: Row = {
        scanned: 0,
        detected: 0,
        new: 0,
        candidates: 0,
        watermark,
        agent,
        full,
      };
      this._last_skill_sweep = result;
      return result;
    }

    const existing = this.db.get_skill_patterns();
    const prompt = this._build_sweep_prompt(runs, existing);
    const [ok, raw] = await this._run_agent_prompt_once(agent!, prompt, ".");
    if (!ok) {
      throw new Error(raw || "skill sweep agent failed");
    }

    let detected = 0;
    let new_occurrences = 0;
    for (const item of TaskScheduler._parse_sweep_output(raw)) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        continue;
      }
      const it = item as Row;
      const tid = _int(it["task_id"]);
      const rid = _int(it["run_id"]);
      const before = this.db.get_skill_pattern_recurrence(
        it["pattern_key"] ?? "",
      );
      const pid = this.db.upsert_skill_pattern(
        it["pattern_key"] ?? "",
        it["kind"] ?? "recipe",
        String(it["summary"] ?? ""),
        tid,
        rid,
      );
      if (pid !== null) {
        detected += 1;
        const after = this.db.get_skill_pattern_recurrence(
          it["pattern_key"] ?? "",
        );
        if (after > before) {
          new_occurrences += 1;
        }
      }
    }

    const finished = runs
      .map((r) => r["finished_at"])
      .filter(Boolean) as string[];
    const new_watermark = finished.length
      ? finished.reduce((a, b) => (a > b ? a : b))
      : watermark;
    if (new_watermark && new_watermark > watermark) {
      this.db.set_setting("skill_sweep_watermark", new_watermark);
    }
    const candidates = this.db.refresh_skill_candidates();
    const result: Row = {
      scanned: runs.length,
      detected,
      new: new_occurrences,
      candidates,
      watermark: new_watermark,
      agent,
      full,
    };
    this._last_skill_sweep = result;
    return result;
  }

  /**
   * Start a sweep in the background. Returns false if one is already running.
   *
   * The HTTP server is single-threaded, so a sweep (which can take minutes)
   * must not block the request thread.
   */
  trigger_skill_sweep(
    agent: string | null = null,
    full: boolean = false,
  ): boolean {
    if (this._skill_sweep_running) {
      return false;
    }
    this._skill_sweep_running = true;

    void (async () => {
      try {
        await this.run_skill_sweep(agent, full);
      } catch (e) {
        // surface to status, never crash the worker
        logger.error(`Skill sweep failed: ${errStr(e)}`);
        this._last_skill_sweep = { error: errStr(e) };
      } finally {
        this._skill_sweep_running = false;
      }
    })();
    return true;
  }

  skill_sweep_status(): { running: boolean; last: Row | null } {
    return { running: this._skill_sweep_running, last: this._last_skill_sweep };
  }

  // ── Skill Library: distillation / approval ─────────────────────────────
  _build_distill_context(tids: number[]): string {
    const blocks: string[] = [];
    for (const tid of tids.slice(0, 5)) {
      const task = this.db.get_task(tid);
      if (!task) {
        continue;
      }
      const runs = this.db.get_task_runs(tid, 1);
      const result: string = (runs.length ? runs[0]!["result"] : "") || "";
      blocks.push(
        `[task #${tid}] ${task["title"] || "Untitled"}\n` +
          `  prompt: ${String(task["prompt"] || "")
            .trim()
            .slice(0, 600)}\n` +
          `  result: ${result.trim().slice(0, 600)}`,
      );
    }
    return blocks.join("\n\n");
  }

  _build_distill_prompt(
    pattern: Row,
    context: string,
    skill_creator_rel: string | null = null,
  ): string {
    const kind = pattern["kind"] ?? "recipe";
    let header: string;
    if (skill_creator_rel) {
      header =
        "You are creating a reusable Claude Code skill from a recurring task pattern. " +
        "You MUST author it USING the skill-creator skill, whose full authoring guidance " +
        "is on disk in this working directory at:\n" +
        `  ${skill_creator_rel}\n` +
        "Read that file first and follow its conventions for skill structure, the " +
        "description (triggering accuracy), progressive disclosure, and body style. " +
        "Do NOT run any of skill-creator's scripts, do NOT scaffold a directory on disk, " +
        "do NOT run evals or package anything — your ONLY output is the JSON described " +
        "below.\n\n";
    } else {
      header =
        "You are creating a reusable Claude Code skill from a recurring task pattern, " +
        "following Anthropic's skill-creator conventions (concise description that states " +
        "what AND when with concrete triggers; imperative body that explains why; " +
        "progressive disclosure; well under 500 lines).\n\n";
    }
    return (
      header +
      `Pattern key: ${pattern["pattern_key"]}\n` +
      `Kind: ${kind}\n` +
      `Summary: ${pattern["summary"] ?? ""}\n` +
      `Observed ${pattern["recurrence_count"] ?? 0} times across these task runs:\n\n` +
      `${context}\n\n` +
      "STEP 1 — Decide if a skill is genuinely warranted. A skill IS warranted when the " +
      "pattern is one of:\n" +
      "  - a repeatable, multi-step workflow run many times across different inputs;\n" +
      "  - produces an objectively verifiable output (file transform, data extraction, " +
      "code generation, fixed procedure);\n" +
      "  - encodes specialized/domain knowledge or best practices worth codifying.\n" +
      "A skill is NOT warranted for one-off, trivial, or purely subjective work (taste, " +
      "writing style) with no reusable procedure. Be honest — most patterns are not " +
      "skill-worthy.\n\n" +
      "STEP 2 — If worthy, author the SKILL.md using the skill-creator guidance above. " +
      "The description is the PRIMARY trigger: state BOTH what it does AND when to use it, " +
      "third person, concrete trigger phrasing. The body_markdown must NOT include YAML " +
      "frontmatter (it is added separately).\n\n" +
      "Respond with ONLY a JSON object, no prose, no code fence:\n" +
      '{"worthy": true, "worthiness_reason": "one sentence on why it is / is not ' +
      'skill-worthy", "name": "short-kebab-name", "description": "what AND when, with ' +
      'concrete triggers", "body_markdown": "the skill body, no frontmatter"}\n' +
      "If NOT worthy, set worthy=false and give the reason, but still fill name/" +
      "description/body_markdown with your best attempt — the human makes the final call."
    );
  }

  /** Synchronous distill core (tested directly). Saves a 'ready' draft. */
  async distill_skill_draft(
    pattern_id: number,
    agent: string | null = null,
  ): Promise<Row> {
    const pattern = this.db.get_skill_pattern(pattern_id);
    if (!pattern) {
      throw new Error("pattern not found");
    }
    agent =
      agent ||
      this.db.get_setting("skill_sweep_agent", null) ||
      this.db.get_setting("default_agent", DEFAULT_AGENT);
    let tids: number[];
    try {
      tids = JSON.parse(pattern["contributing_task_ids"]) || [];
      if (!Array.isArray(tids)) tids = [];
    } catch {
      tids = [];
    }
    const context = this._build_distill_context(tids);

    // Run the distill in a throwaway working dir that has the vendored
    // skill-creator skill loaded, so the agent actually authors the SKILL.md
    // *using* skill-creator (not just "in its style").
    const creator_src = _skill_creator_dir();
    let creator_rel: string | null = null;
    const workdir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentforge-distill-"),
    );
    let ok: boolean;
    let raw: string;
    try {
      let hasCreatorMd = false;
      try {
        hasCreatorMd = fs.statSync(path.join(creator_src, "SKILL.md")).isFile();
      } catch {
        hasCreatorMd = false;
      }
      if (hasCreatorMd) {
        const dest = path.join(workdir, ".claude", "skills", "skill-creator");
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(
          path.join(creator_src, "SKILL.md"),
          path.join(dest, "SKILL.md"),
        );
        creator_rel = ".claude/skills/skill-creator/SKILL.md";
      }
      const prompt = this._build_distill_prompt(pattern, context, creator_rel);
      [ok, raw] = await this._run_agent_prompt_once(agent!, prompt, workdir);
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
    if (!ok) {
      throw new Error(raw || "distill agent failed");
    }
    const obj = parseJsonObject(raw);
    const name = _sanitize_skill_name(
      (obj["name"] as string) || pattern["pattern_key"],
    );
    const description = String(obj["description"] ?? "").trim();
    const body_md = String(obj["body_markdown"] || obj["body"] || "").trim();
    const worthy_raw = obj["worthy"];
    const worthy = typeof worthy_raw === "boolean" ? worthy_raw : null;
    const worthiness_reason = String(obj["worthiness_reason"] ?? "").trim();
    const skill_md = _compose_skill_md(name, description, body_md);
    this.db.upsert_skill_draft(
      pattern_id,
      "ready",
      name,
      description,
      pattern["kind"],
      skill_md,
      null,
      worthy,
      worthiness_reason,
    );
    return {
      pattern_id,
      name,
      description,
      kind: pattern["kind"],
      body: skill_md,
      worthy,
      worthiness_reason,
    };
  }

  /** Start distillation in the background (single-threaded server). */
  trigger_skill_draft(
    pattern_id: number,
    agent: string | null = null,
  ): boolean {
    const pattern = this.db.get_skill_pattern(pattern_id);
    if (!pattern) {
      return false;
    }
    this.db.upsert_skill_draft(pattern_id, "drafting", "", "", pattern["kind"]);

    void (async () => {
      try {
        await this.distill_skill_draft(pattern_id, agent);
      } catch (e) {
        // surface to draft row, never crash
        logger.error(`Skill distill failed: ${errStr(e)}`);
        this.db.upsert_skill_draft(
          pattern_id,
          "error",
          "",
          "",
          pattern["kind"],
          "",
          errStr(e),
        );
      }
    })();
    return true;
  }

  /** Write the approved SKILL.md, symlink it for both agents, register it. */
  approve_skill(
    pattern_id: number,
    name: string,
    description: string,
    body: string,
  ): Row | null {
    const pattern = this.db.get_skill_pattern(pattern_id);
    if (!pattern) {
      throw new Error("pattern not found");
    }
    if (!(body || "").trim()) {
      throw new Error("skill body is empty");
    }
    // The edited SKILL.md is the single source of truth: derive the skill name
    // and registry description from its frontmatter, falling back to the args.
    const [fm_name, fm_desc] = _parse_skill_frontmatter(body);
    name = _sanitize_skill_name(fm_name || name || pattern["pattern_key"]);
    if (!name) {
      throw new Error("invalid skill name");
    }
    description = fm_desc || description || "";
    const [skill_md_path] = write_skill_to_disk(name, body);
    const skill_id = this.db.add_skill(
      name,
      description || "",
      skill_md_path,
      pattern["pattern_key"],
      pattern["contributing_task_ids"],
      pattern["kind"],
    );
    this.db.set_skill_pattern_status(pattern_id, "promoted", skill_id);
    this.db.delete_skill_draft(pattern_id);
    return skill_id !== null ? this.db.get_skill(skill_id) : null;
  }

  dismiss_skill_pattern(pattern_id: number): void {
    if (!this.db.get_skill_pattern(pattern_id)) {
      throw new Error("pattern not found");
    }
    this.db.set_skill_pattern_status(pattern_id, "dismissed");
    this.db.delete_skill_draft(pattern_id);
  }

  // ── Skill Library: registry management (#19) ───────────────────────────

  /**
   * Enable/disable a registered skill by adding/removing both symlinks.
   *
   * Canonical SKILL.md is preserved either way — disabling just stops the
   * agents from loading it.
   */
  toggle_skill(skill_id: number, enabled: boolean): Row | null {
    const skill = this.db.get_skill(skill_id);
    if (!skill) {
      throw new Error("skill not found");
    }
    if (enabled) {
      link_skill(skill["name"]);
    } else {
      unlink_skill(skill["name"]);
    }
    this.db.set_skill_enabled(skill_id, enabled);
    return this.db.get_skill(skill_id);
  }

  /** Delete a skill: remove symlinks, canonical dir, and registry row. */
  remove_skill(skill_id: number): void {
    const skill = this.db.get_skill(skill_id);
    if (!skill) {
      throw new Error("skill not found");
    }
    remove_skill_from_disk(skill["name"]);
    this.db.delete_skill(skill_id);
  }

  _build_sweep_prompt(runs: Row[], existing: Row[]): string {
    let existing_block: string;
    if (existing.length) {
      existing_block = existing
        .map(
          (p) =>
            `- ${p["pattern_key"]} (${p["kind"]}, seen ${p["recurrence_count"]}x): ${p["summary"]}`,
        )
        .join("\n");
    } else {
      existing_block = "(none yet)";
    }
    const run_lines: string[] = [];
    for (const r of runs) {
      const p = String(r["prompt"] || "")
        .trim()
        .replaceAll("\n", " ")
        .slice(0, 400);
      const res = String(r["result"] || "")
        .trim()
        .replaceAll("\n", " ")
        .slice(0, 300);
      run_lines.push(
        `[run #${r["run_id"]} · task #${r["task_id"]}] ${r["title"] || "Untitled"}\n` +
          `  prompt: ${p}\n` +
          `  result: ${res}`,
      );
    }
    const runs_block = run_lines.join("\n");
    return (
      "You analyze a developer's recently completed AI-agent task runs to detect " +
      "RECURRING patterns of work worth distilling into a reusable skill.\n\n" +
      "Existing tracked patterns — REUSE an existing pattern_key verbatim when a run " +
      "matches one semantically; otherwise mint a new short kebab-case key:\n" +
      `${existing_block}\n\n` +
      "Recently completed task runs to analyze (each line is ONE run):\n" +
      `${runs_block}\n\n` +
      "Emit ONE entry PER RUN that represents a meaningful, repeatable capability. Kinds:\n" +
      '- "recipe": a successful repeatable approach/workflow worth reusing.\n' +
      '- "pitfall": a failure that was diagnosed and fixed, worth avoiding next time.\n' +
      "CRITICAL: when several runs share the same capability, they MUST reuse the SAME " +
      "pattern_key (so occurrences aggregate), but each run still gets its OWN entry with " +
      "its own run_id and task_id. Do NOT collapse multiple matching runs into a single " +
      "entry — one entry per run is how recurrence is counted. Reuse an existing tracked " +
      "pattern_key verbatim when it matches. Skip trivial or truly one-off runs.\n\n" +
      "Respond with ONLY a JSON array, no prose, no code fence (example shows two runs of " +
      "the same pattern):\n" +
      '[{"pattern_key":"run-pytest-suite","kind":"recipe","summary":"one concise line","run_id":12,"task_id":3},' +
      '{"pattern_key":"run-pytest-suite","kind":"recipe","summary":"one concise line","run_id":15,"task_id":4}]\n' +
      "If nothing is worth tracking, respond with []."
    );
  }

  static _parse_sweep_output(raw_text: string): unknown[] {
    let text = (raw_text || "").trim();
    if (text.startsWith("```")) {
      text = text
        .split(/\r?\n/)
        .filter((ln) => !ln.trim().startsWith("```"))
        .join("\n")
        .trim();
    }
    if (!text.startsWith("[")) {
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start !== -1 && end !== -1 && end > start) {
        text = text.slice(start, end + 1);
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return [];
    }
    return Array.isArray(data) ? data : [];
  }

  /** Instance alias so tests can call `sched._parse_sweep_output(...)` like Python. */
  _parse_sweep_output(raw_text: string): unknown[] {
    return TaskScheduler._parse_sweep_output(raw_text);
  }

  async _run_agent_prompt_once(
    agent: string,
    prompt: string,
    working_dir: string,
  ): Promise<[boolean, string]> {
    const working_dir_expanded = expanduser(working_dir);
    let cmd: string[];
    if (agent === "codex") {
      cmd = [
        "codex",
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "--cd",
        working_dir_expanded,
        prompt,
      ];
    } else {
      cmd = ["claude", "-p", prompt, ...CLAUDE_STREAM_JSON_ARGS];
    }
    return this._run_agent_command(agent, cmd, working_dir_expanded);
  }

  async _run_agent_command(
    agent: string,
    cmd: string[],
    working_dir_expanded: string,
    on_stdout_line: ((line: string) => void) | null = null,
    on_stderr_line: ((line: string) => void) | null = null,
  ): Promise<[boolean, string]> {
    let proc: PopenLike;
    try {
      proc = await this._popen(cmd, {
        stdout: PIPE,
        stderr: PIPE,
        cwd: working_dir_expanded,
        env: getEnv(),
      });
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        return [false, `${agent} CLI not found`];
      }
      if (e instanceof OSError) {
        return [false, e.message];
      }
      throw e;
    }
    const timeout_secs = parseInt(
      this.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
        String(DEFAULT_TIMEOUT_SECONDS),
      10,
    );
    const stdout_chunks: string[] = [];
    const stderr_chunks: string[] = [];

    const _read_stream = async (
      stream: Iterable<string> | AsyncIterable<string>,
      chunks: string[],
      callback: ((line: string) => void) | null,
    ): Promise<void> => {
      for await (const line of stream) {
        chunks.push(line);
        if (callback) {
          callback(line);
        }
      }
    };

    const stdout_promise = _read_stream(
      proc.stdout,
      stdout_chunks,
      on_stdout_line,
    ).catch(() => {});
    const stderr_promise = _read_stream(
      proc.stderr,
      stderr_chunks,
      on_stderr_line,
    ).catch(() => {});
    try {
      await proc.wait(timeout_secs);
    } catch (e) {
      if (e instanceof TimeoutExpired) {
        try {
          proc.kill();
        } catch {
          // ≙ except OSError: pass
        }
        await joinWithTimeout(stdout_promise, 1);
        await joinWithTimeout(stderr_promise, 1);
        return [false, `${agent} heartbeat decision timed out`];
      }
      throw e;
    }

    await joinWithTimeout(stdout_promise, 1);
    await joinWithTimeout(stderr_promise, 1);
    const raw_stdout = stdout_chunks.join("");
    const raw_stderr = stderr_chunks.join("");
    if (proc.returncode !== 0) {
      return [
        false,
        raw_stderr || raw_stdout || `${agent} heartbeat decision failed`,
      ];
    }

    if (agent === "codex") {
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
      return [true, out || raw_stdout];
    }

    let out = "";
    let last_assistant_text = "";
    for (let line of raw_stdout.split("\n")) {
      line = line.trim();
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.type === "assistant") {
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
      } else if (event?.type === "result") {
        const result_text = event.result;
        if (result_text) {
          out = result_text;
        }
      }
    }
    return [true, out || last_assistant_text || raw_stdout];
  }

  _heartbeat_trigger_suppressed(heartbeat: Row, dedupe_key: string): boolean {
    if (!dedupe_key) {
      return false;
    }
    const existing = this.db.get_heartbeat_dedup(heartbeat["id"], dedupe_key);
    if (!existing) {
      return false;
    }
    const cooldown = Math.trunc(Number(heartbeat["cooldown_seconds"] || 0));
    const triggered_at = existing["triggered_at"];
    if (triggered_at) {
      try {
        const triggered_dt = parseComparableDatetime(triggered_at);
        if (
          triggered_dt &&
          cooldown > 0 &&
          Date.now() < triggered_dt.getTime() + cooldown * 1000
        ) {
          return true;
        }
      } catch {
        // ≙ except ValueError: pass
      }
    }
    const existing_task_id = existing["task_id"];
    if (existing_task_id) {
      const task = this.db.get_task(existing_task_id);
      if (
        task &&
        ["pending", "scheduled", "blocked", "running"].includes(task["status"])
      ) {
        return true;
      }
    }
    return false;
  }

  async _execute_heartbeat(heartbeat: Row): Promise<void> {
    const hid = heartbeat["id"];
    const tick_id = this.db.add_heartbeat_tick(hid);
    const now = new Date();
    const output_chunks: string[] = [];
    this._live_heartbeat_output.set(tick_id, "");
    const next_run_at = this.db._compute_heartbeat_next_run_at(
      makeHeartbeat({
        id: hid,
        name: heartbeat["name"],
        enabled: heartbeat["enabled"],
        working_dir: heartbeat["working_dir"],
        schedule_type: heartbeat["schedule_type"],
        cron_expr: heartbeat["cron_expr"] ?? null,
        interval_seconds: heartbeat["interval_seconds"] ?? null,
        check_prompt: heartbeat["check_prompt"],
        action_prompt_template: heartbeat["action_prompt_template"] || "",
        default_agent: heartbeat["default_agent"] || DEFAULT_AGENT,
        cooldown_seconds: Math.trunc(
          Number(heartbeat["cooldown_seconds"] || 0),
        ),
      }),
      now,
    );
    try {
      const _append_tick_output = (line: string): void => {
        output_chunks.push(line);
        this._live_heartbeat_output.set(tick_id, output_chunks.join(""));
      };

      const agent = heartbeat["default_agent"] || DEFAULT_AGENT;
      const prompt = this._render_heartbeat_check_prompt(heartbeat);
      const working_dir_expanded = expanduser(heartbeat["working_dir"]);
      let cmd: string[];
      if (agent === "codex") {
        cmd = [
          "codex",
          "exec",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--cd",
          working_dir_expanded,
          prompt,
        ];
      } else {
        cmd = [
          "claude",
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "bypassPermissions",
        ];
      }
      const [success, raw_output] = await this._run_agent_command(
        agent,
        cmd,
        working_dir_expanded,
        _append_tick_output,
        _append_tick_output,
      );
      if (!success) {
        throw new Error(raw_output);
      }
      const decision = this._parse_heartbeat_decision(raw_output);
      let decision_type: string = decision["decision"];
      if (decision_type === HeartbeatDecisionType.TRIGGER_TASK) {
        const dedupe_key: string = decision["dedupe_key"] ?? "";
        if (this._heartbeat_trigger_suppressed(heartbeat, dedupe_key)) {
          decision_type = HeartbeatDecisionType.IDLE;
          decision["decision"] = decision_type;
          decision["reason"] =
            "Suppressed duplicate signal during cooldown or while prior task is still active";
        } else {
          const task_prompt =
            decision["prompt"] ||
            heartbeat["action_prompt_template"] ||
            heartbeat["check_prompt"];
          const task_title =
            decision["title"] || `Heartbeat: ${heartbeat["name"]}`;
          const task = {
            title: task_title,
            prompt: task_prompt,
            working_dir: heartbeat["working_dir"],
            schedule_type: ScheduleType.IMMEDIATE,
            agent: heartbeat["default_agent"] || DEFAULT_AGENT,
            tags: "heartbeat",
          };
          const task_id = this.submit_task(makeTaskFromPartial(task));
          if (dedupe_key) {
            this.db.upsert_heartbeat_dedup(hid, dedupe_key, task_id);
          }
          this.db.update_heartbeat(hid, {
            next_run_at,
            last_tick_at: dateToLocalIso(now),
            last_decision: decision_type,
            last_error: null,
            last_triggered_at: dateToLocalIso(now),
            last_dedupe_key: dedupe_key,
          });
          this.db.finish_heartbeat_tick(
            tick_id,
            "triggered",
            decision_type,
            decision,
            task_id,
            output_chunks.length
              ? output_chunks.join("").slice(0, 500000)
              : null,
          );
          return;
        }
      }
      this.db.update_heartbeat(hid, {
        next_run_at,
        last_tick_at: dateToLocalIso(now),
        last_decision: decision_type,
        last_error: null,
        last_dedupe_key:
          (decision["dedupe_key"] || heartbeat["last_dedupe_key"]) ?? null,
      });
      this.db.finish_heartbeat_tick(
        tick_id,
        decision_type === HeartbeatDecisionType.IDLE ? "idle" : decision_type,
        decision_type,
        decision,
        null,
        output_chunks.length ? output_chunks.join("").slice(0, 500000) : null,
      );
    } catch (e) {
      logger.error(`Heartbeat ${hid} failed: ${errStr(e)}`);
      this.db.update_heartbeat(hid, {
        next_run_at,
        last_tick_at: dateToLocalIso(now),
        last_decision: HeartbeatDecisionType.ERROR,
        last_error: errStr(e),
      });
      this.db.finish_heartbeat_tick(
        tick_id,
        "error",
        HeartbeatDecisionType.ERROR,
        null,
        null,
        output_chunks.length ? output_chunks.join("").slice(0, 500000) : null,
        errStr(e),
      );
    } finally {
      this._live_heartbeat_output.delete(tick_id);
      this._active_heartbeats.delete(hid);
    }
  }

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

  _codex_generated_images_root(): string {
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

  _redact_display_payload(value: any): any {
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

  _compact_payload(payload: Row): Row {
    const out: Row = {};
    for (const [key, value] of Object.entries(payload)) {
      if (value !== null && value !== undefined) {
        out[key] = value;
      }
    }
    return out;
  }

  _trace_json(payload: Row): string {
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

  _should_stream_event(event_type: string): boolean {
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
  _extract_message_content(
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

  async _execute_task(task: Row): Promise<void> {
    const tid: number = task["id"];
    this._live_output.set(tid, "");
    // Status already set to "running" by _spawn_task() before thread start.
    this._notify(tid);

    const run_id = this.db.add_run(tid);

    // Build command — inject upstream results if configured
    const prompt = this._build_injected_prompt(task);
    const prompt_images: Row[] = task["prompt_images"] || [];
    const image_paths: string[] = task["image_paths"] || []; // List of local image file paths

    // Convert image_paths to prompt_images format (base64 encoded)
    if (image_paths.length && !prompt_images.length) {
      // Only if not already using prompt_images
      const _ALLOWED_IMAGE_ROOTS = [expanduser("~"), "/tmp"];

      /** Return true only if path resolves inside an allowed directory. */
      const _is_safe_image_path = (p: string): boolean => {
        let resolved: string;
        try {
          resolved = realpathNonStrict(path.resolve(p));
        } catch {
          return false;
        }
        for (const root of _ALLOWED_IMAGE_ROOTS) {
          try {
            const resolved_root = realpathNonStrict(root);
            if (
              resolved.startsWith(resolved_root + path.sep) ||
              resolved === resolved_root
            ) {
              return true;
            }
          } catch {
            continue;
          }
        }
        return false;
      };

      for (const img_path of image_paths) {
        if (!_is_safe_image_path(img_path)) {
          logger.warning(
            `Task ${tid}: Rejected image path outside allowed directories: ${img_path}`,
          );
          continue;
        }
        try {
          const buf = fs.readFileSync(img_path);
          const img_data = buf.toString("base64");

          // Detect media type from file extension
          const img_path_lower = img_path.toLowerCase();
          let media_type: string;
          if (img_path_lower.endsWith(".png")) {
            media_type = "image/png";
          } else if (
            img_path_lower.endsWith(".jpg") ||
            img_path_lower.endsWith(".jpeg")
          ) {
            media_type = "image/jpeg";
          } else if (img_path_lower.endsWith(".gif")) {
            media_type = "image/gif";
          } else if (img_path_lower.endsWith(".webp")) {
            media_type = "image/webp";
          } else {
            // Try to detect from magic bytes
            const header = buf.subarray(0, 12);
            if (
              header.length >= 3 &&
              header[0] === 0xff &&
              header[1] === 0xd8 &&
              header[2] === 0xff
            ) {
              media_type = "image/jpeg";
            } else if (
              header.length >= 8 &&
              header
                .subarray(0, 8)
                .equals(
                  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                )
            ) {
              media_type = "image/png";
            } else if (
              header.subarray(0, 6).toString("latin1") === "GIF87a" ||
              header.subarray(0, 6).toString("latin1") === "GIF89a"
            ) {
              media_type = "image/gif";
            } else if (
              header.subarray(0, 4).toString("latin1") === "RIFF" &&
              header.toString("latin1").includes("WEBP")
            ) {
              media_type = "image/webp";
            } else {
              media_type = "image/jpeg"; // default fallback
            }
          }

          prompt_images.push({
            media_type,
            data: img_data,
            name: path.basename(img_path),
          });
          logger.debug(
            `Task ${tid}: Loaded image ${img_path} as ${media_type} (${img_data.length} bytes base64)`,
          );
        } catch (e) {
          logger.error(
            `Task ${tid}: Failed to load image ${img_path}: ${errStr(e)}`,
          );
        }
      }
    }

    const agent: string = task["agent"] || DEFAULT_AGENT;
    const use_stdin = prompt_images.length > 0 && agent === "claude";

    let cmd: string[];
    if (agent === "codex") {
      const working_dir_expanded = expanduser(task["working_dir"]);
      if (task["session_id"]) {
        cmd = [
          "codex",
          "exec",
          "resume",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          task["session_id"],
          prompt,
        ];
      } else {
        cmd = [
          "codex",
          "exec",
          "--json",
          "--dangerously-bypass-approvals-and-sandbox",
          "--skip-git-repo-check",
          "--cd",
          working_dir_expanded,
          prompt,
        ];
      }
      for (const img_path of image_paths) {
        cmd.push("--image", img_path);
      }
    } else if (use_stdin) {
      // Claude multimodal input: pass via stdin with --input-format stream-json
      cmd = [
        "claude",
        "-p",
        "--input-format",
        "stream-json",
        ...CLAUDE_STREAM_JSON_ARGS,
      ];
    } else {
      cmd = ["claude", "-p", prompt, ...CLAUDE_STREAM_JSON_ARGS];
    }
    if (agent === "claude" && task["session_id"]) {
      cmd.push("--resume", task["session_id"]);
    }
    let raw_stdout = "";
    let raw_stderr = "";
    // Initialized before the try so the failure branch can read it even when
    // Popen itself raises (e.g. CLI not found) before the timer is armed.
    const timed_out = { value: false };
    let success = false;
    let output = "";
    try {
      const timeout_secs = parseInt(
        this.db.get_setting("timeout", String(DEFAULT_TIMEOUT_SECONDS)) ??
          String(DEFAULT_TIMEOUT_SECONDS),
        10,
      );
      const start_time = Date.now() / 1000;
      const proc = await this._popen(cmd, {
        stdin: use_stdin ? PIPE : null,
        stdout: PIPE,
        stderr: PIPE,
        cwd: expanduser(task["working_dir"]),
        env: getEnv(),
        start_new_session: true, // Create a new process group so all sub-agents are tracked
      });
      if (use_stdin) {
        // Build multimodal message content
        const content: Row[] = [{ type: "text", text: prompt }];
        for (const img of prompt_images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img["media_type"] ?? "image/jpeg",
              data: img["data"] ?? "",
            },
          });
        }
        const stdin_msg = JSON.stringify({
          type: "user",
          message: { role: "user", content },
        });
        proc.stdin!.write(stdin_msg + "\n");
        proc.stdin!.close();
      }
      const pgid = this._os.getpgid(proc.pid);
      this._active_pgids.set(tid, pgid);

      // Read stderr concurrently so it never blocks stdout reading
      const stderr_chunks: string[] = [];
      const stderr_promise = (async () => {
        for await (const line of proc.stderr) {
          stderr_chunks.push(line);
        }
      })().catch(() => {});

      // Timer that kills the entire process group if it exceeds the configured timeout
      const _kill = (): void => {
        timed_out.value = true;
        try {
          this._os.killpg(pgid, "SIGKILL");
        } catch (e) {
          logger.error(
            `Task ${tid}: killpg(${pgid}) failed: ${errStr(e)}, falling back to kill(${proc.pid})`,
          );
          try {
            this._os.kill(proc.pid, "SIGKILL");
          } catch (e2) {
            logger.error(
              `Task ${tid}: kill(${proc.pid}) also failed: ${errStr(e2)}`,
            );
          }
        }
      };

      const timer = setTimeout(_kill, timeout_secs * 1000);

      const chunks: string[] = [];
      try {
        for await (const line of proc.stdout) {
          chunks.push(line);
          this._live_output.set(tid, chunks.join(""));
          // Parse and store each line as an event
          this._parse_and_store_event(tid, run_id, line, agent);
        }
        await proc.wait();
      } finally {
        clearTimeout(timer);
      }
      await joinWithTimeout(stderr_promise, 2);

      // Wait for any sub-agents still running in the process group.
      // Claude Code may spawn background Task agents that outlive the main process.
      if (!timed_out.value && proc.returncode === 0) {
        const elapsed = Date.now() / 1000 - start_time;
        const remaining = Math.max(0, timeout_secs - elapsed);
        const subagent_deadline = Date.now() / 1000 + remaining;
        let waiting_logged = false;
        let broke = false;
        while (Date.now() / 1000 < subagent_deadline) {
          try {
            this._os.killpg(pgid, 0); // raises ProcessLookupError when group is gone
          } catch (e) {
            if (e instanceof ProcessLookupError) {
              broke = true;
              break;
            }
            throw e;
          }
          if (!waiting_logged) {
            waiting_logged = true;
            logger.info(
              `Task ${tid}: main process exited, waiting for sub-agents...`,
            );
          }
          this._live_output.set(
            tid,
            chunks.join("") + "\n[⏳ Waiting for sub-agents to complete...]",
          );
          await this._sleep(1);
        }
        if (!broke) {
          // Sub-agents exceeded remaining timeout — kill the group
          timed_out.value = true;
          try {
            this._os.killpg(pgid, "SIGKILL");
          } catch (e) {
            logger.error(
              `Task ${tid}: killpg(${pgid}) on sub-agent timeout failed: ${errStr(e)}`,
            );
          }
        }
      }

      this._active_pgids.delete(tid);

      raw_stdout = chunks.join("");
      raw_stderr = stderr_chunks.join("");

      if (timed_out.value) {
        success = false;
        output = `Task timed out after ${timeout_secs}s`;
      } else if (proc.returncode === 0) {
        if (agent === "codex") {
          const thread_id = this._extract_codex_thread_id(raw_stdout);
          const generated_images = this._find_codex_generated_images(
            thread_id,
            start_time,
          );
          if (generated_images.length) {
            this._store_generated_image_events(tid, run_id, generated_images);
          }
          success = true;
          output = this._extract_codex_success_output(
            raw_stdout,
            generated_images,
          );
        } else {
          // Claude stream-json: find the last result event and last assistant text
          let out = "";
          let last_assistant_text = "";
          for (let line of raw_stdout.split("\n")) {
            line = line.trim();
            if (!line) continue;
            try {
              const event = JSON.parse(line);
              if (event?.type === "assistant") {
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
              } else if (event?.type === "result") {
                const result_text = event.result;
                if (result_text) {
                  out = result_text;
                }
              }
            } catch {
              // not JSON — keep scanning
            }
          }
          // If result event had no result field (e.g. error_during_execution
          // with 0 output tokens), fall back to last assistant message text
          if (!out) {
            out = last_assistant_text;
          }
          success = true;
          output = out;
        }
      } else {
        success = false;
        output = raw_stderr || raw_stdout;
      }
    } catch (e) {
      if (e instanceof FileNotFoundError) {
        const cli_name = task["agent"] === "codex" ? "codex" : "claude";
        const install_hint =
          cli_name === "codex"
            ? "Install with: npm install -g @openai/codex"
            : "Is it installed?";
        success = false;
        output = `${cli_name} CLI not found. ${install_hint}`;
        this._active_pgids.delete(tid);
      } else {
        logger.error(`Task ${tid} subprocess error: ${errStr(e)}`);
        success = false;
        output = errStr(e);
        this._active_pgids.delete(tid);
      }
    }

    this._live_output.delete(tid);
    if (agent === "codex") {
      this._clear_codex_run_state(run_id);
    } else if (agent === "claude") {
      this._clear_claude_run_state(run_id);
    }

    // Extract session_id from output (format differs by agent)
    let extracted_session_id: string | null = null;
    if (agent === "codex") {
      // Codex emits session_id in the thread.started event at the beginning
      extracted_session_id = this._extract_codex_thread_id(raw_stdout);
    } else {
      // Claude emits session_id in the result event at the end
      for (let line of raw_stdout.split("\n").reverse()) {
        line = line.trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event?.type === "result" && event?.session_id) {
            extracted_session_id = event.session_id;
            break;
          }
        } catch {
          // not JSON — keep scanning
        }
      }
    }

    // Truncate raw_output for storage (max 500KB)
    const raw_output_stored = raw_stdout ? raw_stdout.slice(0, 500000) : null;

    const new_count = (task["run_count"] || 0) + 1;
    if (success) {
      const updates: Row = {
        result: output.slice(0, 50000), // truncate for storage
        last_run_at: nowIso(),
        run_count: new_count,
      };
      if (extracted_session_id) {
        updates["session_id"] = extracted_session_id;
      }
      // Handle cron rescheduling
      let cron_will_reschedule = false;
      if (task["schedule_type"] === "cron" && task["cron_expr"]) {
        const max_runs = task["max_runs"];
        if (max_runs && new_count >= max_runs) {
          updates["status"] = "completed";
        } else {
          updates["status"] = "scheduled";
          updates["next_run_at"] = cron_next_iso(task["cron_expr"], new Date());
          cron_will_reschedule = true;
        }
      } else {
        updates["status"] = "completed";
      }
      this.db.finish_run_and_update_task(
        run_id,
        "completed",
        tid,
        updates,
        output,
        null,
        raw_output_stored,
      );
      // For cron tasks that get rescheduled, notify channels with TASK_COMPLETED
      // before the status flips to "scheduled", so channels actually fire.
      if (cron_will_reschedule) {
        this._bus_notify(tid, OutboundMessageType.TASK_COMPLETED);
      }
    } else {
      // Extract a clean, human-readable error summary for task.error and
      // notification channels. The full raw output is preserved in run_error.
      let error_summary: string;
      if (timed_out.value) {
        // The timeout IS the reason — don't let an unrelated stderr line
        // (e.g. codex's "Reading additional input from stdin…") mask it.
        error_summary = output;
      } else {
        error_summary =
          raw_stderr || raw_stdout
            ? this._extract_error_summary(raw_stderr, raw_stdout)
            : output || "Unknown error";
      }
      const updates: Row = {
        status: "failed",
        error: error_summary,
        last_run_at: nowIso(),
        run_count: new_count,
      };
      // Persist the conversation id even on failure so the task stays
      // resumable (e.g. replying in a Feishu/Slack/Telegram thread to
      // retry). Codex emits thread_id in the opening thread.started event,
      // so even a started-then-failed run has one to recover.
      if (extracted_session_id) {
        updates["session_id"] = extracted_session_id;
      }
      this.db.finish_run_and_update_task(
        run_id,
        "failed",
        tid,
        updates,
        null,
        output,
        raw_output_stored,
      );
    }

    this._notify(tid);
    this._active_tasks.delete(tid);

    // DAG: trigger downstream cascade after task finishes
    if (success) {
      this._on_task_completed(tid);
    } else {
      this._on_task_failed(tid);
    }
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

  // ─────────────────────────────────────────────────────────────

  cancel_task(task_id: number): void {
    const pgid = this._active_pgids.get(task_id);
    if (pgid) {
      try {
        this._os.killpg(pgid, "SIGKILL");
      } catch (e) {
        if (!(e instanceof OSError)) throw e;
        // ≙ except OSError: pass
      }
    }
    this.db.update_task(task_id, { status: "cancelled" });
    this._notify(task_id);
  }

  retry_task(task_id: number): void {
    this.db.update_task(task_id, { status: "pending", error: null });
    this._notify(task_id);
  }

  trigger_heartbeat_now(heartbeat_id: number): void {
    const heartbeat = this.db.get_heartbeat(heartbeat_id);
    if (!heartbeat) {
      throw new Error("heartbeat not found");
    }
    const handle = this._active_heartbeats.get(heartbeat_id);
    if (handle && handle.is_alive()) {
      throw new Error("heartbeat already running");
    }
    this._spawn_heartbeat(heartbeat);
  }

  pause_heartbeat(heartbeat_id: number): void {
    const heartbeat = this.db.get_heartbeat(heartbeat_id);
    if (!heartbeat) {
      throw new Error("heartbeat not found");
    }
    this.db.update_heartbeat(heartbeat_id, { enabled: 0 });
  }

  resume_heartbeat(heartbeat_id: number): void {
    const heartbeat = this.db.get_heartbeat(heartbeat_id);
    if (!heartbeat) {
      throw new Error("heartbeat not found");
    }
    const next_run_at = this.db._compute_heartbeat_next_run_at(
      makeHeartbeat({
        id: heartbeat_id,
        name: heartbeat["name"],
        enabled: true,
        working_dir: heartbeat["working_dir"],
        schedule_type: heartbeat["schedule_type"],
        cron_expr: heartbeat["cron_expr"] ?? null,
        interval_seconds: heartbeat["interval_seconds"] ?? null,
        check_prompt: heartbeat["check_prompt"],
        action_prompt_template: heartbeat["action_prompt_template"] || "",
        default_agent: heartbeat["default_agent"] || DEFAULT_AGENT,
        cooldown_seconds: Math.trunc(
          Number(heartbeat["cooldown_seconds"] || 0),
        ),
      }),
      new Date(),
    );
    this.db.update_heartbeat(heartbeat_id, { enabled: 1, next_run_at });
  }
}

// Heartbeat-triggered tasks are built from a plain object (≙ Task(**kwargs)).
import { makeTask } from "./types.ts";

function makeTaskFromPartial(partial: Partial<Task>): Task {
  return makeTask(partial);
}
