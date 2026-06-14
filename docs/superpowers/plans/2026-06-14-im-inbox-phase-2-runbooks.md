# IM Inbox Phase 2 Runbooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shared IM Runbook system so common AgentForge workflows can be previewed or started from REST APIs and existing IM channels.

**Architecture:** Introduce a shared `RunbookRegistry` that owns command parsing, builtin definitions, argument validation, and expansion into either a `TaskBrief` draft or an immediate `Task`. Persist user-defined runbooks in `im_runbooks`, but keep builtin runbooks code-defined so Phase 2 works before any template library UI. Channels stay thin: they detect a runbook command, send `PREVIEW_RUNBOOK` or `RUN_RUNBOOK` to the scheduler, and render text fallback replies.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test, existing `MessageBus`, `TaskScheduler`, `TaskDB`, and channel adapters.

---

## Scope

This plan implements Phase 2 from `docs/superpowers/specs/2026-06-14-agentforge-im-inbox-design.md`.

In scope:

- `RUN_RUNBOOK` and `PREVIEW_RUNBOOK` inbound message types.
- Shared `RunbookRegistry` with builtin commands:
  - `/review-pr <url>`
  - `/fix-ci <url>`
  - `/summarize-thread`
  - `/write-tests <path>`
  - `/release-check`
  - `/scan-skills`
- `im_runbooks` SQLite table and CRUD methods for user-defined runbooks.
- REST API:
  - `GET /api/im-runbooks`
  - `POST /api/im-runbooks`
  - `PATCH /api/im-runbooks/:id`
  - `DELETE /api/im-runbooks/:id`
  - `POST /api/im-runbooks/:name/preview`
  - `POST /api/im-runbooks/:name/run`
- Scheduler handling for preview/runbook inbound actions.
- Text fallback in Slack, Feishu, Weixin, and Telegram.

Out of scope:

- Template Library UI.
- Rich Feishu/Slack interactive cards.
- Agent-based command inference.
- Scheduled digests.
- Skill suggestion delivery.

## File Structure

- Create `backend/src/runbooks.ts`
  - Define runbook types, builtin registry, command parser, validators, and expansion helpers.
- Add `backend/tests/runbooks.test.ts`
  - Unit tests for command parsing, builtin argument validation, and expansion results.
- Modify `backend/src/types.ts`
  - Add `RunbookSourceType`, `RunbookConfirmationPolicy`, and `IMRunbook`.
- Modify `backend/src/db.ts`
  - Add `im_runbooks` table and CRUD methods.
- Add `backend/tests/runbook-db.test.ts`
  - SQLite tests for user-defined runbook persistence.
- Modify `backend/src/bus.ts`
  - Add `RUN_RUNBOOK` and `PREVIEW_RUNBOOK` inbound types and payload docs.
- Modify `backend/tests/bus.test.ts`
  - Round-trip tests for the new inbound types.
- Modify `backend/src/scheduler.ts`
  - Add `RunbookRegistry` field and `handle_inbound_message` branches.
- Add `backend/tests/scheduler-runbooks.test.ts`
  - Scheduler tests for preview/run actions.
- Modify `backend/src/api.ts`
  - Add runbook CRUD and preview/run endpoints.
- Modify `backend/tests/api-handler.test.ts`
  - API tests for builtin listing, user runbook CRUD, preview, and run.
- Modify channel files:
  - `backend/src/channels/slack.ts`
  - `backend/src/channels/feishu.ts`
  - `backend/src/channels/weixin.ts`
  - `backend/src/channels/telegram.ts`
- Modify channel tests:
  - `backend/tests/slack-channel.test.ts`
  - `backend/tests/feishu-channel.test.ts`
  - `backend/tests/weixin-channel.test.ts`
  - `backend/tests/telegram-channel.test.ts`

## Task 1: Shared Runbook Registry

**Files:**

- Create: `backend/src/runbooks.ts`
- Test: `backend/tests/runbooks.test.ts`

- [ ] **Step 1: Write failing parser and expansion tests**

