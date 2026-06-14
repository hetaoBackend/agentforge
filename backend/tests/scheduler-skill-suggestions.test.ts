import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { makeTask } from "../src/types.ts";

describe("scheduler IM skill suggestion actions", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentforge-scheduler-skill-suggestions-"),
    );
    db = new TaskDB(path.join(tmpDir, "suggestions.db"));
    scheduler = new TaskScheduler(db, null, new MessageBus());
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createCandidate(): number {
    const taskId = db.add_task(
      makeTask({
        title: "Fix frontend CI",
        prompt: "Investigate the failed build.",
        tags: "runbook,fix-ci,slack",
      }),
    );
    const patternId = db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      100,
    )!;
    db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      101,
    );
    db.upsert_skill_pattern(
      "fix-ci-investigation",
      "recipe",
      "Investigate a failed CI run and patch the minimal issue.",
      taskId,
      102,
    );
    db.set_skill_pattern_status(patternId, "candidate");
    return patternId;
  }

  function createReadyDraft(): number {
    const patternId = createCandidate();
    db.upsert_skill_draft(
      patternId,
      "ready",
      "fix-ci-investigation",
      "Reusable CI investigation workflow.",
      "recipe",
      "---\nname: fix-ci-investigation\ndescription: Reusable CI investigation workflow.\n---\n# Fix CI\n",
    );
    return patternId;
  }

  function actionMessage(
    action: string,
    patternId: number,
  ): ReturnType<typeof makeInboundMessage> {
    return makeInboundMessage({
      type: InboundMessageType.SKILL_SUGGESTION_ACTION,
      source: "slack",
      reply_to: "C1",
      payload: {
        action,
        pattern_id: patternId,
        source_channel: "slack",
        target: "C1",
      },
    });
  }

  test("SKILL_SUGGESTION_ACTION starts draft generation", () => {
    const patternId = createCandidate();
    scheduler.trigger_skill_draft = mock(() => true) as any;

    const result = scheduler.handle_inbound_message(
      actionMessage("draft", patternId),
    );

    expect(result).toEqual({ pattern_id: patternId, status: "drafting" });
    expect((scheduler.trigger_skill_draft as any).mock.calls[0]).toEqual([
      patternId,
      null,
    ]);
    expect(
      db.get_im_skill_suggestion(patternId, "slack", "C1")!["status"],
    ).toBe("suggested");
  });

  test("SKILL_SUGGESTION_ACTION shows a ready draft and marks it reviewable", () => {
    const patternId = createReadyDraft();

    const result = scheduler.handle_inbound_message(
      actionMessage("show", patternId),
    );

    expect(result["status"]).toBe("ready");
    expect(String(result["text"])).toContain("Draft preview:");
    expect(String(result["text"])).toContain("# Fix CI");
    expect(
      db.get_im_skill_suggestion(patternId, "slack", "C1")![
        "draft_shown_at"
      ],
    ).toBeTruthy();
  });

  test("SKILL_SUGGESTION_ACTION rejects approval before draft was shown", () => {
    const patternId = createReadyDraft();

    expect(() =>
      scheduler.handle_inbound_message(actionMessage("approve", patternId)),
    ).toThrow("draft must be shown before approval");
  });

  test("SKILL_SUGGESTION_ACTION approves after a ready draft was shown", () => {
    const patternId = createReadyDraft();
    db.mark_im_skill_suggestion_draft_shown(patternId, "slack", "C1");
    scheduler.approve_skill = mock(() => ({ id: 9, name: "ok" })) as any;

    const result = scheduler.handle_inbound_message(
      actionMessage("approve", patternId),
    );

    expect(result).toEqual({
      pattern_id: patternId,
      skill: { id: 9, name: "ok" },
      status: "approved",
    });
    expect(
      db.get_im_skill_suggestion(patternId, "slack", "C1")!["status"],
    ).toBe("approved");
  });

  test("SKILL_SUGGESTION_ACTION dismisses the pattern", () => {
    const patternId = createReadyDraft();

    const result = scheduler.handle_inbound_message(
      actionMessage("dismiss", patternId),
    );

    expect(result).toEqual({ pattern_id: patternId, status: "dismissed" });
    expect(db.get_skill_pattern(patternId)!["status"]).toBe("dismissed");
    expect(
      db.get_im_skill_suggestion(patternId, "slack", "C1")!["status"],
    ).toBe("dismissed");
  });
});
