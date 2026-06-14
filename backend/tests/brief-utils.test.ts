import { expect, test } from "bun:test";

import {
  build_brief_payload,
  format_brief_created_reply,
  format_brief_discarded_reply,
  format_brief_started_reply,
  parse_brief_command,
} from "../src/channels/brief_utils.ts";

test("parse_brief_command recognizes draft confirm and discard commands", () => {
  expect(parse_brief_command("/brief fix the login redirect")).toBeNull();
  expect(parse_brief_command("/confirm-brief #42")).toEqual({
    action: "confirm",
    brief_id: 42,
  });
  expect(parse_brief_command("/run-draft 7")).toEqual({
    action: "confirm",
    brief_id: 7,
  });
  expect(parse_brief_command("/cancel-draft 9")).toEqual({
    action: "discard",
    brief_id: 9,
  });
  expect(parse_brief_command("/confirm-brief nope")).toEqual({
    action: "help",
    reason: "invalid_brief_id",
  });
  expect(parse_brief_command("/status 1")).toBeNull();
});

test("build_brief_payload creates a concise draft from text", () => {
  expect(
    build_brief_payload({
      channel: "slack",
      goal: "Fix the login redirect regression and add focused coverage for the auth callback",
      source_ref: "C1:1.0",
      source_metadata: { channel_id: "C1" },
      working_dir: "~/repo",
      agent: "codex",
    }),
  ).toEqual({
    title: "Fix the login redirect regression and add focused coverag...",
    goal: "Fix the login redirect regression and add focused coverage for the auth callback",
    context_summary: "",
    acceptance_criteria: [],
    working_dir: "~/repo",
    working_dir_confidence: "unknown",
    agent: "codex",
    risk_level: "normal",
    needs_confirmation: true,
    source_channel: "slack",
    source_ref: "C1:1.0",
    source_metadata: { channel_id: "C1" },
  });
});

test("draft task replies do not expose brief as the core concept", () => {
  expect(format_brief_created_reply(3, "Fix auth")).toContain("Draft task #3");
  expect(format_brief_created_reply(3, "Fix auth")).toContain("/run-draft 3");
  expect(format_brief_created_reply(3, "Fix auth")).toContain(
    "/cancel-draft 3",
  );
  expect(format_brief_created_reply(3, "Fix auth")).not.toContain("brief");
  expect(format_brief_started_reply(3, 9)).toContain("Task #9");
  expect(format_brief_started_reply(3, 9)).not.toContain("brief");
  expect(format_brief_discarded_reply(3)).toContain("discarded");
});
