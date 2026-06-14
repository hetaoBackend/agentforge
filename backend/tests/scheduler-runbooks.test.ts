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

describe("scheduler runbook inbound actions", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-runbooks-"));
    db = new TaskDB(path.join(tmpDir, "runbooks.db"));
    scheduler = new TaskScheduler(db, null, new MessageBus());
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("PREVIEW_RUNBOOK creates a draft without creating a task", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.PREVIEW_RUNBOOK,
        source: "slack",
        payload: {
          name: "release-check",
          raw_args: "",
          source_channel: "slack",
          source_ref: "C1:1.0",
          working_dir: ".",
          agent: "codex",
          source_metadata: { channel_id: "C1" },
        },
      }),
    );

    expect(result).toEqual({
      brief_id: 1,
      runbook: "release-check",
      status: "draft",
    });
    expect(db.get_all_tasks()).toHaveLength(0);
    const brief = db.get_task_brief(1)!;
    expect(brief["title"]).toBe("Release readiness check");
    expect(brief["needs_confirmation"]).toBe(true);
    expect(brief["source_channel"]).toBe("slack");
    expect(brief["source_ref"]).toBe("C1:1.0");
  });

  test("RUN_RUNBOOK creates a task for auto-confirmed runbooks", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "slack",
        payload: {
          name: "review-pr",
          raw_args: "https://github.com/acme/app/pull/42",
          source_channel: "slack",
          source_ref: "C1:1.0",
          working_dir: ".",
          agent: "codex",
        },
      }),
    );

    expect(result).toEqual({
      runbook: "review-pr",
      status: "created",
      task_id: 1,
    });
    expect(db.get_task_briefs()).toHaveLength(0);
    const task = db.get_task(1)!;
    expect(task["title"]).toBe("[Runbook] Review PR");
    expect(task["prompt"]).toContain("https://github.com/acme/app/pull/42");
    expect(task["tags"]).toBe("runbook,review-pr,slack");
  });

  test("RUN_RUNBOOK creates a draft for runbooks requiring confirmation", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "telegram",
        payload: {
          name: "fix-ci",
          raw_args: "https://github.com/acme/app/actions/runs/123",
          source_channel: "telegram",
          source_ref: "10:20",
          working_dir: ".",
        },
      }),
    );

    expect(result).toEqual({
      brief_id: 1,
      runbook: "fix-ci",
      status: "draft",
    });
    expect(db.get_all_tasks()).toHaveLength(0);
    const brief = db.get_task_brief(1)!;
    expect(brief["title"]).toBe("Fix failing CI run");
    expect(brief["goal"]).toContain(
      "https://github.com/acme/app/actions/runs/123",
    );
  });

  test("RUN_RUNBOOK reports usage errors", () => {
    expect(() =>
      scheduler.handle_inbound_message(
        makeInboundMessage({
          type: InboundMessageType.RUN_RUNBOOK,
          source: "slack",
          payload: {
            name: "review-pr",
            raw_args: "",
            source_channel: "slack",
            source_ref: "C1:1.0",
          },
        }),
      ),
    ).toThrow("Usage: /review-pr <url>");
  });
});