Create `backend/tests/runbooks.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  BUILTIN_RUNBOOKS,
  RunbookConfirmationPolicy,
  expand_runbook,
  parse_runbook_command,
} from "../src/runbooks.ts";

describe("runbooks", () => {
  test("parse_runbook_command recognizes builtins and arguments", () => {
    expect(parse_runbook_command("/review-pr https://github.com/acme/app/pull/42")).toEqual({
      name: "review-pr",
      args: ["https://github.com/acme/app/pull/42"],
      raw_args: "https://github.com/acme/app/pull/42",
    });
    expect(parse_runbook_command("/fix-ci   https://github.com/acme/app/actions/runs/123")).toEqual({
      name: "fix-ci",
      args: ["https://github.com/acme/app/actions/runs/123"],
      raw_args: "https://github.com/acme/app/actions/runs/123",
    });
    expect(parse_runbook_command("/status 1")).toBeNull();
    expect(parse_runbook_command("review-pr https://github.com/acme/app/pull/42")).toBeNull();
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
    expect(BUILTIN_RUNBOOKS.find((runbook) => runbook.name === "review-pr")!.confirmation_policy).toBe(
      RunbookConfirmationPolicy.AUTO,
    );
    expect(BUILTIN_RUNBOOKS.find((runbook) => runbook.name === "release-check")!.confirmation_policy).toBe(
      RunbookConfirmationPolicy.REQUIRED,
    );
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
    expect(review.expansion!.task.prompt).toContain("Review this pull request:");
    expect(review.expansion!.task.prompt).toContain("https://github.com/acme/app/pull/42");
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
    expect(release.expansion!.brief.acceptance_criteria).toContain("Run or identify the relevant release checks.");
  });

  test("expand_runbook returns usage errors for invalid arguments", () => {
    expect(expand_runbook({
      name: "review-pr",
      raw_args: "",
      source_channel: "slack",
      source_ref: "C1:1.0",
    }).error).toContain("Usage: /review-pr <url>");

    expect(expand_runbook({
      name: "unknown",
      raw_args: "",
      source_channel: "slack",
      source_ref: "C1:1.0",
    }).error).toContain("Unknown runbook");
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/runbooks.test.ts
```

Expected: fail because `backend/src/runbooks.ts` does not exist.

- [ ] **Step 3: Implement runbook registry**

Create `backend/src/runbooks.ts`:

