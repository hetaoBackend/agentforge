import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskDB } from "../src/db.ts";
import { makeTaskBrief } from "../src/types.ts";

describe("task briefs", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-briefs-"));
    db = new TaskDB(path.join(tmpDir, "briefs.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("task briefs round-trip structured fields", () => {
    const brief = makeTaskBrief({
      title: "Fix auth",
      goal: "Fix login redirect",
      context_summary: "Forwarded QA report",
      acceptance_criteria: ["Identify cause", "Patch minimal code"],
      working_dir: "~/workspace/app",
      working_dir_confidence: "high",
      agent: "codex",
      risk_level: "normal",
      needs_confirmation: true,
      source_channel: "telegram",
      source_ref: "chat-1:msg-2",
      source_metadata: { chat_id: "chat-1" },
    });

    const id = db.add_task_brief(brief);
    const loaded = db.get_task_brief(id)!;

    expect(loaded["id"]).toBe(id);
    expect(loaded["status"]).toBe("draft");
    expect(loaded["title"]).toBe("Fix auth");
    expect(loaded["goal"]).toBe("Fix login redirect");
    expect(loaded["context_summary"]).toBe("Forwarded QA report");
    expect(loaded["acceptance_criteria"]).toEqual([
      "Identify cause",
      "Patch minimal code",
    ]);
    expect(loaded["working_dir"]).toBe("~/workspace/app");
    expect(loaded["working_dir_confidence"]).toBe("high");
    expect(loaded["agent"]).toBe("codex");
    expect(loaded["risk_level"]).toBe("normal");
    expect(loaded["needs_confirmation"]).toBe(true);
    expect(loaded["source_channel"]).toBe("telegram");
    expect(loaded["source_ref"]).toBe("chat-1:msg-2");
    expect(loaded["source_metadata"]).toEqual({ chat_id: "chat-1" });
    expect(loaded["created_task_id"]).toBeNull();
    expect(loaded["created_at"]).toBeTruthy();
    expect(loaded["updated_at"]).toBeTruthy();
  });

  test("task brief status transitions are persisted", () => {
    const id = db.add_task_brief(
      makeTaskBrief({
        title: "Fix auth",
        goal: "Fix login redirect",
        source_channel: "telegram",
        source_ref: "chat-1:msg-2",
      }),
    );

    db.discard_task_brief(id);
    expect(db.get_task_brief(id)!["status"]).toBe("discarded");

    const confirmedId = db.add_task_brief(
      makeTaskBrief({
        title: "Fix auth again",
        goal: "Fix login redirect again",
        source_channel: "telegram",
        source_ref: "chat-1:msg-3",
      }),
    );
    db.confirm_task_brief(confirmedId, 42);
    const confirmed = db.get_task_brief(confirmedId)!;
    expect(confirmed["status"]).toBe("converted");
    expect(confirmed["created_task_id"]).toBe(42);
  });

  test("task brief updates only accept known columns", () => {
    const id = db.add_task_brief(
      makeTaskBrief({
        title: "Fix auth",
        goal: "Fix login redirect",
        source_channel: "telegram",
        source_ref: "chat-1:msg-2",
      }),
    );

    db.update_task_brief(id, {
      title: "Fix auth v2",
      acceptance_criteria: ["Patch", "Test"],
      source_metadata: { edited: true },
    });

    const updated = db.get_task_brief(id)!;
    expect(updated["title"]).toBe("Fix auth v2");
    expect(updated["acceptance_criteria"]).toEqual(["Patch", "Test"]);
    expect(updated["source_metadata"]).toEqual({ edited: true });
    expect(() => db.update_task_brief(id, { made_up_column: "nope" })).toThrow(
      "Invalid task brief column",
    );
  });
});
