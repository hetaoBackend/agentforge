// Heartbeats, their ticks, and the trigger de-duplication table.

import { CronExpressionParser } from "cron-parser";
import { dateToLocalIso, nowIso, parseComparableDatetime } from "../util.ts";
import { type Heartbeat, HeartbeatScheduleType } from "../types.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

const ALLOWED_HEARTBEAT_COLUMNS: ReadonlySet<string> = new Set([
  "name",
  "enabled",
  "working_dir",
  "schedule_type",
  "cron_expr",
  "interval_seconds",
  "check_prompt",
  "action_prompt_template",
  "default_agent",
  "cooldown_seconds",
  "next_run_at",
  "last_tick_at",
  "last_decision",
  "last_error",
  "last_triggered_at",
  "last_dedupe_key",
  "updated_at",
]);

export function HeartbeatsMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class HeartbeatsRepo extends Base {
    private _deserialize_heartbeat(row: Row): Row {
      const d: Row = { ...row };
      d["enabled"] = Boolean(d["enabled"]);
      return d;
    }

    _compute_heartbeat_next_run_at(
      heartbeat: Heartbeat,
      now: Date | null = null,
    ): string {
      const base = now ?? new Date();
      if (heartbeat.schedule_type === HeartbeatScheduleType.CRON) {
        if (!heartbeat.cron_expr) {
          throw new Error("cron heartbeat requires cron_expr");
        }
        return dateToLocalIso(
          CronExpressionParser.parse(heartbeat.cron_expr, { currentDate: base })
            .next()
            .toDate(),
        );
      }
      if (heartbeat.schedule_type === HeartbeatScheduleType.INTERVAL) {
        if (!heartbeat.interval_seconds || heartbeat.interval_seconds <= 0) {
          throw new Error("interval heartbeat requires interval_seconds > 0");
        }
        return dateToLocalIso(
          new Date(
            base.getTime() + Math.trunc(heartbeat.interval_seconds) * 1000,
          ),
        );
      }
      throw new Error(
        `Unsupported heartbeat schedule_type: ${heartbeat.schedule_type}`,
      );
    }

    add_heartbeat(heartbeat: Heartbeat): number {
      const now = nowIso();
      if (heartbeat.next_run_at === null) {
        heartbeat.next_run_at = this._compute_heartbeat_next_run_at(
          heartbeat,
          new Date(),
        );
      }
      const cur = this.conn
        .query(
          `
          INSERT INTO heartbeats (
              name, enabled, working_dir, schedule_type, cron_expr,
              interval_seconds, check_prompt, action_prompt_template,
              default_agent, cooldown_seconds, next_run_at, last_tick_at,
              last_decision, last_error, last_triggered_at, last_dedupe_key,
              created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          heartbeat.name,
          heartbeat.enabled ? 1 : 0,
          heartbeat.working_dir,
          heartbeat.schedule_type,
          heartbeat.cron_expr,
          heartbeat.interval_seconds,
          heartbeat.check_prompt,
          heartbeat.action_prompt_template,
          heartbeat.default_agent,
          heartbeat.cooldown_seconds,
          heartbeat.next_run_at,
          heartbeat.last_tick_at,
          heartbeat.last_decision,
          heartbeat.last_error,
          heartbeat.last_triggered_at,
          heartbeat.last_dedupe_key,
          now,
          now,
        );
      return Number(cur.lastInsertRowid);
    }

    update_heartbeat(
      heartbeat_id: number,
      kwargs: Record<string, unknown>,
    ): void {
      const invalid = Object.keys(kwargs).filter(
        (k) => !ALLOWED_HEARTBEAT_COLUMNS.has(k),
      );
      if (invalid.length) {
        throw new Error(
          `Invalid heartbeat column(s): ${JSON.stringify(invalid)}`,
        );
      }
      const updates: Record<string, unknown> = { ...kwargs };
      updates["updated_at"] = nowIso();
      const sets = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ");
      const vals = [...Object.values(updates), heartbeat_id];
      this.conn
        .query(`UPDATE heartbeats SET ${sets} WHERE id = ?`)
        .run(...(vals as any[]));
    }

    get_heartbeat(heartbeat_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM heartbeats WHERE id = ?")
        .get(heartbeat_id) as Row | null;
      return row ? this._deserialize_heartbeat(row) : null;
    }

    get_all_heartbeats(): Row[] {
      const rows = this.conn
        .query("SELECT * FROM heartbeats ORDER BY created_at DESC")
        .all() as Row[];
      return rows.map((r) => this._deserialize_heartbeat(r));
    }

    get_due_heartbeats(): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT * FROM heartbeats
          WHERE enabled = 1
            AND next_run_at IS NOT NULL
      `,
        )
        .all() as Row[];
      const now = new Date();
      const due: Row[] = [];
      for (const row of rows) {
        const heartbeat = this._deserialize_heartbeat(row);
        let next_run_at: Date | null;
        try {
          next_run_at = parseComparableDatetime(heartbeat["next_run_at"]);
        } catch {
          continue;
        }
        if (next_run_at && next_run_at.getTime() <= now.getTime()) {
          due.push(heartbeat);
        }
      }
      return due;
    }

    delete_heartbeat(heartbeat_id: number): void {
      this.transaction(() => {
        this.conn
          .query("DELETE FROM heartbeat_ticks WHERE heartbeat_id = ?")
          .run(heartbeat_id);
        this.conn
          .query("DELETE FROM heartbeat_dedup WHERE heartbeat_id = ?")
          .run(heartbeat_id);
        this.conn
          .query("DELETE FROM heartbeats WHERE id = ?")
          .run(heartbeat_id);
      });
    }

    add_heartbeat_tick(heartbeat_id: number): number {
      const cur = this.conn
        .query(
          `
          INSERT INTO heartbeat_ticks (heartbeat_id, started_at, status)
          VALUES (?, ?, 'running')
      `,
        )
        .run(heartbeat_id, nowIso());
      return Number(cur.lastInsertRowid);
    }

    finish_heartbeat_tick(
      tick_id: number,
      status: string,
      decision_type: string | null = null,
      decision_payload: Record<string, unknown> | null = null,
      task_id: number | null = null,
      raw_output: string | null = null,
      error: string | null = null,
    ): void {
      const payload_json =
        decision_payload !== null ? JSON.stringify(decision_payload) : null;
      this.conn
        .query(
          `
          UPDATE heartbeat_ticks
          SET finished_at = ?, status = ?, decision_type = ?, decision_payload = ?, task_id = ?, raw_output = ?, error = ?
          WHERE id = ?
      `,
        )
        .run(
          nowIso(),
          status,
          decision_type,
          payload_json,
          task_id,
          raw_output,
          error,
          tick_id,
        );
    }

    get_heartbeat_ticks(heartbeat_id: number, limit: number = 50): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT * FROM heartbeat_ticks
          WHERE heartbeat_id = ?
          ORDER BY started_at DESC
          LIMIT ?
      `,
        )
        .all(heartbeat_id, limit) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    get_heartbeat_tick(heartbeat_id: number, tick_id: number): Row | null {
      const row = this.conn
        .query(
          `
          SELECT * FROM heartbeat_ticks
          WHERE heartbeat_id = ? AND id = ?
      `,
        )
        .get(heartbeat_id, tick_id) as Row | null;
      return row ? { ...row } : null;
    }

    get_latest_heartbeat_tick(heartbeat_id: number): Row | null {
      const row = this.conn
        .query(
          `
          SELECT * FROM heartbeat_ticks
          WHERE heartbeat_id = ?
          ORDER BY started_at DESC
          LIMIT 1
      `,
        )
        .get(heartbeat_id) as Row | null;
      return row ? { ...row } : null;
    }

    get_heartbeat_dedup(heartbeat_id: number, dedupe_key: string): Row | null {
      const row = this.conn
        .query(
          `
          SELECT * FROM heartbeat_dedup
          WHERE heartbeat_id = ? AND dedupe_key = ?
      `,
        )
        .get(heartbeat_id, dedupe_key) as Row | null;
      return row ? { ...row } : null;
    }

    upsert_heartbeat_dedup(
      heartbeat_id: number,
      dedupe_key: string,
      task_id: number | null,
    ): void {
      const now = nowIso();
      this.conn
        .query(
          `
          INSERT INTO heartbeat_dedup (heartbeat_id, dedupe_key, task_id, triggered_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(heartbeat_id, dedupe_key)
          DO UPDATE SET task_id = excluded.task_id, triggered_at = excluded.triggered_at
      `,
        )
        .run(heartbeat_id, dedupe_key, task_id, now);
    }
  };
}