```ts
import { makeTask, ScheduleType, type Task } from "./types.ts";
import { makeTaskBrief, type TaskBrief } from "./types.ts";

export const RunbookConfirmationPolicy = {
  AUTO: "auto",
  REQUIRED: "required",
} as const;
export type RunbookConfirmationPolicy =
  (typeof RunbookConfirmationPolicy)[keyof typeof RunbookConfirmationPolicy];

export const RunbookSourceType = {
  BUILTIN: "builtin",
  TEMPLATE: "template",
  SKILL: "skill",
} as const;
export type RunbookSourceType =
  (typeof RunbookSourceType)[keyof typeof RunbookSourceType];

export interface RunbookDefinition {
  name: string;
  aliases: string[];
  description: string;
  source_type: RunbookSourceType;
  source_id: string | null;
  command_schema: Record<string, unknown>;
  prompt_template: string;
  default_agent: string | null;
  confirmation_policy: RunbookConfirmationPolicy;
  enabled: boolean;
}

export interface ParsedRunbookCommand {
  name: string;
  args: string[];
  raw_args: string;
}

export interface RunbookExpansion {
  runbook: RunbookDefinition;
  confirmation_policy: RunbookConfirmationPolicy;
  task: Task;
  brief: TaskBrief;
}

export type RunbookResult =
  | { ok: true; expansion: RunbookExpansion }
  | { ok: false; error: string };

type ExpandArgs = {
  name: string;
  raw_args: string;
  source_channel: string;
  source_ref: string;
  source_metadata?: Record<string, unknown>;
  working_dir?: string | null;
  agent?: string | null;
};

type BuiltinSpec = RunbookDefinition & {
  usage: string;
  title: (rawArgs: string) => string;
  goal: (rawArgs: string) => string;
  acceptance: (rawArgs: string) => string[];
  validate: (rawArgs: string) => string | null;
};

function firstArg(rawArgs: string): string {
  return rawArgs.trim().split(/\s+/)[0] ?? "";
}

function requireArg(usage: string): (rawArgs: string) => string | null {
  return (rawArgs) => (firstArg(rawArgs) ? null : `Usage: ${usage}`);
}

function noValidation(_rawArgs: string): string | null {
  return null;
}

export const BUILTIN_RUNBOOKS: BuiltinSpec[] = [
  {
    name: "review-pr",
    aliases: [],
    description: "Review a pull request and summarize risks, bugs, and missing tests.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["url"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
    usage: "/review-pr <url>",
    validate: requireArg("/review-pr <url>"),
    title: () => "[Runbook] Review PR",
    goal: (rawArgs) => `Review this pull request:\n${firstArg(rawArgs)}`,
    acceptance: () => [
      "Identify correctness, reliability, security, and test coverage risks.",
      "Call out specific files or changes when possible.",
      "Summarize whether the PR is safe to merge and what should change first.",
    ],
  },
  {
    name: "fix-ci",
    aliases: [],
    description: "Inspect a failing CI run and propose or apply the minimal fix.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["url"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/fix-ci <url>",
    validate: requireArg("/fix-ci <url>"),
    title: () => "Fix failing CI run",
    goal: (rawArgs) => `Investigate this failing CI run and fix the minimal issue:\n${firstArg(rawArgs)}`,
    acceptance: () => [
      "Identify the failing job and likely cause.",
      "Patch the minimal relevant code or configuration.",
      "Run the focused tests or explain why they cannot run.",
    ],
  },
  {
    name: "summarize-thread",
    aliases: [],
    description: "Summarize the current IM thread into a task brief or notes.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/summarize-thread",
    validate: noValidation,
    title: () => "Summarize IM thread",
    goal: () => "Summarize the current IM thread into a clear task brief or notes.",
    acceptance: () => [
      "Extract the concrete asks, decisions, and open questions.",
      "Separate facts from assumptions.",
      "Produce a concise summary suitable for creating a task.",
    ],
  },
  {
    name: "write-tests",
    aliases: [],
    description: "Add or improve tests for a file or module.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["path"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
    usage: "/write-tests <path>",
    validate: requireArg("/write-tests <path>"),
    title: (rawArgs) => `[Runbook] Write tests for ${firstArg(rawArgs)}`,
    goal: (rawArgs) => `Add or improve tests for ${firstArg(rawArgs)}.`,
    acceptance: () => [
      "Identify the behavior that needs coverage.",
      "Add focused tests using the repo's existing test style.",
      "Run the relevant test command or explain why it cannot run.",
    ],
  },
  {
    name: "release-check",
    aliases: [],
    description: "Run a release readiness checklist for the active repo.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/release-check",
    validate: noValidation,
    title: () => "Release readiness check",
    goal: () => "Run a release readiness checklist for the active repository.",
    acceptance: () => [
      "Inspect the current repository state and recent changes.",
      "Run or identify the relevant release checks.",
      "Report blockers, risks, and the recommended release decision.",
    ],
  },
  {
    name: "scan-skills",
    aliases: [],
    description: "Trigger a manual Skill Library scan.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/scan-skills",
    validate: noValidation,
    title: () => "Scan for reusable skills",
    goal: () => "Run a manual Skill Library scan for recurring task patterns.",
    acceptance: () => [
      "Scan recent completed runs for recurring workflows.",
      "Summarize any candidate skills or report that none were found.",
      "Do not install any skill without explicit approval.",
    ],
  },
];

export function parse_runbook_command(text: string): ParsedRunbookCommand | null {
  const trimmed = text.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const raw_args = (match[2] ?? "").trim();
  const known = find_runbook(name);
  if (!known) return null;
  return {
    name: known.name,
    raw_args,
    args: raw_args ? raw_args.split(/\s+/) : [],
  };
}

export function find_runbook(nameOrAlias: string): BuiltinSpec | null {
  const normalized = nameOrAlias.toLowerCase();
  return (
    BUILTIN_RUNBOOKS.find(
      (runbook) =>
        runbook.name === normalized ||
        runbook.aliases.some((alias) => alias.toLowerCase() === normalized),
    ) ?? null
  );
}

export function expand_runbook(args: ExpandArgs): RunbookResult {
  const runbook = find_runbook(args.name);
  if (!runbook) return { ok: false, error: `Unknown runbook: ${args.name}` };
  const validationError = runbook.validate(args.raw_args);
  if (validationError) return { ok: false, error: validationError };

  const title = runbook.title(args.raw_args);
  const goal = runbook.goal(args.raw_args);
  const acceptance = runbook.acceptance(args.raw_args);
  const prompt = [
    `Runbook: /${runbook.name}`,
    "",
    "Goal:",
    goal,
    "",
    "Acceptance criteria:",
    ...acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
  const agent = args.agent ?? runbook.default_agent;
  const task = makeTask({
    title,
    prompt,
    working_dir: args.working_dir ?? null,
    schedule_type: ScheduleType.IMMEDIATE,
    tags: `runbook,${runbook.name},${args.source_channel}`,
    agent,
  });
  const brief = makeTaskBrief({
    title: title.replace(/^\[Runbook]\s*/, ""),
    goal,
    context_summary: `Created from /${runbook.name} ${args.raw_args}`.trim(),
    acceptance_criteria: acceptance,
    working_dir: args.working_dir ?? null,
    working_dir_confidence: args.working_dir ? "high" : "unknown",
    agent,
    risk_level: runbook.confirmation_policy === "required" ? "elevated" : "normal",
    needs_confirmation: runbook.confirmation_policy === "required",
    source_channel: args.source_channel,
    source_ref: args.source_ref,
    source_metadata: args.source_metadata ?? {},
  });

  return {
    ok: true,
    expansion: {
      runbook,
      confirmation_policy: runbook.confirmation_policy,
      task,
      brief,
    },
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cd backend && bun test tests/runbooks.test.ts
```

