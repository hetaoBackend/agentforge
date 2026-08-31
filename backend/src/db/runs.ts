// Run history and the streamed output events belonging to each run.

import { nowIso } from "../util.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

export function RunsMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class RunsRepo extends Base {
    add_run(task_id: number): number {
      const cur = this.conn
        .query("INSERT INTO task_runs (task_id, status) VALUES (?, 'running')")
        .run(task_id);
      return Number(cur.lastInsertRowid);
    }

    finish_run(
      run_id: number,
      status: string,
      result: string | null = null,
      error: string | null = null,
      raw_output: string | null = null,
    ): void {
      this.conn
        .query(
          `
          UPDATE task_runs SET finished_at = datetime('now'),
              status = ?, result = ?, error = ?, raw_output = ?
          WHERE id = ?
      `,
        )
        .run(status, result, error, raw_output, run_id);
    }

    /** Atomically finish a run record and update the parent task in one transaction. */
    finish_run_and_update_task(
      run_id: number,
      run_status: string,
      task_id: number,
      task_updates: Record<string, unknown>,
      run_result: string | null = null,
      run_error: string | null = null,
      raw_output: string | null = null,
    ): void {
      const updates: Record<string, unknown> = { ...task_updates };
      updates["updated_at"] = nowIso();
      const sets = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ");
      const vals = [...Object.values(updates), task_id];
      this.transaction(() => {
        this.conn
          .query(
            `
          UPDATE task_runs SET finished_at = datetime('now'),
              status = ?, result = ?, error = ?, raw_output = ?
          WHERE id = ?
      `,
          )
          .run(run_status, run_result, run_error, raw_output, run_id);
        this.conn
          .query(`UPDATE tasks SET ${sets} WHERE id = ?`)
          .run(...(vals as any[]));
      });
    }

    get_task_runs(task_id: number, limit: number = 20): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT * FROM task_runs WHERE task_id = ?
          ORDER BY started_at DESC LIMIT ?
      `,
        )
        .all(task_id, limit) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    /** Add a new output event to the database. */
    add_output_event(
      task_id: number,
      run_id: number,
      event_type: string,
      content: string,
    ): void {
      this.conn
        .query(
          `
          INSERT INTO task_output_events (task_id, run_id, event_type, content)
          VALUES (?, ?, ?, ?)
      `,
        )
        .run(task_id, run_id, event_type, content);
    }

    /** Get output events for a task, ordered by timestamp. */
    get_output_events(
      task_id: number,
      limit: number = 1000,
      offset: number = 0,
    ): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT * FROM task_output_events
          WHERE task_id = ?
          ORDER BY timestamp DESC
          LIMIT ? OFFSET ?
      `,
        )
        .all(task_id, limit, offset) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    /** Get output events for a specific run. */
    get_run_output_events(run_id: number, limit: number = 1000): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT * FROM task_output_events
          WHERE run_id = ?
          ORDER BY timestamp ASC
          LIMIT ?
      `,
        )
        .all(run_id, limit) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    /**
     * Completed task runs finished after `watermark`, oldest first.
     *
     * Joined with task metadata so the sweep agent can read what each run did.
     * Ordering ASC + limit makes the watermark advance incrementally so a large
     * backlog is processed across several sweeps rather than all at once.
     */
    get_completed_runs_since(watermark: string, limit: number = 50): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT r.id AS run_id, r.task_id, r.finished_at, r.result,
                 t.title, t.prompt, t.working_dir, t.agent
          FROM task_runs r
          JOIN tasks t ON t.id = r.task_id
          WHERE r.status = 'completed'
            AND r.finished_at IS NOT NULL
            AND r.finished_at > ?
          ORDER BY r.finished_at ASC
          LIMIT ?
          `,
        )
        .all(watermark || "", limit) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    /** The most recent completed runs regardless of watermark (manual re-scan). */
    get_recent_completed_runs(limit: number = 100): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT r.id AS run_id, r.task_id, r.finished_at, r.result,
                 t.title, t.prompt, t.working_dir, t.agent
          FROM task_runs r
          JOIN tasks t ON t.id = r.task_id
          WHERE r.status = 'completed' AND r.finished_at IS NOT NULL
          ORDER BY r.finished_at DESC
          LIMIT ?
          `,
        )
        .all(limit) as Row[];
      // Return oldest-first so watermark math stays consistent.
      return rows.reverse().map((r) => ({ ...r }));
    }
  };
}
