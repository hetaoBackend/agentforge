# IM Inbox Phase 1 Task Briefs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working slice of AgentForge IM Inbox: durable TaskBrief drafts that can be created, edited, confirmed into real tasks, and discarded through the backend API and shared message flow.

**Architecture:** Add TaskBrief as a shared backend model, persisted in SQLite and exposed through REST endpoints. Confirmation converts a brief into the existing TaskScheduler path, so execution, board updates, output streaming, and notifications remain unchanged. Channel adapters will stay thin and can opt into brief creation after the backend contract is stable.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test, existing AgentForge REST API and scheduler.

---

## Scope

This plan implements Phase 1 from `docs/superpowers/specs/2026-06-14-agentforge-im-inbox-design.md`.

In scope:

- `TaskBrief` type and `makeTaskBrief` helper.
- `task_briefs` SQLite table and CRUD methods.
- REST API:
  - `GET /api/task-briefs`
  - `GET /api/task-briefs/:id`
  - `POST /api/task-briefs`
  - `PATCH /api/task-briefs/:id`
  - `POST /api/task-briefs/:id/confirm`
  - `POST /api/task-briefs/:id/discard`
- Confirmation creates a real AgentForge task through `TaskScheduler.submit_task`.
- Tests for DB behavior, API behavior, and confirmation invariants.

Out of scope for this first slice:

- Agent-based classification/extraction.
- IM runbooks.
- Scheduled digests.
- Skill suggestion delivery.
- Rich Feishu/Slack cards.
- Migrating all existing channel message handlers to create briefs automatically.

The existing Telegram streaming changes in the worktree are unrelated and must be preserved.

## File Structure

- Modify `backend/src/types.ts`
  - Add `TaskBriefStatus`, `TaskBrief`, and `makeTaskBrief`.
- Modify `backend/src/db.ts`
  - Add `task_briefs` table.
  - Add `add_task_brief`, `get_task_brief`, `get_task_briefs`, `update_task_brief`, `confirm_task_brief`, and `discard_task_brief`.
- Modify `backend/src/api.ts`
  - Add request parsing/validation helpers for briefs.
  - Add task brief REST routes.
  - Confirm endpoint creates a normal `Task`.
- Add `backend/tests/task-briefs.test.ts`
  - Unit tests for SQLite model behavior.
- Modify `backend/tests/api-handler.test.ts`
  - API tests for create/list/get/update/confirm/discard.

## Task 1: TaskBrief Model and DB Migration

**Files:**

- Modify: `backend/src/types.ts`
- Modify: `backend/src/db.ts`
- Test: `backend/tests/task-briefs.test.ts`

- [ ] **Step 1: Write failing DB tests**

Create `backend/tests/task-briefs.test.ts` with tests for:

```ts
test("task briefs round-trip structured fields", () => {
  const brief = makeTaskBrief({
    title: "Fix auth",
    goal: "Fix login redirect",
    context_summary: "Forwarded QA report",
    acceptance_criteria: ["Identify cause", "Patch minimal code"],
    working_dir: "~/workspace/app",
    working_dir_confidence: "high",
    agent: "codex",
    risk_level: "normal",
    needs_confirmation: true,
    source_channel: "telegram",
    source_ref: "chat-1:msg-2",
    source_metadata: { chat_id: "chat-1" },
  });

  const id = db.add_task_brief(brief);
  const loaded = db.get_task_brief(id)!;

  expect(loaded["status"]).toBe("draft");
  expect(loaded["title"]).toBe("Fix auth");
  expect(loaded["acceptance_criteria"]).toEqual([
    "Identify cause",
    "Patch minimal code",
  ]);
  expect(loaded["source_metadata"]).toEqual({ chat_id: "chat-1" });
});
```

Also test that `discard_task_brief` changes status to `discarded`, and `confirm_task_brief` records `created_task_id` and changes status to `converted`.

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/task-briefs.test.ts
```

Expected: fail because `makeTaskBrief` and DB methods do not exist.

- [ ] **Step 3: Implement model and DB methods**

Add the TaskBrief type in `backend/src/types.ts`, mirroring existing snake_case style:

```ts
export const TaskBriefStatus = {
  DRAFT: "draft",
  CONVERTED: "converted",
  DISCARDED: "discarded",
  EXPIRED: "expired",
} as const;
export type TaskBriefStatus =
  (typeof TaskBriefStatus)[keyof typeof TaskBriefStatus];