Expected: all runbook parser and expansion tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/runbooks.ts backend/tests/runbooks.test.ts
git commit -m "Add shared IM runbook registry"
```

## Task 2: Runbook Persistence

**Files:**

- Modify: `backend/src/types.ts`
- Modify: `backend/src/db.ts`
- Test: `backend/tests/runbook-db.test.ts`

- [ ] **Step 1: Write failing DB tests**

Create `backend/tests/runbook-db.test.ts`:

```ts
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
    db.close();
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
    expect(loaded["name"]).toBe("triage-issue");
    expect(loaded["aliases"]).toEqual(["issue-triage"]);
    expect(loaded["command_schema"]).toEqual({ args: ["url"] });
    expect(loaded["enabled"]).toBe(true);
  });

  test("im runbooks update list and delete", () => {
    const id = db.add_im_runbook(makeIMRunbook({ name: "custom-check", prompt_template: "Check it" }));
    db.update_im_runbook(id, { enabled: false, description: "Disabled" });
    expect(db.get_im_runbook(id)!["enabled"]).toBe(false);
    expect(db.get_im_runbooks()).toHaveLength(1);
    db.delete_im_runbook(id);
    expect(db.get_im_runbook(id)).toBeNull();
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/runbook-db.test.ts
```

Expected: fail because `makeIMRunbook` and DB methods do not exist.

- [ ] **Step 3: Add IMRunbook type and DB methods**

In `backend/src/types.ts`, add:

```ts
export const RunbookSourceType = {
  BUILTIN: "builtin",
  TEMPLATE: "template",
  SKILL: "skill",
} as const;
export type RunbookSourceType =
  (typeof RunbookSourceType)[keyof typeof RunbookSourceType];

export const RunbookConfirmationPolicy = {
  AUTO: "auto",
  REQUIRED: "required",
} as const;
export type RunbookConfirmationPolicy =
  (typeof RunbookConfirmationPolicy)[keyof typeof RunbookConfirmationPolicy];

export interface IMRunbook {
  id: number | null;
  name: string;
  aliases: string[];
  description: string;
  source_type: RunbookSourceType;
  source_id: string | null;
  command_schema: Record<string, unknown>;
  prompt_template: string;
  default_agent: string | null;
  confirmation_policy: RunbookConfirmationPolicy;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export function makeIMRunbook(partial: Partial<IMRunbook> = {}): IMRunbook {
  return {
    id: null,
    name: "",
    aliases: [],
    description: "",
    source_type: RunbookSourceType.TEMPLATE,
    source_id: null,
    command_schema: {},
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
    created_at: null,
    updated_at: null,
    ...partial,
  };
}
```

In `backend/src/db.ts`, add `im_runbooks` schema during `_init_db`:

```sql
CREATE TABLE IF NOT EXISTS im_runbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  aliases TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL,
  source_id TEXT,
  command_schema TEXT NOT NULL DEFAULT '{}',
  prompt_template TEXT NOT NULL,
  default_agent TEXT,
  confirmation_policy TEXT NOT NULL DEFAULT 'auto',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

Then add methods:

```ts
add_im_runbook(runbook: IMRunbook): number;
get_im_runbook(id: number): Row | null;
get_im_runbook_by_name(name: string): Row | null;
get_im_runbooks(): Row[];
update_im_runbook(id: number, updates: Record<string, unknown>): void;
delete_im_runbook(id: number): void;
```

Use the same JSON encode/decode pattern as `task_briefs`.

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cd backend && bun test tests/runbook-db.test.ts
```

Expected: DB persistence tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/types.ts backend/src/db.ts backend/tests/runbook-db.test.ts
git commit -m "Add IM runbook persistence"
```

## Task 3: MessageBus and Scheduler Runbook Actions

**Files:**

- Modify: `backend/src/bus.ts`
- Modify: `backend/src/scheduler.ts`
- Modify: `backend/tests/bus.test.ts`
- Test: `backend/tests/scheduler-runbooks.test.ts`

- [ ] **Step 1: Write failing bus and scheduler tests**

Extend `backend/tests/bus.test.ts` with:

```ts
test("test_message_bus_round_trips_runbook_inbound_messages", async () => {
  const bus = new MessageBus();
  const channel = new TestChannel(bus, { get_task: () => null });

  channel.publish_inbound(
    channel._make_inbound(InboundMessageType.PREVIEW_RUNBOOK, {
      name: "review-pr",
      raw_args: "https://github.com/acme/app/pull/42",
    }),
  );
  channel.publish_inbound(
    channel._make_inbound(InboundMessageType.RUN_RUNBOOK, {
      name: "review-pr",
      raw_args: "https://github.com/acme/app/pull/42",
    }),
  );

  expect((await bus.get_inbound())!.type).toBe("preview_runbook");
  expect((await bus.get_inbound())!.type).toBe("run_runbook");
});
```

Create `backend/tests/scheduler-runbooks.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { InboundMessageType, makeInboundMessage } from "../src/bus.ts";
import { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";

describe("scheduler runbook inbound actions", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-runbooks-"));
    db = new TaskDB(path.join(tmpDir, "tasks.db"));
    scheduler = new TaskScheduler(db);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("PREVIEW_RUNBOOK returns expansion without creating task or brief", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.PREVIEW_RUNBOOK,
        source: "slack",
        payload: {
          name: "review-pr",
          raw_args: "https://github.com/acme/app/pull/42",
          working_dir: "~/repo",
        },
        reply_to: "C1",
        metadata: { channel_id: "C1" },
      }),
    );

    expect(result["status"]).toBe("preview");
    expect(result["runbook"]).toBe("review-pr");
    expect(result["task"]).toEqual(expect.objectContaining({ title: "[Runbook] Review PR" }));
    expect(db.get_tasks()).toHaveLength(0);
    expect(db.get_task_briefs()).toHaveLength(0);
  });

  test("RUN_RUNBOOK creates immediate tasks for auto runbooks", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "slack",
        payload: {
          name: "review-pr",
          raw_args: "https://github.com/acme/app/pull/42",
          working_dir: "~/repo",
        },
        reply_to: "C1",
        metadata: { channel_id: "C1" },
      }),
    );

    expect(result["status"]).toBe("created");
    expect(result["task_id"]).toBe(1);
    expect(db.get_task(1)!["tags"]).toContain("runbook");
  });

  test("RUN_RUNBOOK creates briefs for required-confirmation runbooks", () => {
    const result = scheduler.handle_inbound_message(
      makeInboundMessage({
        type: InboundMessageType.RUN_RUNBOOK,
        source: "telegram",
        payload: {
          name: "release-check",
          raw_args: "",
          working_dir: "~/repo",
        },
        reply_to: "10",
        metadata: { chat_id: 10 },
      }),
    );

    expect(result["status"]).toBe("draft");
    expect(result["brief_id"]).toBe(1);
    expect(db.get_task_brief(1)!["title"]).toBe("Release readiness check");
    expect(db.get_tasks()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/bus.test.ts --test-name-pattern runbook
cd backend && bun test tests/scheduler-runbooks.test.ts
```

Expected: fail because inbound enum values and scheduler branches do not exist.

- [ ] **Step 3: Add inbound types and scheduler branches**

In `backend/src/bus.ts`, add:

```ts
RUN_RUNBOOK: "run_runbook",
PREVIEW_RUNBOOK: "preview_runbook",
```

Update the inbound payload comment:

```ts
 * RUN_RUNBOOK -> {"name", "raw_args", "working_dir", "agent"}
 * PREVIEW_RUNBOOK -> {"name", "raw_args", "working_dir", "agent"}
```

In `backend/src/scheduler.ts`, import `expand_runbook` and add branches in `handle_inbound_message`:

```ts
if (msg.type === InboundMessageType.PREVIEW_RUNBOOK) {
  return this._preview_runbook(msg);
}
if (msg.type === InboundMessageType.RUN_RUNBOOK) {
  return this._run_runbook(msg);
}
```

Add helpers:

```ts
_preview_runbook(msg: InboundMessage): Row {
  const result = expand_runbook({
    name: String(msg.payload["name"] ?? ""),
    raw_args: String(msg.payload["raw_args"] ?? ""),
    source_channel: msg.source,
    source_ref: String(msg.payload["source_ref"] ?? msg.reply_to ?? msg.source),
    source_metadata: msg.metadata,
    working_dir: (msg.payload["working_dir"] as string | null | undefined) ?? null,
    agent: (msg.payload["agent"] as string | null | undefined) ?? null,
  });
  if (!result.ok) throw new Error(result.error);
  return {
    status: "preview",
    runbook: result.expansion.runbook.name,
    confirmation_policy: result.expansion.confirmation_policy,
    task: result.expansion.task,
    brief: result.expansion.brief,
  };
}

_run_runbook(msg: InboundMessage): Row {
  const preview = this._preview_runbook(msg);
  if (preview["confirmation_policy"] === "required") {
    const brief_id = this.db.add_task_brief(preview["brief"] as TaskBrief);
    return { status: "draft", brief_id, runbook: preview["runbook"] };
  }
  const task_id = this.submit_task(preview["task"] as Task);
  return { status: "created", task_id, runbook: preview["runbook"] };
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cd backend && bun test tests/bus.test.ts --test-name-pattern runbook
cd backend && bun test tests/scheduler-runbooks.test.ts
```

Expected: bus and scheduler runbook tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/bus.ts backend/src/scheduler.ts backend/tests/bus.test.ts backend/tests/scheduler-runbooks.test.ts
git commit -m "Add scheduler runbook actions"
```

## Task 4: Runbook REST API

**Files:**

- Modify: `backend/src/api.ts`
- Modify: `backend/tests/api-handler.test.ts`

- [ ] **Step 1: Write failing API tests**

Add to `backend/tests/api-handler.test.ts`:

```ts
test("runbook API lists builtins and previews runbooks", async () => {
  const listed = await json(new Request("http://127.0.0.1:9712/api/im-runbooks"));
  expect(listed["runbooks"].some((runbook: any) => runbook["name"] === "review-pr")).toBe(true);

  const previewRes = await handleApiRequest(
    ctx,
    new Request("http://127.0.0.1:9712/api/im-runbooks/review-pr/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_args: "https://github.com/acme/app/pull/42",
        working_dir: "~/repo",
        source_channel: "api",
        source_ref: "manual",
      }),
    }),
  );
  expect(previewRes.status).toBe(200);
  const preview = await previewRes.json();
  expect(preview["status"]).toBe("preview");
  expect(preview["task"]["title"]).toBe("[Runbook] Review PR");
});

