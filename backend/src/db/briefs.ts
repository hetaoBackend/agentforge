// Task briefs: the draft a chat channel builds before a task is confirmed.

import { nowIso } from "../util.ts";
import { type TaskBrief, TaskBriefStatus } from "../types.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

const ALLOWED_TASK_BRIEF_COLUMNS: ReadonlySet<string> = new Set([
  "status",
  "title",
  "goal",
  "context_summary",
  "acceptance_criteria",
  "working_dir",
  "working_dir_confidence",
  "agent",
  "risk_level",
  "needs_confirmation",
  "source_channel",
  "source_ref",
  "source_metadata",
  "created_task_id",
  "expires_at",
]);

export function BriefsMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class BriefsRepo extends Base {
    private _serialize_task_brief_value(key: string, value: unknown): unknown {
      if (key === "acceptance_criteria") {
        return JSON.stringify(Array.isArray(value) ? value.map(String) : []);
      }
      if (key === "source_metadata") {
        return JSON.stringify(
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {},
        );
      }
      if (key === "needs_confirmation") {
        return value ? 1 : 0;
      }
      return value;
    }

    private _deserialize_task_brief(row: Row): Row {
      const d: Row = { ...row };
      try {
        const parsed = JSON.parse(String(d["acceptance_criteria"] ?? "[]"));
        d["acceptance_criteria"] = Array.isArray(parsed) ? parsed : [];
      } catch {
        d["acceptance_criteria"] = [];
      }
      try {
        const parsed = JSON.parse(String(d["source_metadata"] ?? "{}"));
        d["source_metadata"] =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? parsed
            : {};
      } catch {
        d["source_metadata"] = {};
      }
      d["needs_confirmation"] = Boolean(d["needs_confirmation"]);
      return d;
    }

    add_task_brief(brief: TaskBrief): number {
      const now = nowIso();
      const cur = this.conn
        .query(
          `
          INSERT INTO task_briefs (
              status, title, goal, context_summary, acceptance_criteria,
              working_dir, working_dir_confidence, agent, risk_level,
              needs_confirmation, source_channel, source_ref, source_metadata,
              created_task_id, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          brief.status,
          brief.title,
          brief.goal,
          brief.context_summary,
          JSON.stringify(brief.acceptance_criteria.map(String)),
          brief.working_dir,
          brief.working_dir_confidence,
          brief.agent,
          brief.risk_level,
          brief.needs_confirmation ? 1 : 0,
          brief.source_channel,
          brief.source_ref,
          JSON.stringify(brief.source_metadata),
          brief.created_task_id,
          now,
          now,
          brief.expires_at,
        );
      return Number(cur.lastInsertRowid);
    }

    get_task_brief(brief_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM task_briefs WHERE id = ?")
        .get(brief_id) as Row | null;
      return row ? this._deserialize_task_brief(row) : null;
    }

    get_task_briefs(status: string | null = null): Row[] {
      const rows =
        status === null
          ? (this.conn
              .query(
                "SELECT * FROM task_briefs ORDER BY updated_at DESC, id DESC",
              )
              .all() as Row[])
          : (this.conn
              .query(
                "SELECT * FROM task_briefs WHERE status = ? ORDER BY updated_at DESC, id DESC",
              )
              .all(status) as Row[]);
      return rows.map((r) => this._deserialize_task_brief(r));
    }

    update_task_brief(brief_id: number, kwargs: Record<string, unknown>): void {
      const invalid = Object.keys(kwargs).filter(
        (k) => !ALLOWED_TASK_BRIEF_COLUMNS.has(k),
      );
      if (invalid.length) {
        throw new Error(
          `Invalid task brief column(s): ${JSON.stringify(invalid)}`,
        );
      }
      const updates: Record<string, unknown> = {
        ...kwargs,
        updated_at: nowIso(),
      };
      const sets = Object.keys(updates)
        .map((k) => `${k} = ?`)
        .join(", ");
      const vals = [
        ...Object.entries(updates).map(([k, v]) =>
          this._serialize_task_brief_value(k, v),
        ),
        brief_id,
      ];
      this.conn
        .query(`UPDATE task_briefs SET ${sets} WHERE id = ?`)
        .run(...(vals as any[]));
    }

    discard_task_brief(brief_id: number): void {
      this.update_task_brief(brief_id, { status: TaskBriefStatus.DISCARDED });
    }

    confirm_task_brief(brief_id: number, task_id: number): void {
      this.update_task_brief(brief_id, {
        status: TaskBriefStatus.CONVERTED,
        created_task_id: task_id,
      });
    }
  };
}
