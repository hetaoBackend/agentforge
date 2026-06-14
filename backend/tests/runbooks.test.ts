import { describe, expect, test } from "bun:test";

import {
  BUILTIN_RUNBOOKS,
  RunbookConfirmationPolicy,
  RunbookSourceType,
  expand_runbook,
  parse_runbook_command,
  type RunbookDefinition,
} from "../src/runbooks.ts";

describe("runbooks", () => {
  const analyzeErrorCommand: RunbookDefinition = {
    name: "看报错",
    aliases: ["analyze-error"],
    description: "分析一段报错并给出下一步",
    source_type: RunbookSourceType.TEMPLATE,
    source_id: null,
    command_schema: { args: ["内容"] },
    prompt_template: "请分析这段报错，并给出最小下一步：\n{{raw_args}}",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
  };

  test("parse_runbook_command only recognizes supplied custom commands", () => {
    expect(
      parse_runbook_command("/review-pr https://github.com/acme/app/pull/42"),
    ).toBeNull();
    expect(
      parse_runbook_command("/看报错 TypeError: boom", [analyzeErrorCommand]),
    ).toEqual({
      name: "看报错",
      args: ["TypeError:", "boom"],
      raw_args: "TypeError: boom",
    });
    expect(
      parse_runbook_command("/analyze-error TypeError: boom", [
        analyzeErrorCommand,
      ]),
    ).toEqual({
      name: "看报错",
      args: ["TypeError:", "boom"],
      raw_args: "TypeError: boom",
    });
    expect(parse_runbook_command("/status 1")).toBeNull();
    expect(
      parse_runbook_command("看报错 TypeError: boom", [analyzeErrorCommand]),
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

  test("expand_runbook validates custom commands and creates deterministic prompts", () => {
    const review = expand_runbook({
      name: "看报错",
      raw_args: "TypeError: boom",
      source_channel: "telegram",
      source_ref: "10:20",
      working_dir: "~/repo",
      agent: "codex",
      source_metadata: { chat_id: 10 },
      runbooks: [analyzeErrorCommand],
    });

    expect(review.ok).toBe(true);
    expect(review.expansion!.confirmation_policy).toBe("auto");
    expect(review.expansion!.task.title).toBe(
      "[Command] 分析一段报错并给出下一步",
    );
    expect(review.expansion!.task.prompt).toContain(
      "请分析这段报错，并给出最小下一步：\nTypeError: boom",
    );
    expect(review.expansion!.task.working_dir).toBe("~/repo");
    expect(review.expansion!.task.tags).toBe("command,看报错,telegram");

    const release = expand_runbook({
      name: "看报错",
      raw_args: "ReferenceError",
      source_channel: "telegram",
      source_ref: "10:20",
      working_dir: "~/repo",
      agent: "claude",
      source_metadata: { chat_id: 10 },
      runbooks: [
        {
          ...analyzeErrorCommand,
          confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
        },
      ],
    });

    expect(release.ok).toBe(true);
    expect(release.expansion!.confirmation_policy).toBe("required");
    expect(release.expansion!.brief.title).toBe("分析一段报错并给出下一步");
    expect(release.expansion!.brief.needs_confirmation).toBe(true);
    expect(release.expansion!.brief.goal).toContain("ReferenceError");
  });

  test("expand_runbook returns usage errors for invalid arguments", () => {
    expect(
      expand_runbook({
        name: "看报错",
        raw_args: "",
        source_channel: "slack",
        source_ref: "C1:1.0",
        runbooks: [analyzeErrorCommand],
      }).error,
    ).toContain("Usage: /看报错 <内容>");

    expect(
      expand_runbook({
        name: "review-pr",
        raw_args: "",
        source_channel: "slack",
        source_ref: "C1:1.0",
      }).error,
    ).toContain("Unknown command");
  });
});
