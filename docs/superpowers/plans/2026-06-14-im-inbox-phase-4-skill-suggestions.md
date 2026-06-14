# IM Inbox Phase 4 Skill Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Skill Library candidates actionable from IM by showing suggestions, starting draft generation, dismissing noisy patterns, and approving only after a draft has been shown.

**Architecture:** Add a focused shared module for IM skill suggestion collection, command parsing, and text rendering. Persist per-channel suggestion delivery state in SQLite so repeated suggestions can be suppressed and IM approval can require an already-shown draft. Reuse the existing scheduler `trigger_skill_draft`, `approve_skill`, and `dismiss_skill_pattern` methods.

**Tech Stack:** Bun, TypeScript, `bun:test`, SQLite via `bun:sqlite`, existing AgentForge `MessageBus`, `TaskScheduler`, and IM channel adapters.

---

## File Structure

- Create `backend/src/skill_suggestions.ts`
  - Collect candidate/drafted skill patterns for an IM channel.
  - Render text fallback suggestion messages.
  - Parse `/draft-skill`, `/approve-skill`, and `/dismiss-skill` commands.
- Modify `backend/src/types.ts`
  - Add `IMSkillSuggestionAction` enum-like constants if shared typing is needed.
- Modify `backend/src/db.ts`
  - Add `im_skill_suggestions` table and CRUD helpers for suggested/draft-shown/dismissed/approved state.
- Modify `backend/src/bus.ts`
  - Add `SKILL_SUGGESTION_ACTION` inbound message type.
- Modify `backend/src/scheduler.ts`
  - Add `_handle_skill_suggestion_action` using existing Skill Library methods.
- Modify `backend/src/api.ts`
  - Add preview/send/action endpoints and settings exposure.
- Modify `backend/src/channels/brief_utils.ts`
  - Export shared parser/formatter glue for skill suggestion commands.
- Modify `backend/src/channels/{slack,feishu,telegram,weixin}.ts`
  - Route text fallback commands to `SKILL_SUGGESTION_ACTION`.

## Task 1: Shared Suggestion Collection And Rendering

**Files:**
- Create: `backend/src/skill_suggestions.ts`
- Test: `backend/tests/skill-suggestions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskDB } from "../src/db.ts";
import { collect_im_skill_suggestions, render_im_skill_suggestion_text } from "../src/skill_suggestions.ts";
import { makeTask } from "../src/types.ts";

describe("IM skill suggestions", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-skill-suggestions-"));
    db = new TaskDB(path.join(tmpDir, "suggestions.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("collects candidate patterns that originated from an IM channel", () => {
    const taskId = db.add_task(makeTask({ title: "Fix CI", prompt: "p", tags: "runbook,fix-ci,slack" }));
    const patternId = db.upsert_skill_pattern("fix-ci-investigation", "recipe", "Investigate failed CI", taskId, 100)!;
    db.upsert_skill_pattern("fix-ci-investigation", "recipe", "Investigate failed CI", taskId, 101);
    db.upsert_skill_pattern("fix-ci-investigation", "recipe", "Investigate failed CI", taskId, 102);
    db.set_skill_pattern_status(patternId, "candidate");

    const suggestions = collect_im_skill_suggestions(db, { channel: "slack" });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.pattern_id).toBe(patternId);
    expect(render_im_skill_suggestion_text(suggestions[0]!)).toContain("/draft-skill");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test tests/skill-suggestions.test.ts`

Expected: FAIL because `backend/src/skill_suggestions.ts` does not exist.

- [ ] **Step 3: Implement minimal pure module**

Create `backend/src/skill_suggestions.ts` with:

