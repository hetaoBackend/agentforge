// Task rows and the dependency DAG.

import { logger } from "../log.ts";
import {
  normalizeDatetimeForStorage,
  nowIso,
  parseComparableDatetime,
} from "../util.ts";
import type { Task } from "../types.ts";
import type { DbCtor, Row } from "./shared.ts";
import { DbBase } from "./base.ts";

const ALLOWED_TASK_COLUMNS: ReadonlySet<string> = new Set([
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

export function TasksMixin<TBase extends DbCtor<DbBase>>(Base: TBase) {
  return class TasksRepo extends Base {
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

    update_task(task_id: number, kwargs: Record<string, unknown>): void {
      const invalid = Object.keys(kwargs).filter(
        (k) => !ALLOWED_TASK_COLUMNS.has(k),
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
  };
}
