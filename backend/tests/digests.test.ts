import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compose_im_digest,
  parse_im_digest_recipients,
  render_im_digest_text,
} from "../src/digests.ts";
import { TaskDB } from "../src/db.ts";
import { makeHeartbeat, makeTask } from "../src/types.ts";

describe("im digests", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-digests-"));
    db = new TaskDB(path.join(tmpDir, "digests.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("empty digest is quiet by default", () => {
    const digest = compose_im_digest(db);

    expect(digest.has_content).toBe(false);
    expect(digest.sections).toEqual([]);
    expect(render_im_digest_text(digest)).toContain(
      "No notable AgentForge activity",
    );
  });

  test("digest separates completed failed and needs-you tasks", () => {
    db.add_task(
      makeTask({
        title: "Ship auth fix",
        prompt: "fix auth",
        status: "completed",
        result: "done",
      }),
    );
    const failedId = db.add_task(
      makeTask({
        title: "Fix CI",
        prompt: "fix ci",
        status: "failed",
      }),
    );
    db.update_task(failedId, { error: "DATABASE_URL missing" });
    const waitingId = db.add_task(
      makeTask({
        title: "Clarify release",
        prompt: "release?",
        status: "running",
      }),
    );
    db.update_task(waitingId, {
      question: "Which branch should I release?",
    });

    const digest = compose_im_digest(db);
    const text = render_im_digest_text(digest);

    expect(digest.has_content).toBe(true);
    expect(digest.sections.map((section) => section.key)).toEqual([
      "completed",
      "needs_you",
      "failed",
    ]);
    expect(text).toContain("Completed:");
    expect(text).toContain("Ship auth fix");
    expect(text).toContain("Needs you:");
    expect(text).toContain("Which branch should I release?");
    expect(text).toContain("Failed:");
    expect(text).toContain("DATABASE_URL missing");
    expect(digest.suggested_commands).toContain("/fix-ci <url>");
  });

  test("digest includes non-idle watcher ticks and skill candidates", () => {
    const heartbeatId = db.add_heartbeat(
      makeHeartbeat({
        name: "Prod watcher",
        working_dir: ".",
        interval_seconds: 60,
        check_prompt: "check prod",
      }),
    );
    const tickId = db.add_heartbeat_tick(heartbeatId);
    db.finish_heartbeat_tick(
      tickId,
      "completed",
      "notify_only",
      { summary: "CPU spike detected" },
      null,
      "CPU spike detected",
      null,
    );
    const patternId = db.upsert_skill_pattern(
      "fix-ci",
      "recipe",
      "Fix recurring CI failures",
      42,
    )!;
    db.set_skill_pattern_status(patternId, "candidate");

    const digest = compose_im_digest(db);
    const text = render_im_digest_text(digest);

    expect(digest.sections.map((section) => section.key)).toEqual([
      "watchers",
      "skills",
    ]);
    expect(text).toContain("Watchers:");
    expect(text).toContain("CPU spike detected");
    expect(text).toContain("Skill candidates:");
    expect(text).toContain("Fix recurring CI failures");
    expect(digest.suggested_commands).toContain("/scan-skills");
  });

  test("recipient parser accepts JSON arrays and filters malformed entries", () => {
    expect(
      parse_im_digest_recipients(
        JSON.stringify([
          { channel: "slack", target: "C1" },
          { channel: "telegram", target: 10 },
          { channel: "", target: "missing" },
          { channel: "feishu" },
        ]),
      ),
    ).toEqual([
      { channel: "slack", target: "C1" },
      { channel: "telegram", target: "10" },
    ]);

    expect(parse_im_digest_recipients("not json")).toEqual([]);
    expect(
      parse_im_digest_recipients([{ channel: "weixin", target: "peer" }]),
    ).toEqual([{ channel: "weixin", target: "peer" }]);
  });
});
