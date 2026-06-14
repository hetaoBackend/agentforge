import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskDB } from "../src/db.ts";
import { makeIMRunbook } from "../src/types.ts";

describe("im runbooks db", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-runbooks-"));
    db = new TaskDB(path.join(tmpDir, "runbooks.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("im runbooks round-trip aliases schema and enabled state", () => {
    const id = db.add_im_runbook(
      makeIMRunbook({
        name: "triage-issue",
        aliases: ["issue-triage"],
        description: "Triage an issue",
        source_type: "template",
        source_id: "template-1",
        command_schema: { args: ["url"] },
        prompt_template: "Triage {{url}}",
        default_agent: "codex",
        confirmation_policy: "required",
        enabled: true,
      }),
    );

    const loaded = db.get_im_runbook(id)!;
    expect(loaded["id"]).toBe(id);
    expect(loaded["name"]).toBe("triage-issue");
    expect(loaded["aliases"]).toEqual(["issue-triage"]);
    expect(loaded["command_schema"]).toEqual({ args: ["url"] });
    expect(loaded["source_type"]).toBe("template");
    expect(loaded["source_id"]).toBe("template-1");
    expect(loaded["default_agent"]).toBe("codex");
    expect(loaded["confirmation_policy"]).toBe("required");
    expect(loaded["enabled"]).toBe(true);
    expect(loaded["created_at"]).toBeTruthy();
    expect(loaded["updated_at"]).toBeTruthy();
  });

  test("im runbooks can be listed and looked up by name or alias", () => {
    const first = db.add_im_runbook(
      makeIMRunbook({
        name: "triage-issue",
        aliases: ["issue-triage"],
        description: "Triage an issue",
        prompt_template: "Triage {{url}}",
      }),
    );
    const second = db.add_im_runbook(
      makeIMRunbook({
        name: "draft-release",
        aliases: [],
        description: "Draft release notes",
        prompt_template: "Draft release notes",
        enabled: false,
      }),
    );

    expect(db.get_im_runbook_by_name("triage-issue")!["id"]).toBe(first);
    expect(db.get_im_runbook_by_name("issue-triage")!["id"]).toBe(first);
    expect(db.get_im_runbook_by_name("missing")).toBeNull();
    expect(db.get_im_runbooks().map((runbook) => runbook["id"])).toEqual([
      second,
      first,
    ]);
    expect(db.get_im_runbooks(true).map((runbook) => runbook["id"])).toEqual([
      first,
    ]);
  });

  test("im runbook updates and deletes validate columns", () => {
    const id = db.add_im_runbook(
      makeIMRunbook({
        name: "triage-issue",
        aliases: ["issue-triage"],
        description: "Triage an issue",
        prompt_template: "Triage {{url}}",
      }),
    );

    db.update_im_runbook(id, {
      description: "Triage a GitHub issue",
      aliases: ["issue"],
      command_schema: { args: ["url"], optional: ["labels"] },
      enabled: false,
    });

    const updated = db.get_im_runbook(id)!;
    expect(updated["description"]).toBe("Triage a GitHub issue");
    expect(updated["aliases"]).toEqual(["issue"]);
    expect(updated["command_schema"]).toEqual({
      args: ["url"],
      optional: ["labels"],
    });
    expect(updated["enabled"]).toBe(false);
    expect(() => db.update_im_runbook(id, { made_up_column: "nope" })).toThrow(
      "Invalid IM runbook column",
    );

    db.delete_im_runbook(id);
    expect(db.get_im_runbook(id)).toBeNull();
  });
});
