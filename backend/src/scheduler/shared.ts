// Module-level helpers and types shared by the scheduler modules.
//
// scheduler.ts was a single 2 600-line class file; it is now a mixin chain
// (state -> execution -> skills -> heartbeats -> inbound -> TaskScheduler).
// Everything here is stateless and is imported by several of those modules.

import fs from "node:fs";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import { ProcessLookupError, OSError } from "../executor.ts";
import { dateToLocalIso, errStr } from "../util.ts";
import { makeTask, TaskBriefStatus } from "../types.ts";
import type { Task } from "../types.ts";

/** Constructor shape a mixin can extend (≙ the standard TS mixin bound). */
export type SchedulerCtor<T> = new (...args: any[]) => T;

export type Row = Record<string, any>;

// ── small helpers ────────────────────────────────────────────────────────────

export function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Await a promise but give up after `seconds` (≙ Thread.join(timeout=...)). */
export async function joinWithTimeout(
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
export function croniter_is_valid(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/** ≙ croniter(expr, base).get_next(datetime).isoformat() (local-naive storage) */
export function cron_next_iso(expr: string, base: Date): string {
  return dateToLocalIso(
    CronExpressionParser.parse(expr, { currentDate: base }).next().toDate(),
  );
}

/** ≙ os.path.realpath (non-strict: resolves as far as possible, never throws). */
export function realpathNonStrict(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export const _int = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
  return Number.isNaN(n) ? null : n;
};

export function _string_list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function _plain_object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}

export function _task_brief_prompt(brief: Row): string {
  const lines = ["Goal:", String(brief["goal"]).trim()];
  const context = String(brief["context_summary"] ?? "").trim();
  if (context) {
    lines.push("", "Context:", context);
  }
  const criteria = Array.isArray(brief["acceptance_criteria"])
    ? brief["acceptance_criteria"].map(String).filter(Boolean)
    : [];
  if (criteria.length) {
    lines.push("", "Acceptance criteria:");
    criteria.forEach((criterion, index) => {
      lines.push(`${index + 1}. ${criterion}`);
    });
  }
  return lines.join("\n");
}

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

/** Heartbeat-triggered tasks are built from a plain object (≙ Task(**kwargs)). */
export function makeTaskFromPartial(partial: Partial<Task>): Task {
  return makeTask(partial);
}
