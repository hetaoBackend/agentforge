import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InboundMessageType,
  MessageBus,
  makeInboundMessage,
} from "../src/bus.ts";
import { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";

describe("scheduler task brief inbound actions", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-briefs-"));
    db = new TaskDB(path.join(tmpDir, "briefs.db"));
    scheduler = new TaskScheduler(db, null, new MessageBus());
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("CREATE_BRIEF creates a draft without creating a task", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CREATE_BRIEF,
        source: "telegram",
        payload: {
          title: "Fix auth",
          goal: "Fix login redirect",
          context_summary: "Forwarded QA report",
          acceptance_criteria: ["Identify cause", "Patch minimal code"],
          working_dir: ".",
          agent: "codex",
          source_channel: "telegram",
          source_ref: "chat-1:msg-2",
          source_metadata: { chat_id: "chat-1" },
        },
      }),
    );

    expect(result).toEqual({ brief_id: 1, status: "draft" });
    expect(db.get_task_briefs()).toHaveLength(1);
    expect(db.get_all_tasks()).toHaveLength(0);
  });

  test("CONFIRM_BRIEF converts a draft into a task", () => {
    const created = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CREATE_BRIEF,
        source: "telegram",
        payload: {
          title: "Fix auth",
          goal: "Fix login redirect",
          acceptance_criteria: ["Identify cause"],
          working_dir: ".",
          source_channel: "telegram",
          source_ref: "chat-1:msg-2",
        },
      }),
    );

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CONFIRM_BRIEF,
        source: "telegram",
        payload: { brief_id: created["brief_id"] },
      }),
    );

    expect(result).toEqual({ task_id: 1, status: "created" });
    const brief = db.get_task_brief(Number(created["brief_id"]))!;
    const task = db.get_task(1)!;
    expect(brief["status"]).toBe("converted");
    expect(brief["created_task_id"]).toBe(1);
    expect(task["title"]).toBe("Fix auth");
    expect(task["prompt"]).toContain("Goal:");
    expect(task["prompt"]).toContain("Acceptance criteria:");
  });

  test("repeated CONFIRM_BRIEF creates at most one task", () => {
    const created = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CREATE_BRIEF,
        source: "telegram",
        payload: {
          title: "Fix auth",
          goal: "Fix login redirect",
          source_channel: "telegram",
          source_ref: "chat-1:msg-repeat",
        },
      }),
    );
    const confirm = () =>
      scheduler.handle_inbound_message(
        makeInboundMessage({
          type: InboundMessageType.CONFIRM_BRIEF,
          source: "telegram",
          payload: { brief_id: created["brief_id"] },
        }),
      );

    expect(confirm()).toEqual({ task_id: 1, status: "created" });
    expect(confirm).toThrow(/Cannot confirm draft task/);
    expect(db.get_all_tasks()).toHaveLength(1);
  });

  test("failed CONFIRM_BRIEF releases the draft claim", () => {
    const created = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CREATE_BRIEF,
        source: "telegram",
        payload: {
          title: "Fix auth",
          goal: "Fix login redirect",
          source_channel: "telegram",
          source_ref: "chat-1:msg-retry",
        },
      }),
    );
    const originalAddTask = db.add_task.bind(db);
    db.add_task = (() => {
      throw new Error("injected task insert failure");
    }) as typeof db.add_task;

    expect(() =>
      scheduler.handle_inbound_message(
        makeInboundMessage({
          type: InboundMessageType.CONFIRM_BRIEF,
          source: "telegram",
          payload: { brief_id: created["brief_id"] },
        }),
      ),
    ).toThrow(/injected task insert failure/);
    expect(db.get_task_brief(Number(created["brief_id"]))!["status"]).toBe(
      "draft",
    );
    expect(db.get_all_tasks()).toEqual([]);

    db.add_task = originalAddTask;
    const retried = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CONFIRM_BRIEF,
        source: "telegram",
        payload: { brief_id: created["brief_id"] },
      }),
    );
    expect(retried["status"]).toBe("created");
    expect(db.get_all_tasks()).toHaveLength(1);
  });

  test("DISCARD_BRIEF marks a draft discarded", () => {
    const created = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.CREATE_BRIEF,
        source: "telegram",
        payload: {
          title: "Fix auth",
          goal: "Fix login redirect",
          source_channel: "telegram",
          source_ref: "chat-1:msg-2",
        },
      }),
    );

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.DISCARD_BRIEF,
        source: "telegram",
        payload: { brief_id: created["brief_id"] },
      }),
    );

    expect(result).toEqual({ brief_id: 1, status: "discarded" });
    expect(db.get_task_brief(1)!["status"]).toBe("discarded");
    expect(db.get_all_tasks()).toHaveLength(0);
  });
});