export interface TaskBrief {
  id: number | null;
  status: TaskBriefStatus;
  title: string;
  goal: string;
  context_summary: string;
  acceptance_criteria: string[];
  working_dir: string | null;
  working_dir_confidence: string;
  agent: string | null;
  risk_level: string;
  needs_confirmation: boolean;
  source_channel: string;
  source_ref: string;
  source_metadata: Record<string, unknown>;
  created_task_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  expires_at: string | null;
}
```

In `backend/src/db.ts`, create `task_briefs` during `_init_db`, then add serializer/deserializer methods that JSON-encode `acceptance_criteria` and `source_metadata` and convert `needs_confirmation` to/from integer.

- [ ] **Step 4: Verify tests pass**

Run:

```bash
cd backend && bun test tests/task-briefs.test.ts
```

Expected: all tests pass.

## Task 2: TaskBrief API

**Files:**

- Modify: `backend/src/api.ts`
- Modify: `backend/tests/api-handler.test.ts`

- [ ] **Step 1: Write failing API tests**

Add tests to `backend/tests/api-handler.test.ts`:

```ts
test("task brief API creates lists updates and discards drafts", async () => {
  const createdRes = await handleApiRequest(
    ctx,
    new Request("http://127.0.0.1:9712/api/task-briefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fix auth",
        goal: "Fix login redirect",
        context_summary: "Forwarded QA report",
        acceptance_criteria: ["Identify cause", "Patch minimal code"],
        working_dir: ".",
        working_dir_confidence: "high",
        agent: "codex",
        source_channel: "telegram",
        source_ref: "chat-1:msg-2",
        source_metadata: { chat_id: "chat-1" },
      }),
    }),
  );
  expect(createdRes.status).toBe(201);
  const created = await createdRes.json();
  const id = Number(created["id"]);

  const listed = await json(
    new Request("http://127.0.0.1:9712/api/task-briefs"),
  );
  expect(listed["briefs"]).toHaveLength(1);

  const patched = await handleApiRequest(
    ctx,
    new Request(`http://127.0.0.1:9712/api/task-briefs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fix auth v2" }),
    }),
  );
  expect(patched.status).toBe(200);

  const discarded = await handleApiRequest(
    ctx,
    new Request(`http://127.0.0.1:9712/api/task-briefs/${id}/discard`, {
      method: "POST",
    }),
  );
  expect(discarded.status).toBe(200);
});
```

Add a second test for confirmation:

```ts
test("confirming a task brief creates a normal task", async () => {
  const created = await json(/* POST /api/task-briefs with goal and source */);
  const confirmedRes = await handleApiRequest(
    ctx,
    new Request(
      `http://127.0.0.1:9712/api/task-briefs/${created["id"]}/confirm`,
      { method: "POST" },
    ),
  );
  expect(confirmedRes.status).toBe(201);
  const confirmed = await confirmedRes.json();
  expect(confirmed["status"]).toBe("created");

  const task = db.get_task(Number(confirmed["task_id"]))!;
  expect(task["title"]).toContain("Fix auth");
  expect(task["prompt"]).toContain("Goal:");
  expect(task["prompt"]).toContain("Acceptance criteria:");
});
```

- [ ] **Step 2: Verify API tests fail**

Run:

```bash
cd backend && bun test tests/api-handler.test.ts --test-name-pattern "task brief"
```

Expected: fail with 404s for `/api/task-briefs`.

- [ ] **Step 3: Implement routes**

Add task brief routes before the generic `/api/tasks/:id` routes:

- `GET /api/task-briefs` returns `{ briefs: [...] }`.
- `GET /api/task-briefs/:id` returns one brief or 404.
- `POST /api/task-briefs` validates `title`, `goal`, `source_channel`, and `source_ref`.
- `PATCH /api/task-briefs/:id` only edits draft briefs.
- `POST /api/task-briefs/:id/discard` marks the brief discarded.
- `POST /api/task-briefs/:id/confirm` converts the brief into a normal task through `ctx.scheduler.submit_task`.

The confirm prompt format should be deterministic:

```text
Goal:
<goal>

Context:
<context_summary>

Acceptance criteria:
1. <criterion>
2. <criterion>
```

- [ ] **Step 4: Verify API tests pass**

Run:

```bash
cd backend && bun test tests/api-handler.test.ts --test-name-pattern "task brief"
```

Expected: tests pass.

## Task 3: MessageBus Type Surface for Brief Actions

**Files:**

- Modify: `backend/src/bus.ts`
- Modify: `backend/tests/bus.test.ts`

- [ ] **Step 1: Write failing bus tests**

Extend `backend/tests/bus.test.ts` to assert that these inbound types round-trip:

```ts
InboundMessageType.CREATE_BRIEF
InboundMessageType.CONFIRM_BRIEF
InboundMessageType.DISCARD_BRIEF
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
cd backend && bun test tests/bus.test.ts --test-name-pattern brief
```

Expected: fail because the enum values are missing.

- [ ] **Step 3: Add inbound types**

Add enum values in `backend/src/bus.ts`:

```ts
CREATE_BRIEF: "create_brief",
CONFIRM_BRIEF: "confirm_brief",
DISCARD_BRIEF: "discard_brief",
```

Document payload shape in the `InboundMessage` comment.

- [ ] **Step 4: Verify bus tests pass**

Run:

```bash
cd backend && bun test tests/bus.test.ts --test-name-pattern brief
```

Expected: tests pass.

## Task 4: Scheduler Handling for Brief Inbound Actions

**Files:**

- Modify: `backend/src/scheduler.ts`
- Test: add or extend an existing scheduler/bus test file.

- [ ] **Step 1: Write failing scheduler tests**

Add tests proving:

- `CREATE_BRIEF` adds a draft and does not create a task.
- `CONFIRM_BRIEF` converts an existing draft into a task.
- `DISCARD_BRIEF` marks a draft discarded.

- [ ] **Step 2: Verify tests fail**

Run the focused scheduler test.

- [ ] **Step 3: Implement inbound handling**

Extend the scheduler's MessageBus handling path to call the new DB methods. Keep existing `CREATE_TASK`, `RESUME_TASK`, `RESPOND_TASK`, `CANCEL_TASK`, and `STATUS_QUERY` behavior unchanged.

- [ ] **Step 4: Verify tests pass**

Run the focused scheduler test.

## Task 5: Quality Gate

**Files:**

- All files changed above.

- [ ] **Step 1: Run focused backend tests**

```bash
cd backend && bun test tests/task-briefs.test.ts tests/api-handler.test.ts tests/bus.test.ts
```

- [ ] **Step 2: Run backend CI gate**

```bash
make check
```

If formatting fails:

```bash
make format
make check
```

Expected: backend typecheck, prettier check, and tests pass.

## Self-Review

- Phase 1 creates a working, testable backend slice without requiring channel rewrites.
- Confirmation reuses the existing scheduler path, so task execution remains centralized.
- Rich IM UI and agent classification are explicitly deferred.
- The plan preserves the current Telegram worktree changes and does not require reverting them.
- Every production behavior listed here has a corresponding failing-test-first step.
