// Per-channel bookkeeping for skill suggestions pushed into IM threads.

import { nowIso } from "../util.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

export function SuggestionsMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class SuggestionsRepo extends Base {
    // ── IM Skill Suggestions ──────────────────────────────────────────────

    private _normalize_im_skill_suggestion_target(
      target: string | null | undefined,
    ): string {
      return String(target ?? "").trim();
    }

    private _deserialize_im_skill_suggestion(row: Row): Row {
      const d: Row = { ...row };
      try {
        const parsed = JSON.parse(String(d["metadata"] ?? "{}"));
        d["metadata"] =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? parsed
            : {};
      } catch {
        d["metadata"] = {};
      }
      return d;
    }

    upsert_im_skill_suggestion(input: {
      pattern_id: number;
      channel: string;
      target?: string | null;
      status?: string;
      metadata?: Record<string, unknown>;
    }): void {
      const pattern_id = Number(input.pattern_id);
      const channel = String(input.channel ?? "").trim();
      if (!Number.isInteger(pattern_id) || pattern_id <= 0) {
        throw new Error("pattern_id is required");
      }
      if (!channel) {
        throw new Error("channel is required");
      }
      const target = this._normalize_im_skill_suggestion_target(input.target);
      const status = String(input.status ?? "suggested").trim() || "suggested";
      const now = nowIso();
      this.conn
        .query(
          `
          INSERT INTO im_skill_suggestions (
              pattern_id, channel, target, status, suggested_at,
              metadata, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pattern_id, channel, target) DO UPDATE SET
              status = excluded.status,
              suggested_at = COALESCE(im_skill_suggestions.suggested_at, excluded.suggested_at),
              metadata = excluded.metadata,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          pattern_id,
          channel,
          target,
          status,
          now,
          JSON.stringify(input.metadata ?? {}),
          now,
          now,
        );
    }

    get_im_skill_suggestion(
      pattern_id: number,
      channel: string,
      target: string | null = null,
    ): Row | null {
      const row = this.conn
        .query(
          `
          SELECT * FROM im_skill_suggestions
          WHERE pattern_id = ? AND channel = ? AND target = ?
          `,
        )
        .get(
          pattern_id,
          String(channel ?? "").trim(),
          this._normalize_im_skill_suggestion_target(target),
        ) as Row | null;
      return row ? this._deserialize_im_skill_suggestion(row) : null;
    }

    should_send_im_skill_suggestion(
      pattern_id: number,
      channel: string,
      target: string | null = null,
    ): boolean {
      return this.get_im_skill_suggestion(pattern_id, channel, target) === null;
    }

    mark_im_skill_suggestion_draft_shown(
      pattern_id: number,
      channel: string,
      target: string | null = null,
    ): void {
      const existing = this.get_im_skill_suggestion(
        pattern_id,
        channel,
        target,
      );
      if (!existing) {
        this.upsert_im_skill_suggestion({
          pattern_id,
          channel,
          target,
          status: "suggested",
        });
      }
      this.conn
        .query(
          `
          UPDATE im_skill_suggestions
          SET draft_shown_at = ?, updated_at = ?
          WHERE pattern_id = ? AND channel = ? AND target = ?
          `,
        )
        .run(
          nowIso(),
          nowIso(),
          pattern_id,
          String(channel ?? "").trim(),
          this._normalize_im_skill_suggestion_target(target),
        );
    }

    mark_im_skill_suggestion_status(
      pattern_id: number,
      channel: string,
      target: string | null,
      status: "dismissed" | "approved",
    ): void {
      const existing = this.get_im_skill_suggestion(
        pattern_id,
        channel,
        target,
      );
      if (!existing) {
        this.upsert_im_skill_suggestion({
          pattern_id,
          channel,
          target,
          status: "suggested",
        });
      }
      const now = nowIso();
      const timestampColumn =
        status === "dismissed" ? "dismissed_at" : "approved_at";
      this.conn
        .query(
          `
          UPDATE im_skill_suggestions
          SET status = ?, ${timestampColumn} = ?, updated_at = ?
          WHERE pattern_id = ? AND channel = ? AND target = ?
          `,
        )
        .run(
          status,
          now,
          now,
          pattern_id,
          String(channel ?? "").trim(),
          this._normalize_im_skill_suggestion_target(target),
        );
    }
  };
}
