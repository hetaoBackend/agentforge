// Bottom of the TaskDB repository chain: owns the connection and the handful
// of members every domain module needs.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Row } from "./shared.ts";
import { init_db } from "./schema.ts";

function expandUser(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Connection, schema bootstrap, transactions, and the settings key/value pair. */
export class DbBase {
  db_path: string;
  conn: Database;

  constructor(db_path: string = "~/.agentforge/tasks.db") {
    this.db_path = expandUser(db_path);
    fs.mkdirSync(path.dirname(this.db_path), { recursive: true });
    this.conn = new Database(this.db_path, { create: true });
    init_db(this.conn);
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
}
