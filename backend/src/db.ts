// TaskDB: SQLite persistence layer, ported from taskboard.py (class TaskDB).
// Method names, SQL, column names and defaults intentionally mirror the Python
// source. Bun is single-threaded, so Python's RLock has no TS equivalent.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronExpressionParser } from "cron-parser";
import { logger } from "./log.ts";
import {
  dateToLocalIso,
  normalizeDatetimeForStorage,
  nowIso,
  parseComparableDatetime,
} from "./util.ts";
import { HeartbeatScheduleType, type Heartbeat, type Task } from "./types.ts";

type Row = Record<string, any>;

function expandUser(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export class TaskDB {
  db_path: string;
  conn: Database;

  constructor(db_path: string = "~/.agentforge/tasks.db") {
    this.db_path = expandUser(db_path);
    fs.mkdirSync(path.dirname(this.db_path), { recursive: true });
    this.conn = new Database(this.db_path, { create: true });
    this._init_db();
  }

  /** Run a migration statement, ignoring "column already exists" errors. */
  private _migrate(sql: string): void {
    try {
      this.conn.run(sql);
    } catch {
      // Column already exists
    }
  }

  private _init_db(): void {
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          working_dir TEXT DEFAULT '.',
          status TEXT DEFAULT 'pending',
          schedule_type TEXT DEFAULT 'immediate',
          cron_expr TEXT,
          delay_seconds INTEGER,
          next_run_at TEXT,
          last_run_at TEXT,
          result TEXT,
          error TEXT,
          run_count INTEGER DEFAULT 0,
          max_runs INTEGER,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          tags TEXT DEFAULT '',
          agent TEXT DEFAULT 'codex',
          question TEXT,
          answer TEXT
      )
    `);
    // Migrations for existing DBs (each is a no-op when the column exists)
    this._migrate("ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT 'codex'");
    // question/answer share one try block, mirroring Python: if `question`
    // already exists the `answer` migration is skipped in the same way.
    try {
      this.conn.run("ALTER TABLE tasks ADD COLUMN question TEXT");
      this.conn.run("ALTER TABLE tasks ADD COLUMN answer TEXT");
    } catch {
      // Columns already exist
    }
    this._migrate("ALTER TABLE tasks ADD COLUMN session_id TEXT");
    this._migrate(
      "ALTER TABLE tasks ADD COLUMN prompt_images TEXT DEFAULT '[]'",
    );
    this._migrate("ALTER TABLE tasks ADD COLUMN image_paths TEXT DEFAULT '[]'");
    this._migrate("ALTER TABLE tasks ADD COLUMN notify_slack_channel TEXT");
    this._migrate("ALTER TABLE tasks ADD COLUMN notify_telegram_chat_id TEXT");

    this.conn.run(`
      CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
      )
    `);
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS task_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          started_at TEXT DEFAULT (datetime('now')),
          finished_at TEXT,
          status TEXT,
          result TEXT,
          error TEXT,
          raw_output TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
    this._migrate("ALTER TABLE task_runs ADD COLUMN raw_output TEXT");

    this.conn.run(`
      CREATE TABLE IF NOT EXISTS heartbeats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          working_dir TEXT DEFAULT '.',
          schedule_type TEXT NOT NULL,
          cron_expr TEXT,
          interval_seconds INTEGER,
          check_prompt TEXT NOT NULL,
          action_prompt_template TEXT DEFAULT '',
          default_agent TEXT DEFAULT 'codex',
          cooldown_seconds INTEGER DEFAULT 0,
          next_run_at TEXT,
          last_tick_at TEXT,
          last_decision TEXT,
          last_error TEXT,
          last_triggered_at TEXT,
          last_dedupe_key TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_next_run
      ON heartbeats(enabled, next_run_at)
    `);
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS heartbeat_ticks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          heartbeat_id INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          decision_type TEXT,
          decision_payload TEXT,
          task_id INTEGER,
          raw_output TEXT,
          error TEXT,
          FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_heartbeat_ticks_heartbeat_id
      ON heartbeat_ticks(heartbeat_id, started_at DESC)
    `);
    this._migrate("ALTER TABLE heartbeat_ticks ADD COLUMN raw_output TEXT");
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS heartbeat_dedup (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          heartbeat_id INTEGER NOT NULL,
          dedupe_key TEXT NOT NULL,
          task_id INTEGER,
          triggered_at TEXT NOT NULL,
          FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          UNIQUE(heartbeat_id, dedupe_key)
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_heartbeat_dedup_heartbeat_id
      ON heartbeat_dedup(heartbeat_id, triggered_at DESC)
    `);

    // Structured output recording
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS task_output_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          run_id INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (run_id) REFERENCES task_runs(id)
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_task_output_events_task_id
      ON task_output_events(task_id)
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_task_output_events_run_id
      ON task_output_events(run_id)
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_task_output_events_timestamp
      ON task_output_events(timestamp)
    `);

    // DAG dependency table
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL,
          depends_on_task_id INTEGER NOT NULL,
          inject_result INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id),
          UNIQUE(task_id, depends_on_task_id)
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_task_deps_task_id
      ON task_dependencies(task_id)
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on
      ON task_dependencies(depends_on_task_id)
    `);

    // Skill Library: cross-run pattern ledger. The sweep agent tallies
    // recurring task patterns here (dedup by semantic pattern_key); once a
    // pattern crosses the recurrence threshold it becomes a skill candidate.
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS skill_patterns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern_key TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'recipe',
          summary TEXT NOT NULL DEFAULT '',
          recurrence_count INTEGER NOT NULL DEFAULT 1,
          first_seen TEXT DEFAULT (datetime('now')),
          last_seen TEXT DEFAULT (datetime('now')),
          contributing_task_ids TEXT NOT NULL DEFAULT '[]',
          contributing_run_ids TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'tracking',
          promoted_skill_id INTEGER,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.conn.run(`
      CREATE INDEX IF NOT EXISTS idx_skill_patterns_status
      ON skill_patterns(status, recurrence_count DESC)
    `);
    // Migration: per-run idempotency ledger so a run is only ever counted
    // once (lets the manual sweep re-scan recent runs without inflating counts).
    this._migrate(
      "ALTER TABLE skill_patterns ADD COLUMN contributing_run_ids TEXT NOT NULL DEFAULT '[]'",
    );
    // Backfill run-id sets for pre-existing patterns from their tasks' completed
    // runs, so a re-scan dedups against real run ids instead of re-counting them.
    try {
      const legacy = this.conn
        .query(
          "SELECT id, contributing_task_ids FROM skill_patterns " +
            "WHERE contributing_run_ids IN ('[]', '') OR contributing_run_ids IS NULL",
        )
        .all() as Row[];
      for (const row of legacy) {
        let tids: any[];
        try {
          const parsed = JSON.parse(row["contributing_task_ids"]);
          tids = Array.isArray(parsed) ? parsed : [];
        } catch {
          tids = [];
        }
        if (!tids.length) continue;
        const placeholders = tids.map(() => "?").join(",");
        const runRows = this.conn
          .query(
            `SELECT id FROM task_runs WHERE status = 'completed' AND task_id IN (${placeholders})`,
          )
          .all(...tids) as Row[];
        const run_ids = runRows.map((r) => r["id"]);
        if (run_ids.length) {
          this.conn
            .query(
              "UPDATE skill_patterns SET contributing_run_ids = ? WHERE id = ?",
            )
            .run(JSON.stringify(run_ids), row["id"]);
        }
      }
    } catch {
      // table shape predates the run-id ledger; ignore
    }

    // Skill Library: registry of distilled, approved skills. The canonical
    // SKILL.md lives at `path` (~/.claude/skills/<name>/SKILL.md) and is
    // symlinked into ~/.agents/skills for codex. `enabled` toggles whether
    // the symlinks exist (i.e. whether agents load it).
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS skills (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          path TEXT NOT NULL,
          source_pattern_key TEXT,
          source_task_ids TEXT,
          kind TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // Skill Library: one pending draft per candidate pattern (agent-distilled
    // SKILL.md awaiting human review/approval).
    this.conn.run(`
      CREATE TABLE IF NOT EXISTS skill_drafts (
          pattern_id INTEGER PRIMARY KEY,
          name TEXT DEFAULT '',
          description TEXT DEFAULT '',
          kind TEXT DEFAULT 'recipe',
          body TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'drafting',
          error TEXT,
          worthy INTEGER,
          worthiness_reason TEXT DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (pattern_id) REFERENCES skill_patterns(id)
      )
    `);
    // Migration: add skill-creator worthiness judgment to existing draft tables
    for (const [col, decl] of [
      ["worthy", "INTEGER"],
      ["worthiness_reason", "TEXT DEFAULT ''"],
    ] as const) {
      this._migrate(`ALTER TABLE skill_drafts ADD COLUMN ${col} ${decl}`);
    }

    this._migrate("ALTER TABLE tasks ADD COLUMN dag_id TEXT");
    // Migration: add feishu_root_msg_id column for post-restart resume
    this._migrate("ALTER TABLE tasks ADD COLUMN feishu_root_msg_id TEXT");

    // On startup, reset any tasks left in 'running' state — they were
    // interrupted by a process kill (e.g. hot reload) and will never
    // self-transition to completed/failed without this reset.
    const now = nowIso();
    this.conn
      .query(
        `
        UPDATE tasks
        SET status = 'failed',
            error  = 'Interrupted: process was restarted while task was running',
            updated_at = ?
        WHERE status = 'running'
    `,
      )
      .run(now);
    // Also close out any open task_runs rows that have no finished_at
    this.conn
      .query(
        `
        UPDATE task_runs
        SET status = 'failed',
            finished_at = ?,
            error = 'Interrupted: process was restarted while task was running'
        WHERE finished_at IS NULL
    `,
      )
      .run(now);
  }

  /**
   * Run statements in an explicit transaction.
   *
   * On success the transaction is committed; on any exception it is rolled
   * back and the exception re-raised. Callers must NOT issue COMMIT or
   * ROLLBACK themselves inside the callback.
   */
  transaction<T>(fn: () => T): T {
    this.conn.run("BEGIN");
    try {
      const result = fn();
      this.conn.run("COMMIT");
      return result;
    } catch (e) {
      this.conn.run("ROLLBACK");
      throw e;
    }
  }

  add_task(task: Task): number {
    const now = nowIso();
    logger.debug(
      `add_task called with image_paths: ${JSON.stringify(task.image_paths)}`,
    );
    const image_paths_json = JSON.stringify(task.image_paths);
    logger.debug(`image_paths JSON: ${image_paths_json}`);
    const cur = this.conn
      .query(
        `
        INSERT INTO tasks (title, prompt, working_dir, status, schedule_type,
            cron_expr, delay_seconds, next_run_at, max_runs, created_at, updated_at, tags, agent, prompt_images, image_paths, dag_id, feishu_root_msg_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        task.title,
        task.prompt,
        task.working_dir,
        task.status,
        task.schedule_type,
        task.cron_expr,
        task.delay_seconds,
        task.next_run_at,
        task.max_runs,
        now,
        now,
        task.tags,
        task.agent,
        JSON.stringify(task.prompt_images),
        image_paths_json,
        task.dag_id,
        task.feishu_root_msg_id,
      );
    const task_id = Number(cur.lastInsertRowid);
    logger.debug(`Task ${task_id} inserted with image_paths`);
    return task_id;
  }

  /** Look up the most recent task created from a given Feishu root message ID. */
  get_task_by_feishu_root_msg(root_msg_id: string): Row | null {
    const row = this.conn
      .query(
        "SELECT * FROM tasks WHERE feishu_root_msg_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(root_msg_id) as Row | null;
    return row ? { ...row } : null;
  }

  get_setting(key: string, defaultValue: string | null = null): string | null {
    const row = this.conn
      .query("SELECT value FROM settings WHERE key = ?")
      .get(key) as Row | null;
    return row ? row["value"] : defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.conn
      .query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }

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

  static readonly ALLOWED_HEARTBEAT_COLUMNS: ReadonlySet<string> = new Set([
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

  update_heartbeat(
    heartbeat_id: number,
    kwargs: Record<string, unknown>,
  ): void {
    const invalid = Object.keys(kwargs).filter(
      (k) => !TaskDB.ALLOWED_HEARTBEAT_COLUMNS.has(k),
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
      this.conn.query("DELETE FROM heartbeats WHERE id = ?").run(heartbeat_id);
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

  static readonly ALLOWED_TASK_COLUMNS: ReadonlySet<string> = new Set([
    "title",
    "prompt",
    "working_dir",
    "status",
    "schedule_type",
    "cron_expr",
    "delay_seconds",
    "next_run_at",
    "last_run_at",
    "result",
    "error",
    "run_count",
    "max_runs",
    "updated_at",
    "tags",
    "agent",
    "question",
    "answer",
    "session_id",
    "prompt_images",
    "image_paths",
    "dag_id",
  ]);

  update_task(task_id: number, kwargs: Record<string, unknown>): void {
    const invalid = Object.keys(kwargs).filter(
      (k) => !TaskDB.ALLOWED_TASK_COLUMNS.has(k),
    );
    if (invalid.length) {
      throw new Error(`Invalid task column(s): ${JSON.stringify(invalid)}`);
    }
    const updates: Record<string, unknown> = { ...kwargs };
    if ("next_run_at" in updates) {
      updates["next_run_at"] = normalizeDatetimeForStorage(
        updates["next_run_at"] as string | null | undefined,
      );
    }
    updates["updated_at"] = nowIso();
    const sets = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    const vals = [...Object.values(updates), task_id];
    this.conn
      .query(`UPDATE tasks SET ${sets} WHERE id = ?`)
      .run(...(vals as any[]));
  }

  private _deserialize_task(row: Row): Row {
    const d: Row = { ...row };
    // Deserialize prompt_images
    const raw = d["prompt_images"];
    if (typeof raw === "string") {
      try {
        d["prompt_images"] = JSON.parse(raw);
      } catch {
        d["prompt_images"] = [];
      }
    } else if (
      d["prompt_images"] === null ||
      d["prompt_images"] === undefined
    ) {
      d["prompt_images"] = [];
    }
    // Deserialize image_paths
    const raw_paths = d["image_paths"];
    if (typeof raw_paths === "string") {
      try {
        d["image_paths"] = JSON.parse(raw_paths);
      } catch {
        d["image_paths"] = [];
      }
    } else if (d["image_paths"] === null || d["image_paths"] === undefined) {
      d["image_paths"] = [];
    }
    return d;
  }

  get_task(task_id: number): Row | null {
    const row = this.conn
      .query("SELECT * FROM tasks WHERE id = ?")
      .get(task_id) as Row | null;
    return row ? this._deserialize_task(row) : null;
  }

  get_all_tasks(): Row[] {
    const rows = this.conn
      .query("SELECT * FROM tasks ORDER BY created_at DESC")
      .all() as Row[];
    return rows.map((r) => this._deserialize_task(r));
  }

  get_due_tasks(): Row[] {
    const rows = this.conn
      .query(
        `
        SELECT * FROM tasks
        WHERE status IN ('pending', 'scheduled')
    `,
      )
      .all() as Row[];
    const now = new Date();
    const due: Row[] = [];
    for (const row of rows) {
      const task = this._deserialize_task(row);
      let next_run_at: Date | null;
      try {
        next_run_at = parseComparableDatetime(task["next_run_at"]);
      } catch {
        continue;
      }
      if (next_run_at === null || next_run_at.getTime() <= now.getTime()) {
        due.push(task);
      }
    }
    return due;
  }

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

  // ── Skill Library: pattern ledger ──────────────────────────────────────

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

  /**
   * Record one observation of a pattern. Dedup by exact pattern_key.
   *
   * Semantic matching is done by the sweep agent (it reuses an existing key).
   * Counting is idempotent per run: if `run_id` was already counted for this
   * pattern, only the summary/last_seen refresh — recurrence does NOT bump.
   * This lets the manual sweep re-scan recent runs without inflating counts.
   * When run_id is None (legacy / unknown), fall back to bumping per call.
   */
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
   * True if the pattern's recurrences cluster within `window_days`.
   *
   * Tolerant: if timestamps can't be parsed, don't block promotion.
   */
  static _within_window(
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
      if (
        !TaskDB._within_window(r["first_seen"], r["last_seen"], window_days)
      ) {
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
      .run(name, description, path, source_pattern_key, source_task_ids, kind);
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

  add_dependency(
    task_id: number,
    depends_on_task_id: number,
    inject_result: boolean = false,
  ): void {
    this.conn
      .query(
        `
        INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, inject_result)
        VALUES (?, ?, ?)
    `,
      )
      .run(task_id, depends_on_task_id, inject_result ? 1 : 0);
  }

  /**
   * Insert multiple dependency rows for task_id in a single transaction.
   *
   * dep_list: list of objects with keys task_id (upstream) and inject_result.
   * Rolls back all inserts if any one fails.
   */
  add_dependencies_batch(
    task_id: number,
    dep_list: Array<{ task_id: number; inject_result: unknown }>,
  ): void {
    this.transaction(() => {
      for (const dep of dep_list) {
        this.conn
          .query(
            `
            INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, inject_result)
            VALUES (?, ?, ?)
        `,
          )
          .run(task_id, dep.task_id, dep.inject_result ? 1 : 0);
      }
    });
  }

  remove_dependency(task_id: number, depends_on_task_id: number): void {
    this.conn
      .query(
        `
        DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?
    `,
      )
      .run(task_id, depends_on_task_id);
  }

  /** Remove all upstream dependencies for a task. */
  clear_dependencies(task_id: number): void {
    this.conn
      .query("DELETE FROM task_dependencies WHERE task_id = ?")
      .run(task_id);
  }

  /** Return upstream tasks that task_id depends on. */
  get_dependencies(task_id: number): Row[] {
    const rows = this.conn
      .query(
        `
        SELECT td.*, t.title as depends_on_title, t.status as depends_on_status
        FROM task_dependencies td
        JOIN tasks t ON t.id = td.depends_on_task_id
        WHERE td.task_id = ?
    `,
      )
      .all(task_id) as Row[];
    return rows.map((r) => ({ ...r }));
  }

  /** Return downstream tasks that depend on task_id. */
  get_dependents(task_id: number): Row[] {
    const rows = this.conn
      .query(
        `
        SELECT td.*, t.title as task_title, t.status as task_status
        FROM task_dependencies td
        JOIN tasks t ON t.id = td.task_id
        WHERE td.depends_on_task_id = ?
    `,
      )
      .all(task_id) as Row[];
    return rows.map((r) => ({ ...r }));
  }

  get_dag_tasks(dag_id: string): Row[] {
    const rows = this.conn
      .query("SELECT * FROM tasks WHERE dag_id = ? ORDER BY created_at ASC")
      .all(dag_id) as Row[];
    return rows.map((r) => this._deserialize_task(r));
  }

  delete_task(task_id: number): void {
    this.transaction(() => {
      this.conn
        .query("DELETE FROM task_output_events WHERE task_id = ?")
        .run(task_id);
      this.conn.query("DELETE FROM task_runs WHERE task_id = ?").run(task_id);
      this.conn
        .query(
          "DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?",
        )
        .run(task_id, task_id);
      this.conn.query("DELETE FROM tasks WHERE id = ?").run(task_id);
    });
  }
}