```ts
export interface IMSkillSuggestion {
  pattern_id: number;
  pattern_key: string;
  summary: string;
  recurrence_count: number;
  status: string;
  draft_status: string | null;
  draft_name: string | null;
  draft_description: string | null;
  draft_body: string | null;
  source_tasks: Array<{ id: number; title: string }>;
}

export function collect_im_skill_suggestions(db: any, opts: { channel?: string | null; limit?: number } = {}): IMSkillSuggestion[] {
  // Use db.get_skill_patterns(), keep candidate rows plus rows with ready/drafting drafts.
  // Filter to contributing tasks whose tags include the requested channel.
}

export function render_im_skill_suggestion_text(suggestion: IMSkillSuggestion): string {
  // Render spec-shaped text with /draft-skill, /approve-skill, and /dismiss-skill commands.
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bun test tests/skill-suggestions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/skill_suggestions.ts backend/tests/skill-suggestions.test.ts
git commit -m "Add IM skill suggestion renderer"
```

## Task 2: Persist Suggestion State

**Files:**
- Modify: `backend/src/db.ts`
- Test: `backend/tests/skill-suggestions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that:

```ts
test("suggestion state suppresses repeated sends and records shown drafts", () => {
  db.upsert_im_skill_suggestion({ pattern_id: 7, channel: "slack", target: "C1", status: "suggested" });
  expect(db.get_im_skill_suggestion(7, "slack", "C1")!["status"]).toBe("suggested");
  expect(db.should_send_im_skill_suggestion(7, "slack", "C1")).toBe(false);

  db.mark_im_skill_suggestion_draft_shown(7, "slack", "C1");
  expect(db.get_im_skill_suggestion(7, "slack", "C1")!["draft_shown_at"]).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test tests/skill-suggestions.test.ts`

Expected: FAIL because DB methods do not exist.

- [ ] **Step 3: Add schema and helpers**

Add `im_skill_suggestions`:

```sql
CREATE TABLE IF NOT EXISTS im_skill_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'suggested',
    suggested_at TEXT,
    draft_shown_at TEXT,
    dismissed_at TEXT,
    approved_at TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(pattern_id, channel, target)
)
```

Add methods:

```ts
upsert_im_skill_suggestion(input: { pattern_id: number; channel: string; target?: string | null; status?: string; metadata?: Record<string, unknown> }): void
get_im_skill_suggestion(pattern_id: number, channel: string, target?: string | null): Row | null
should_send_im_skill_suggestion(pattern_id: number, channel: string, target?: string | null): boolean
mark_im_skill_suggestion_draft_shown(pattern_id: number, channel: string, target?: string | null): void
mark_im_skill_suggestion_status(pattern_id: number, channel: string, target: string | null, status: "dismissed" | "approved"): void
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bun test tests/skill-suggestions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db.ts backend/tests/skill-suggestions.test.ts
git commit -m "Persist IM skill suggestion state"
```

## Task 3: Scheduler And API Actions

**Files:**
- Modify: `backend/src/bus.ts`
- Modify: `backend/src/scheduler.ts`
- Modify: `backend/src/api.ts`
- Test: `backend/tests/scheduler-skill-suggestions.test.ts`
- Test: `backend/tests/api-handler.test.ts`

- [ ] **Step 1: Write the failing scheduler tests**

```ts
test("SKILL_SUGGESTION_ACTION starts draft generation", () => {
  const patternId = createCandidate(db);
  scheduler.trigger_skill_draft = mock(() => true) as any;
  const result = scheduler.handle_inbound_message(makeInboundMessage({
    type: InboundMessageType.SKILL_SUGGESTION_ACTION,
    source: "slack",
    payload: { action: "draft", pattern_id: patternId, source_channel: "slack", target: "C1" },
  }));
  expect(result["status"]).toBe("drafting");
});

test("SKILL_SUGGESTION_ACTION rejects approval before draft was shown", () => {
  const patternId = createCandidateWithReadyDraft(db);
  expect(() => scheduler.handle_inbound_message(makeInboundMessage({
    type: InboundMessageType.SKILL_SUGGESTION_ACTION,
    source: "slack",
    payload: { action: "approve", pattern_id: patternId, source_channel: "slack", target: "C1" },
  }))).toThrow("draft must be shown before approval");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test tests/scheduler-skill-suggestions.test.ts`

Expected: FAIL because the inbound type and handler do not exist.

- [ ] **Step 3: Implement scheduler action**

Add `InboundMessageType.SKILL_SUGGESTION_ACTION`, route it in `handle_inbound_message`, and implement:

- `draft`: call `trigger_skill_draft`, upsert suggestion state, return `{ status: "drafting" }`.
- `dismiss`: call `dismiss_skill_pattern`, mark suggestion dismissed, return `{ status: "dismissed" }`.
- `approve`: require a ready draft body and `draft_shown_at`, call `approve_skill`, mark suggestion approved, return `{ status: "approved", skill }`.
- `show`: require ready draft body, mark `draft_shown_at`, return `{ status: "ready", text, suggestion }`.

- [ ] **Step 4: Write API tests**

Add tests for:

- `POST /api/im-skill-suggestions/preview` returns rendered suggestions.
- `POST /api/im-skill-suggestions/:id/action` rejects approval before draft is shown.
- `POST /api/im-skill-suggestions/:id/action` with `show` marks the draft shown.

- [ ] **Step 5: Implement API routes**

Add:

```text
POST /api/im-skill-suggestions/preview
POST /api/im-skill-suggestions/send
POST /api/im-skill-suggestions/:id/action
```

Expose settings:

```text
im_skill_suggestions_enabled = 0
im_skill_suggestion_channels = []
```

- [ ] **Step 6: Run focused tests**

Run: `cd backend && bun test tests/scheduler-skill-suggestions.test.ts tests/api-handler.test.ts tests/bus.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/bus.ts backend/src/scheduler.ts backend/src/api.ts backend/tests/scheduler-skill-suggestions.test.ts backend/tests/api-handler.test.ts backend/tests/bus.test.ts
git commit -m "Add IM skill suggestion actions"
```

## Task 4: Channel Text Fallback

**Files:**
- Modify: `backend/src/channels/brief_utils.ts`
- Modify: `backend/src/channels/slack.ts`
- Modify: `backend/src/channels/feishu.ts`
- Modify: `backend/src/channels/telegram.ts`
- Modify: `backend/src/channels/weixin.ts`
- Test: `backend/tests/slack-channel.test.ts`
- Test: `backend/tests/feishu-channel.test.ts`
- Test: `backend/tests/telegram-channel.test.ts`
- Test: `backend/tests/weixin-channel.test.ts`

- [ ] **Step 1: Write failing parser and channel tests**

Parser expectations:

```ts
expect(parse_skill_suggestion_command("/draft-skill 4")).toEqual({ action: "draft", pattern_id: 4 });
expect(parse_skill_suggestion_command("/approve-skill #4")).toEqual({ action: "approve", pattern_id: 4 });
expect(parse_skill_suggestion_command("/dismiss-skill 4")).toEqual({ action: "dismiss", pattern_id: 4 });
```

Channel expectation:

```ts
await channel._handle_user_message("/draft-skill 4", "C1", null, "2.0");
expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.SKILL_SUGGESTION_ACTION);
expect(last_text(web)).toContain("Skill draft");
```

- [ ] **Step 2: Run channel tests to verify failure**

Run: `cd backend && bun test tests/slack-channel.test.ts tests/feishu-channel.test.ts tests/telegram-channel.test.ts tests/weixin-channel.test.ts`

Expected: FAIL because the parser and handlers are missing.

- [ ] **Step 3: Add shared parser and replies**

Add `parse_skill_suggestion_command`, `format_skill_suggestion_action_reply`, and `format_skill_suggestion_help` to `brief_utils.ts`.

- [ ] **Step 4: Wire all four channels**

In each slash-command branch, parse skill suggestion commands after brief/runbook and before generic `/help`; call scheduler with `SKILL_SUGGESTION_ACTION`.

- [ ] **Step 5: Run focused channel tests**

Run: `cd backend && bun test tests/slack-channel.test.ts tests/feishu-channel.test.ts tests/telegram-channel.test.ts tests/weixin-channel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/channels backend/tests/*channel.test.ts
git commit -m "Add IM skill suggestion text commands"
```

## Final Verification

- [ ] Run `make check`.
- [ ] If format fails, run `make format`, rerun `make check`, and commit formatting-only changes.
- [ ] Confirm `git status --short` has no unexpected tracked changes.
