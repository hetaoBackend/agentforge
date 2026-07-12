import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskDB } from "../src/db.ts";
import {
  collect_im_skill_suggestions,
  render_im_skill_suggestion_text,
} from "../src/skill_suggestions.ts";
import { makeTask } from "../src/types.ts";

describe("IM skill suggestions", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "agentforge-skill-suggestions-"),
    );
    db = new TaskDB(path.join(tmpDir, "suggestions.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function candidateForChannel(channel: string): number {
    const taskId = db.add_task(
      makeTask({
        title: "Fix frontend CI",
        prompt: "Investigate the failed build.",
        tags: `runbook,fix-ci,${channel}`,
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

  test("collects candidate patterns that originated from an IM channel", () => {
    const patternId = candidateForChannel("slack");
    candidateForChannel("telegram");

    const suggestions = collect_im_skill_suggestions(db, { channel: "slack" });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.pattern_id).toBe(patternId);
    expect(suggestions[0]!.pattern_key).toBe("fix-ci-investigation");
    expect(suggestions[0]!.source_tasks).toEqual([
      { id: 1, title: "Fix frontend CI" },
    ]);
  });

  test("renders draft and approval commands with the skill install warning", () => {
    const patternId = candidateForChannel("slack");
    db.upsert_skill_draft(
      patternId,
      "ready",
      "fix-ci-investigation",
      "Reusable CI investigation workflow.",
      "recipe",
      "---\nname: fix-ci-investigation\n---\n# Fix CI\n",
    );

    const suggestion = collect_im_skill_suggestions(db, {
      channel: "slack",
    })[0]!;
    const text = render_im_skill_suggestion_text(suggestion);

    expect(text).toContain("Skill suggestion: fix-ci-investigation");
    expect(text).toContain("Source tasks:");
    expect(text).toContain("/draft-skill");
    expect(text).toContain("/approve-skill");
    expect(text).toContain("/dismiss-skill");
    expect(text).toContain("~/.agentforge/skills");
    expect(text).toContain("~/.claude/skills");
    expect(text).toContain("~/.agents/skills");
  });

  test("suggestion state suppresses repeated sends and records shown drafts", () => {
    expect(db.should_send_im_skill_suggestion(7, "slack", "C1")).toBe(true);

    db.upsert_im_skill_suggestion({
      pattern_id: 7,
      channel: "slack",
      target: "C1",
      status: "suggested",
      metadata: { message_ts: "1.0" },
    });

    const row = db.get_im_skill_suggestion(7, "slack", "C1")!;
    expect(row["status"]).toBe("suggested");
    expect(row["metadata"]).toEqual({ message_ts: "1.0" });
    expect(db.should_send_im_skill_suggestion(7, "slack", "C1")).toBe(false);

    db.mark_im_skill_suggestion_draft_shown(7, "slack", "C1");

    const shown = db.get_im_skill_suggestion(7, "slack", "C1")!;
    expect(shown["draft_shown_at"]).toBeTruthy();

    db.mark_im_skill_suggestion_status(7, "slack", "C1", "dismissed");

    const dismissed = db.get_im_skill_suggestion(7, "slack", "C1")!;
    expect(dismissed["status"]).toBe("dismissed");
    expect(dismissed["dismissed_at"]).toBeTruthy();
  });
});