test("runbook API creates user runbooks and runs builtins", async () => {
  const createdRes = await handleApiRequest(
    ctx,
    new Request("http://127.0.0.1:9712/api/im-runbooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "custom-check",
        aliases: ["ccheck"],
        description: "Run a custom check",
        source_type: "template",
        prompt_template: "Check the repo",
        confirmation_policy: "required",
      }),
    }),
  );
  expect(createdRes.status).toBe(201);
  const created = await createdRes.json();

  const patched = await handleApiRequest(
    ctx,
    new Request(`http://127.0.0.1:9712/api/im-runbooks/${created["id"]}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }),
  );
  expect(patched.status).toBe(200);

  const runRes = await handleApiRequest(
    ctx,
    new Request("http://127.0.0.1:9712/api/im-runbooks/release-check/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ working_dir: "~/repo", source_channel: "api", source_ref: "manual" }),
    }),
  );
  expect(runRes.status).toBe(201);
  const run = await runRes.json();
  expect(run["status"]).toBe("draft");
  expect(db.get_task_brief(Number(run["brief_id"]))).not.toBeNull();

  const deleted = await handleApiRequest(
    ctx,
    new Request(`http://127.0.0.1:9712/api/im-runbooks/${created["id"]}`, { method: "DELETE" }),
  );
  expect(deleted.status).toBe(200);
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/api-handler.test.ts --test-name-pattern runbook
```

Expected: fail with 404s for `/api/im-runbooks`.

- [ ] **Step 3: Implement API routes**

Add route handling before generic task routes:

```ts
if (path === "/api/im-runbooks" && method === "GET") {
  return jsonResponse({
    runbooks: builtin_runbooks_for_api().concat(ctx.db.get_im_runbooks()),
  });
}
if (path === "/api/im-runbooks" && method === "POST") {
  const body = await readJson(request);
  const id = ctx.db.add_im_runbook(validateIMRunbookPayload(body));
  return jsonResponse({ id, ...ctx.db.get_im_runbook(id) }, 201);
}
```

Add routes for:

```text
PATCH /api/im-runbooks/:id
DELETE /api/im-runbooks/:id
POST /api/im-runbooks/:name/preview
POST /api/im-runbooks/:name/run
```

Preview/run should call `ctx.scheduler.handle_inbound_message(makeInboundMessage(...))` so API behavior matches IM behavior.

- [ ] **Step 4: Verify API tests pass**

Run:

```bash
cd backend && bun test tests/api-handler.test.ts --test-name-pattern runbook
```

Expected: runbook API tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api.ts backend/tests/api-handler.test.ts
git commit -m "Add IM runbook API"
```

## Task 5: Channel Text Fallback

**Files:**

- Modify: `backend/src/channels/slack.ts`
- Modify: `backend/src/channels/feishu.ts`
- Modify: `backend/src/channels/weixin.ts`
- Modify: `backend/src/channels/telegram.ts`
- Modify tests for all four channels.

- [ ] **Step 1: Write failing channel tests**

For each channel test file, add tests matching that channel's helper style. The Slack test should look like:

```ts
test("test_runbook_command_runs_or_creates_draft_from_text_fallback", async () => {
  const scheduler = new StubScheduler();
  const { channel, web } = _make_channel(undefined, scheduler);

  await with_resolved_dir("~/repo", () =>
    channel._handle_user_message("/review-pr https://github.com/acme/app/pull/42", "C1", null, "1.0"),
  );

  expect(scheduler.inbound.at(-1)!.type).toBe(InboundMessageType.RUN_RUNBOOK);
  expect(scheduler.inbound.at(-1)!.payload["name"]).toBe("review-pr");
  expect(scheduler.inbound.at(-1)!.payload["raw_args"]).toBe("https://github.com/acme/app/pull/42");
  expect(last_text(web)).toContain("Task #");

  await channel._handle_user_message("/release-check", "C1", null, "2.0");

  expect(scheduler.inbound.at(-1)!.type).toBe(InboundMessageType.RUN_RUNBOOK);
  expect(scheduler.inbound.at(-1)!.payload["name"]).toBe("release-check");
  expect(last_text(web)).toContain("Draft task brief #");
});
```

Mirror the same assertions in Feishu, Weixin, and Telegram using their existing fake send helpers.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/slack-channel.test.ts --test-name-pattern runbook
cd backend && bun test tests/feishu-channel.test.ts --test-name-pattern runbook
cd backend && bun test tests/weixin-channel.test.ts --test-name-pattern runbook
cd backend && bun test tests/telegram-channel.test.ts --test-name-pattern runbook
```

Expected: fail because channels do not parse runbook commands yet.

- [ ] **Step 3: Implement shared channel rendering helpers**

In `backend/src/runbooks.ts`, add:

```ts
export function format_runbook_created_reply(taskId: number, runbook: string): string {
  return `Task #${taskId} started from /${runbook}. Thinking ▌`;
}

export function format_runbook_brief_reply(briefId: number, runbook: string): string {
  return [
    `Draft task brief #${briefId} created from /${runbook}.`,
    "",
    `Run: \`/confirm-brief ${briefId}\``,
    `Discard: \`/discard-brief ${briefId}\``,
  ].join("\n");
}
```

- [ ] **Step 4: Add channel runbook branches**

In each channel, call `parse_runbook_command(text)` after brief commands and before legacy unknown-command handling or default task creation.

Each branch should send:

```ts
this._make_inbound(InboundMessageType.RUN_RUNBOOK, {
  name: parsed.name,
  raw_args: parsed.raw_args,
  source_ref,
  working_dir: await resolve_working_dir(parsed.raw_args || text, channelName, this.db),
  agent: resolve_agent(channelName, this.db),
}, reply_to, metadata)
```

Then render:

```ts
if (result["status"] === "created") {
  // map origin and start streaming when the channel supports streaming
}
if (result["status"] === "draft") {
  // reply with draft instructions
}
```

- [ ] **Step 5: Verify channel tests pass**

Run the four focused channel commands from Step 2 again.

Expected: all runbook channel tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/runbooks.ts backend/src/channels/slack.ts backend/src/channels/feishu.ts backend/src/channels/weixin.ts backend/src/channels/telegram.ts backend/tests/slack-channel.test.ts backend/tests/feishu-channel.test.ts backend/tests/weixin-channel.test.ts backend/tests/telegram-channel.test.ts
git commit -m "Add IM runbook text fallback"
```

## Task 6: Phase 2 Quality Gate

**Files:**

- All changed files.

- [ ] **Step 1: Run focused runbook tests**

```bash
cd backend && bun test tests/runbooks.test.ts tests/runbook-db.test.ts tests/scheduler-runbooks.test.ts tests/api-handler.test.ts tests/slack-channel.test.ts tests/feishu-channel.test.ts tests/weixin-channel.test.ts tests/telegram-channel.test.ts
```

Expected: all focused runbook and channel tests pass.

- [ ] **Step 2: Run backend CI gate**

```bash
make check
```

If formatting fails:

```bash
make format
make check
```

Expected: backend typecheck, Prettier check, and all tests pass.

- [ ] **Step 3: Commit any final cleanup**

```bash
git status --short
git add <only files changed by this phase>
git commit -m "Complete IM runbooks phase"
```

Skip this commit if all work was already committed task-by-task and `git status --short` is clean.

## Self-Review

- Spec coverage:
  - Shared RunbookRegistry: Task 1.
  - Builtin runbooks: Task 1.
  - `im_runbooks` persistence: Task 2.
  - MessageBus `RUN_RUNBOOK` and `PREVIEW_RUNBOOK`: Task 3.
  - REST API: Task 4.
  - Text fallback across Slack, Feishu, Telegram, Weixin: Task 5.
  - Full backend quality gate: Task 6.
- Intentional gaps:
  - Template Library UI and rich cards are deferred because the spec allows text fallback first.
  - Skill-promoted runbooks are represented in the data model but not auto-generated in this phase.
- Placeholder scan:
  - No `TODO`, `TBD`, or "similar to" placeholders remain.
- Type consistency:
  - `RunbookConfirmationPolicy`, `RunbookSourceType`, `IMRunbook`, `RunbookDefinition`, `RunbookExpansion`, `RUN_RUNBOOK`, and `PREVIEW_RUNBOOK` names are used consistently across tasks.
