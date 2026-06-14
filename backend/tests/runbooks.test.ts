import { describe, expect, test } from "bun:test";

import {
  BUILTIN_RUNBOOKS,
  RunbookConfirmationPolicy,
  expand_runbook,
  parse_runbook_command,
} from "../src/runbooks.ts";

describe("runbooks", () => {
  test("parse_runbook_command recognizes builtins and arguments", () => {
    expect(
      parse_runbook_command("/review-pr https://github.com/acme/app/pull/42"),
    ).toEqual({
      name: "review-pr",
      args: ["https://github.com/acme/app/pull/42"],
      raw_args: "https://github.com/acme/app/pull/42",
    });
    expect(
      parse_runbook_command(
        "/fix-ci   https://github.com/acme/app/actions/runs/123",
      ),
    ).toEqual({
      name: "fix-ci",
      args: ["https://github.com/acme/app/actions/runs/123"],
      raw_args: "https://github.com/acme/app/actions/runs/123",
    });
    expect(parse_runbook_command("/status 1")).toBeNull();
    expect(
      parse_runbook_command("review-pr https://github.com/acme/app/pull/42"),
    ).toBeNull();
  });

  test("builtin registry contains the minimum runbooks", () => {
    expect(BUILTIN_RUNBOOKS.map((runbook) => runbook.name)).toEqual([
      "review-pr",
      "fix-ci",
      "summarize-thread",
      "write-tests",
      "release-check",
      "scan-skills",
    ]);
    expect(
      BUILTIN_RUNBOOKS.find((runbook) => runbook.name === "review-pr")!
        .confirmation_policy,
    ).toBe(RunbookConfirmationPolicy.AUTO);
    expect(
      BUILTIN_RUNBOOKS.find((runbook) => runbook.name === "release-check")!
        .confirmation_policy,
    ).toBe(RunbookConfirmationPolicy.REQUIRED);
  });

  test("expand_runbook validates arguments and creates deterministic prompts", () => {
    const review = expand_runbook({
      name: "review-pr",
      raw_args: "https://github.com/acme/app/pull/42",
      source_channel: "slack",
      source_ref: "C1:1.0",
      working_dir: "~/repo",
      agent: "codex",
      source_metadata: { channel_id: "C1" },
    });

    expect(review.ok).toBe(true);
    expect(review.expansion!.confirmation_policy).toBe("auto");
    expect(review.expansion!.task.title).toBe("[Runbook] Review PR");
    expect(review.expansion!.task.prompt).toContain(
      "Review this pull request:",
    );
    expect(review.expansion!.task.prompt).toContain(
      "https://github.com/acme/app/pull/42",
    );
    expect(review.expansion!.task.working_dir).toBe("~/repo");
    expect(review.expansion!.task.tags).toBe("runbook,review-pr,slack");

    const release = expand_runbook({
      name: "release-check",
      raw_args: "",
      source_channel: "telegram",
      source_ref: "10:20",
      working_dir: "~/repo",
      agent: "claude",
      source_metadata: { chat_id: 10 },
    });

    expect(release.ok).toBe(true);
    expect(release.expansion!.confirmation_policy).toBe("required");
    expect(release.expansion!.brief.title).toBe("Release readiness check");
    expect(release.expansion!.brief.needs_confirmation).toBe(true);
    expect(release.expansion!.brief.acceptance_criteria).toContain(
      "Run or identify the relevant release checks.",
    );
  });

  test("expand_runbook returns usage errors for invalid arguments", () => {
    expect(
      expand_runbook({
        name: "review-pr",
        raw_args: "",
        source_channel: "slack",
        source_ref: "C1:1.0",
      }).error,
    ).toContain("Usage: /review-pr <url>");

    expect(
      expand_runbook({
        name: "unknown",
        raw_args: "",
        source_channel: "slack",
        source_ref: "C1:1.0",
      }).error,
    ).toContain("Unknown runbook");
  });
});
