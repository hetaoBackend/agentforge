// TaskScheduler, ported from taskboard.py (class TaskScheduler, lines 1787-3798).
//
// Method names, prompts, error messages and JSON keys are kept byte-identical
// to the Python source — tests assert on them. Python's per-task/heartbeat
// threads become async functions; the injectable seams (`_popen`, `_os`,
// `_sleep`, `AgentExecutor.subprocess_run`) replace the pytest monkeypatching
// of `taskboard.subprocess.*` / `taskboard.os.*` / `taskboard.time.sleep`.
//
// The class is assembled from mixins so each responsibility gets its own file
// while staying one object with one shared state (see scheduler/state.ts).
// Only the polling loop and task lifecycle live here.

import type { MessageBus } from "./bus.ts";
import type { TaskDB } from "./db.ts";
import { OSError } from "./executor.ts";
import { logger } from "./log.ts";
import type { Task } from "./types.ts";
import { dateToLocalIso, errStr, parseComparableDatetime } from "./util.ts";
import {
  type ActiveHandle,
  type Row,
  joinWithTimeout,
} from "./scheduler/shared.ts";
import { SchedulerState } from "./scheduler/state.ts";
import { ExecutionMixin } from "./scheduler/execution.ts";
import { SkillsMixin } from "./scheduler/skills.ts";
import { HeartbeatsMixin } from "./scheduler/heartbeats.ts";
import { InboundMixin } from "./scheduler/inbound.ts";

export { default_os } from "./scheduler/shared.ts";
export type {
  ActiveHandle,
  ChannelLike,
  DependsOn,
  OsOps,
  OutputListener,
} from "./scheduler/shared.ts";

export class TaskScheduler extends InboundMixin(
  HeartbeatsMixin(SkillsMixin(ExecutionMixin(SchedulerState))),
) {
  constructor(
    db: TaskDB,
    on_task_update: ((task_id: number) => void) | null = null,
    bus: MessageBus | null = null,
  ) {
    super(db, on_task_update, bus);
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

  _schedule_delayed(task: Row): void {
    const delay = task["delay_seconds"] || 0;
    const run_at = new Date(Date.now() + delay * 1000);
    this.db.update_task(task["id"], {
      status: "scheduled",
      next_run_at: dateToLocalIso(run_at),
    });
    this._notify(task["id"]);
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
}
