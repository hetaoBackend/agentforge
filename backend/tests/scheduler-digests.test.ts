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
import { makeTask } from "../src/types.ts";

describe("scheduler digest inbound actions", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-digests-"));
    db = new TaskDB(path.join(tmpDir, "digests.db"));
    scheduler = new TaskScheduler(db, null, new MessageBus());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("TRIGGER_DIGEST returns quiet when there is no content", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.TRIGGER_DIGEST,
        source: "api",
        payload: {},
      }),
    );

    expect(result["status"]).toBe("quiet");
    expect(result["digest"]).toMatchObject({ has_content: false });
  });

  test("TRIGGER_DIGEST returns ready digest and text when content exists", () => {
    db.add_task(
      makeTask({
        title: "Ship auth fix",
        prompt: "fix auth",
        status: "completed",
      }),
    );

    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.TRIGGER_DIGEST,
        source: "api",
        payload: { include_empty: false },
      }),
    );

    expect(result["status"]).toBe("ready");
    expect((result["digest"] as any)["has_content"]).toBe(true);
    expect(result["text"]).toContain("AgentForge Standup");
    expect(result["text"]).toContain("Ship auth fix");
  });
});
