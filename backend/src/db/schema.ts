// Table creation and in-place column migrations for the AgentForge SQLite
// database. Split out of db.ts, where CREATE TABLE / ALTER TABLE statements
// made up most of the file and buried the query methods.

import { Database } from "bun:sqlite";
import path from "node:path";
import { nowIso } from "../util.ts";
import type { Row } from "./shared.ts";

/** Run a migration statement, ignoring "column already exists" errors. */
function migrate(conn: Database, sql: string): void {
  try {
    conn.run(sql);
  } catch {
    // Column already exists
  }
}

export function init_db(conn: Database): void {
  conn.run(`
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
  migrate(conn, "ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT 'codex'");
  // question/answer share one try block, mirroring Python: if `question`
  // already exists the `answer` migration is skipped in the same way.
  try {
    conn.run("ALTER TABLE tasks ADD COLUMN question TEXT");
    conn.run("ALTER TABLE tasks ADD COLUMN answer TEXT");
  } catch {
    // Columns already exist
  }
  migrate(conn, "ALTER TABLE tasks ADD COLUMN session_id TEXT");
  migrate(conn, "ALTER TABLE tasks ADD COLUMN prompt_images TEXT DEFAULT '[]'");
  migrate(conn, "ALTER TABLE tasks ADD COLUMN image_paths TEXT DEFAULT '[]'");
  migrate(conn, "ALTER TABLE tasks ADD COLUMN notify_slack_channel TEXT");
  migrate(conn, "ALTER TABLE tasks ADD COLUMN notify_telegram_chat_id TEXT");

  conn.run(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
  `);
  conn.run(`
    CREATE TABLE IF NOT EXISTS task_briefs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL DEFAULT 'draft',
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        context_summary TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        working_dir TEXT,
        working_dir_confidence TEXT NOT NULL DEFAULT 'unknown',
        agent TEXT,
        risk_level TEXT NOT NULL DEFAULT 'normal',
        needs_confirmation INTEGER NOT NULL DEFAULT 1,
        source_channel TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_metadata TEXT NOT NULL DEFAULT '{}',
        created_task_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
    )
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_briefs_status
    ON task_briefs(status, updated_at DESC)
  `);
  conn.run(`
    CREATE TABLE IF NOT EXISTS im_runbooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'template',
        source_id TEXT,
        command_schema TEXT NOT NULL DEFAULT '{}',
        prompt_template TEXT NOT NULL DEFAULT '',
        default_agent TEXT,
        confirmation_policy TEXT NOT NULL DEFAULT 'required',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_im_runbooks_enabled
    ON im_runbooks(enabled, updated_at DESC)
  `);
  conn.run(`
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
  migrate(conn, "ALTER TABLE task_runs ADD COLUMN raw_output TEXT");

  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_heartbeats_next_run
    ON heartbeats(enabled, next_run_at)
  `);
  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_ticks_heartbeat_id
    ON heartbeat_ticks(heartbeat_id, started_at DESC)
  `);
  migrate(conn, "ALTER TABLE heartbeat_ticks ADD COLUMN raw_output TEXT");
  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_heartbeat_dedup_heartbeat_id
    ON heartbeat_dedup(heartbeat_id, triggered_at DESC)
  `);

  // Structured output recording
  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_output_events_task_id
    ON task_output_events(task_id)
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_output_events_run_id
    ON task_output_events(run_id)
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_output_events_timestamp
    ON task_output_events(timestamp)
  `);

  // DAG dependency table
  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_deps_task_id
    ON task_dependencies(task_id)
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on
    ON task_dependencies(depends_on_task_id)
  `);

  // Skill Library: cross-run pattern ledger. The sweep agent tallies
  // recurring task patterns here (dedup by semantic pattern_key); once a
  // pattern crosses the recurrence threshold it becomes a skill candidate.
  conn.run(`
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
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_skill_patterns_status
    ON skill_patterns(status, recurrence_count DESC)
  `);
  // Migration: per-run idempotency ledger so a run is only ever counted
  // once (lets the manual sweep re-scan recent runs without inflating counts).
  migrate(
    conn,
    "ALTER TABLE skill_patterns ADD COLUMN contributing_run_ids TEXT NOT NULL DEFAULT '[]'",
  );
  // Backfill run-id sets for pre-existing patterns from their tasks' completed
  // runs, so a re-scan dedups against real run ids instead of re-counting them.
  try {
    const legacy = conn
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
      const runRows = conn
        .query(
          `SELECT id FROM task_runs WHERE status = 'completed' AND task_id IN (${placeholders})`,
        )
        .all(...tids) as Row[];
      const run_ids = runRows.map((r) => r["id"]);
      if (run_ids.length) {
        conn
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
  conn.run(`
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
  conn.run(`
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
    migrate(conn, `ALTER TABLE skill_drafts ADD COLUMN ${col} ${decl}`);
  }

  conn.run(`
    CREATE TABLE IF NOT EXISTS im_skill_suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'suggested',
        suggested_at TEXT,
        draft_shown_at TEXT,
        dismissed_at TEXT,
        approved_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(pattern_id, channel, target),
        FOREIGN KEY (pattern_id) REFERENCES skill_patterns(id)
    )
  `);
  conn.run(`
    CREATE INDEX IF NOT EXISTS idx_im_skill_suggestions_status
    ON im_skill_suggestions(status, updated_at DESC)
  `);

  migrate(conn, "ALTER TABLE tasks ADD COLUMN dag_id TEXT");
  // Migration: add feishu_root_msg_id column for post-restart resume
  migrate(conn, "ALTER TABLE tasks ADD COLUMN feishu_root_msg_id TEXT");

  // On startup, reset any tasks left in 'running' state — they were
  // interrupted by a process kill (e.g. hot reload) and will never
  // self-transition to completed/failed without this reset.
  const now = nowIso();
  conn
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
  conn
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
