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
import { makeIMRunbook } from "../src/types.ts";

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
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function addCommand(
    name: string,
    policy: "auto" | "required",
    prompt: string = "Run {{raw_args}}",
  ): number {
    return db.add_im_runbook(
      makeIMRunbook({
        name,
        description: `Command ${name}`,
        prompt_template: prompt,
        confirmation_policy: policy,
      }),
    );
  }

  test("PREVIEW_RUNBOOK creates a draft without creating a task", () => {
    addCommand("检查发布", "required", "检查发布风险：{{raw_args}}");

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.PREVIEW_RUNBOOK,
        source: "slack",
        payload: {
          name: "检查发布",
          raw_args: "今天的变更",
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
      runbook: "检查发布",
      status: "draft",
    });
    expect(db.get_all_tasks()).toHaveLength(0);
    const brief = db.get_task_brief(1)!;
    expect(brief["title"]).toBe("Command 检查发布");
    expect(brief["needs_confirmation"]).toBe(true);
    expect(brief["source_channel"]).toBe("slack");
    expect(brief["source_ref"]).toBe("C1:1.0");
  });

  test("RUN_RUNBOOK creates a task for auto-confirmed runbooks", () => {
    addCommand("看-pr", "auto", "Review this pull request:\n{{raw_args}}");

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "slack",
        payload: {
          name: "看-pr",
          raw_args: "https://github.com/acme/app/pull/42",
          source_channel: "slack",
          source_ref: "C1:1.0",
          working_dir: ".",
          agent: "codex",
        },
      }),
    );

    expect(result).toEqual({
      runbook: "看-pr",
      status: "created",
      task_id: 1,
    });
    expect(db.get_task_briefs()).toHaveLength(0);
    const task = db.get_task(1)!;
    expect(task["title"]).toBe("[Command] Command 看-pr");
    expect(task["prompt"]).toContain("https://github.com/acme/app/pull/42");
    expect(task["tags"]).toBe("command,看-pr,slack");
  });

  test("RUN_RUNBOOK creates a draft for runbooks requiring confirmation", () => {
    addCommand("修-ci", "required", "修复 CI：{{raw_args}}");

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "telegram",
        payload: {
          name: "修-ci",
          raw_args: "https://github.com/acme/app/actions/runs/123",
          source_channel: "telegram",
          source_ref: "10:20",
          working_dir: ".",
        },
      }),
    );

    expect(result).toEqual({
      brief_id: 1,
      runbook: "修-ci",
      status: "draft",
    });
    expect(db.get_all_tasks()).toHaveLength(0);
    const brief = db.get_task_brief(1)!;
    expect(brief["title"]).toBe("Command 修-ci");
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
    ).toThrow("Unknown command: review-pr");
  });
});
