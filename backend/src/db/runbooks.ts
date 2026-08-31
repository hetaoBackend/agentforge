// IM runbooks: named, reusable multi-task templates.

import { nowIso } from "../util.ts";
import type { IMRunbook } from "../types.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

const ALLOWED_IM_RUNBOOK_COLUMNS: ReadonlySet<string> = new Set([
  "name",
  "aliases",
  "description",
  "source_type",
  "source_id",
  "command_schema",
  "prompt_template",
  "default_agent",
  "confirmation_policy",
  "enabled",
]);

export function RunbooksMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class RunbooksRepo extends Base {
    private _serialize_im_runbook_value(key: string, value: unknown): unknown {
      if (key === "aliases") {
        return JSON.stringify(Array.isArray(value) ? value.map(String) : []);
      }
      if (key === "command_schema") {
        return JSON.stringify(
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? value
            : {},
        );
      }
      if (key === "enabled") {
        return value ? 1 : 0;
      }
      return value;
    }

    private _deserialize_im_runbook(row: Row): Row {
      const d: Row = { ...row };
      try {
        const parsed = JSON.parse(String(d["aliases"] ?? "[]"));
        d["aliases"] = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        d["aliases"] = [];
      }
      try {
        const parsed = JSON.parse(String(d["command_schema"] ?? "{}"));
        d["command_schema"] =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
            ? parsed
            : {};
      } catch {
        d["command_schema"] = {};
      }
      d["enabled"] = Boolean(d["enabled"]);
      return d;
    }

    add_im_runbook(runbook: IMRunbook): number {
      const now = nowIso();
      const cur = this.conn
        .query(
          `
          INSERT INTO im_runbooks (
              name, aliases, description, source_type, source_id,
              command_schema, prompt_template, default_agent,
              confirmation_policy, enabled, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          runbook.name,
          JSON.stringify(runbook.aliases.map(String)),
          runbook.description,
          runbook.source_type,
          runbook.source_id,
          JSON.stringify(runbook.command_schema),
          runbook.prompt_template,
          runbook.default_agent,
          runbook.confirmation_policy,
          runbook.enabled ? 1 : 0,
          now,
          now,
        );
      return Number(cur.lastInsertRowid);
    }

    get_im_runbook(runbook_id: number): Row | null {
      const row = this.conn
        .query("SELECT * FROM im_runbooks WHERE id = ?")
        .get(runbook_id) as Row | null;
      return row ? this._deserialize_im_runbook(row) : null;
    }

    get_im_runbook_by_name(nameOrAlias: string): Row | null {
      const normalized = nameOrAlias.toLowerCase();
      for (const runbook of this.get_im_runbooks()) {
        const name = String(runbook["name"] ?? "").toLowerCase();
        const aliases = Array.isArray(runbook["aliases"])
          ? runbook["aliases"].map((alias) => String(alias).toLowerCase())
          : [];
        if (name === normalized || aliases.includes(normalized)) {
          return runbook;
        }
      }
      return null;
    }

    get_im_runbooks(enabled_only: boolean = false): Row[] {
      const rows = enabled_only
        ? (this.conn
            .query(
              "SELECT * FROM im_runbooks WHERE enabled = 1 ORDER BY updated_at DESC, id DESC",
            )
            .all() as Row[])
        : (this.conn
            .query(
              "SELECT * FROM im_runbooks ORDER BY updated_at DESC, id DESC",
            )
            .all() as Row[]);
      return rows.map((row) => this._deserialize_im_runbook(row));
    }

    update_im_runbook(
      runbook_id: number,
      kwargs: Record<string, unknown>,
    ): void {
      const invalid = Object.keys(kwargs).filter(
        (k) => !ALLOWED_IM_RUNBOOK_COLUMNS.has(k),
      );
      if (invalid.length) {
        throw new Error(
          `Invalid IM runbook column(s): ${JSON.stringify(invalid)}`,
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
          this._serialize_im_runbook_value(k, v),
        ),
        runbook_id,
      ];
      this.conn
        .query(`UPDATE im_runbooks SET ${sets} WHERE id = ?`)
        .run(...(vals as any[]));
    }

    delete_im_runbook(runbook_id: number): void {
      this.conn.query("DELETE FROM im_runbooks WHERE id = ?").run(runbook_id);
    }
  };
}
