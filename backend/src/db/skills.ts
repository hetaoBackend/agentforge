// Skill Library persistence: detected patterns, their drafts, and the
// registry of installed skills.

import path from "node:path";
import { nowIso, parseComparableDatetime } from "../util.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

/**
 * True if the pattern's recurrences cluster within `window_days`.
 *
 * Tolerant: if timestamps can't be parsed, don't block promotion.
 */
function within_window(
  first_seen: string,
  last_seen: string,
  window_days: number,
): boolean {
  let f: Date | null;
  let ls: Date | null;
  try {
    f = parseComparableDatetime(first_seen);
    ls = parseComparableDatetime(last_seen);
  } catch {
    return true;
  }
  if (f === null || ls === null) {
    return true;
  }
  // ≙ Python timedelta.days (floor division of the difference)
  return Math.floor((ls.getTime() - f.getTime()) / 86_400_000) <= window_days;
}

export function SkillsMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class SkillsRepo extends Base {
    /**
     * Record one observation of a pattern. Dedup by exact pattern_key.
     *
     * Semantic matching is done by the sweep agent (it reuses an existing key).
     * Counting is idempotent per run: if `run_id` was already counted for this
     * pattern, only the summary/last_seen refresh — recurrence does NOT bump.
     * This lets the manual sweep re-scan recent runs without inflating counts.
     * When run_id is None (legacy / unknown), fall back to bumping per call.
     */
    // ── Skill Library: pattern ledger ─────────────────────────────────────

    upsert_skill_pattern(
      pattern_key: string,
      kind: string,
      summary: string,
      task_id: number | null,
      run_id: number | null = null,
    ): number | null {
      pattern_key = (pattern_key || "").trim();
      if (!pattern_key) {
        return null;
      }
      kind = kind === "recipe" || kind === "pitfall" ? kind : "recipe";
      const now = nowIso();
      const row = this.conn
        .query(
          "SELECT id, contributing_task_ids, contributing_run_ids " +
            "FROM skill_patterns WHERE pattern_key = ?",
        )
        .get(pattern_key) as Row | null;
      if (row) {
        let tids: any[];
        try {
          const parsed = JSON.parse(row["contributing_task_ids"]);
          tids = Array.isArray(parsed) ? [...parsed] : [];
        } catch {
          tids = [];
        }
        let rids: any[];
        try {
          const parsed = JSON.parse(row["contributing_run_ids"] || "[]");
          rids = Array.isArray(parsed) ? [...parsed] : [];
        } catch {
          rids = [];
        }
        const already_counted = run_id !== null && rids.includes(run_id);
        if (task_id !== null && !tids.includes(task_id)) {
          tids.push(task_id);
        }
        if (run_id !== null && !rids.includes(run_id)) {
          rids.push(run_id);
        }
        // Bump only for a genuinely new observation.
        const bump = already_counted ? 0 : 1;
        this.conn
          .query(
            `
            UPDATE skill_patterns
            SET recurrence_count = recurrence_count + ?,
                last_seen = ?,
                updated_at = ?,
                summary = CASE WHEN ? != '' THEN ? ELSE summary END,
                contributing_task_ids = ?,
                contributing_run_ids = ?
            WHERE id = ?
            `,
          )
          .run(
            bump,
            now,
            now,
            summary || "",
            summary || "",
            JSON.stringify(tids),
            JSON.stringify(rids),
            row["id"],
          );
        return Number(row["id"]);
      }
      const tids = task_id !== null ? [task_id] : [];
      const rids = run_id !== null ? [run_id] : [];
      const cur = this.conn
        .query(
          `
          INSERT INTO skill_patterns
              (pattern_key, kind, summary, recurrence_count,
               first_seen, last_seen, contributing_task_ids, contributing_run_ids, status)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'tracking')
          `,
        )
        .run(
          pattern_key,
          kind,
          summary || "",
          now,
          now,
          JSON.stringify(tids),
          JSON.stringify(rids),
        );
      return Number(cur.lastInsertRowid);
    }

    get_skill_patterns(limit: number = 200): Row[] {
      const rows = this.conn
        .query(
          `
          SELECT p.*, d.status AS draft_status, d.name AS draft_name,
                 d.description AS draft_description, d.kind AS draft_kind,
                 d.body AS draft_body, d.error AS draft_error,
                 d.worthy AS draft_worthy, d.worthiness_reason AS draft_worthiness_reason
          FROM skill_patterns p
          LEFT JOIN skill_drafts d ON d.pattern_id = p.id
          ORDER BY p.recurrence_count DESC, p.last_seen DESC
          LIMIT ?
          `,
        )
        .all(limit) as Row[];
      return rows.map((r) => ({ ...r }));
    }

    get_skill_pattern(pattern_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM skill_patterns WHERE id = ?")
        .get(pattern_id) as Row | null;
      return row ? { ...row } : null;
    }

    /** Current recurrence_count for a pattern_key (0 if it doesn't exist yet). */
    get_skill_pattern_recurrence(pattern_key: string): number {
      pattern_key = (pattern_key || "").trim();
      if (!pattern_key) {
        return 0;
      }
      const row = this.conn
        .query(
          "SELECT recurrence_count FROM skill_patterns WHERE pattern_key = ?",
        )
        .get(pattern_key) as Row | null;
      return row ? row["recurrence_count"] : 0;
    }

    /**
     * Promote 'tracking' patterns that cross the threshold to 'candidate'.
     *
     * Threshold (borrowed from pskoett self-improvement): recurrence >= 3 AND
     * >= 2 distinct tasks AND recurrences within a 30-day window. Returns the
     * number newly marked.
     */
    refresh_skill_candidates(
      min_recurrence: number = 3,
      min_tasks: number = 2,
      window_days: number = 30,
    ): number {
      let marked = 0;
      const now = nowIso();
      const rows = this.conn
        .query(
          `
          SELECT id, recurrence_count, contributing_task_ids, first_seen, last_seen
          FROM skill_patterns WHERE status = 'tracking'
          `,
        )
        .all() as Row[];
      for (const r of rows) {
        if (r["recurrence_count"] < min_recurrence) {
          continue;
        }
        let tids: any[];
        try {
          const parsed = JSON.parse(r["contributing_task_ids"]);
          tids = Array.isArray(parsed) ? parsed : [];
        } catch {
          tids = [];
        }
        if (new Set(tids).size < min_tasks) {
          continue;
        }
        if (!within_window(r["first_seen"], r["last_seen"], window_days)) {
          continue;
        }
        this.conn
          .query(
            "UPDATE skill_patterns SET status = 'candidate', updated_at = ? WHERE id = ?",
          )
          .run(now, r["id"]);
        marked += 1;
      }
      return marked;
    }

    set_skill_pattern_status(
      pattern_id: number,
      status: string,
      promoted_skill_id: number | null = null,
    ): void {
      this.conn
        .query(
          `
          UPDATE skill_patterns
          SET status = ?, promoted_skill_id = ?, updated_at = ?
          WHERE id = ?
          `,
        )
        .run(status, promoted_skill_id, nowIso(), pattern_id);
    }

    // ── Skill drafts ───────────────────────────────────────────────────────
    upsert_skill_draft(
      pattern_id: number,
      status: string,
      name: string = "",
      description: string = "",
      kind: string = "recipe",
      body: string = "",
      error: string | null = null,
      worthy: boolean | null = null,
      worthiness_reason: string = "",
    ): void {
      this.conn
        .query(
          `
          INSERT INTO skill_drafts
              (pattern_id, name, description, kind, body, status, error,
               worthy, worthiness_reason, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pattern_id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              kind = excluded.kind,
              body = excluded.body,
              status = excluded.status,
              error = excluded.error,
              worthy = excluded.worthy,
              worthiness_reason = excluded.worthiness_reason,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          pattern_id,
          name,
          description,
          kind,
          body,
          status,
          error,
          worthy === null ? null : worthy ? 1 : 0,
          worthiness_reason,
          nowIso(),
        );
    }

    get_skill_draft(pattern_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM skill_drafts WHERE pattern_id = ?")
        .get(pattern_id) as Row | null;
      return row ? { ...row } : null;
    }

    delete_skill_draft(pattern_id: number): void {
      this.conn
        .query("DELETE FROM skill_drafts WHERE pattern_id = ?")
        .run(pattern_id);
    }

    // ── Skill registry ─────────────────────────────────────────────────────
    // `path` shadows the node:path import inside this method (unused here).
    add_skill(
      name: string,
      description: string,
      path: string,
      source_pattern_key: string | null = null,
      source_task_ids: string | null = null,
      kind: string | null = null,
    ): number | null {
      const cur = this.conn
        .query(
          `
          INSERT INTO skills (name, description, path, source_pattern_key, source_task_ids, kind, enabled)
          VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(name) DO UPDATE SET
              description = excluded.description,
              path = excluded.path,
              source_pattern_key = excluded.source_pattern_key,
              source_task_ids = excluded.source_task_ids,
              kind = excluded.kind,
              enabled = 1
          `,
        )
        .run(
          name,
          description,
          path,
          source_pattern_key,
          source_task_ids,
          kind,
        );
      if (cur.lastInsertRowid) {
        return Number(cur.lastInsertRowid);
      }
      const row = this.conn
        .query("SELECT id FROM skills WHERE name = ?")
        .get(name) as Row | null;
      return row ? Number(row["id"]) : null;
    }

    get_skills(): Row[] {
      const rows = this.conn
        .query("SELECT * FROM skills ORDER BY created_at DESC")
        .all() as Row[];
      return rows.map((r) => ({ ...r }));
    }

    get_skill(skill_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM skills WHERE id = ?")
        .get(skill_id) as Row | null;
      return row ? { ...row } : null;
    }

    set_skill_enabled(skill_id: number, enabled: boolean): void {
      this.conn
        .query("UPDATE skills SET enabled = ? WHERE id = ?")
        .run(enabled ? 1 : 0, skill_id);
    }

    delete_skill(skill_id: number): void {
      this.conn.query("DELETE FROM skills WHERE id = ?").run(skill_id);
    }

    /** Exposed as a static because the ported tests call TaskDB._within_window. */
    static _within_window(
      first_seen: string,
      last_seen: string,
      window_days: number,
    ): boolean {
      return within_window(first_seen, last_seen, window_days);
    }
  };
}
