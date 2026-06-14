# IM Inbox Phase 3 Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add IM digest preview and send flows that summarize recent AgentForge state without noisy per-event spam.

**Architecture:** Add a shared digest composer that reads tasks, heartbeats, and skill patterns from `TaskDB` and returns a deterministic `IMDigest` object plus text fallback body. API endpoints call the composer for preview and optionally deliver the text through configured channel adapters. Scheduler support starts with a `TRIGGER_DIGEST` inbound action so the scheduling surface is shared with other IM actions; cron automation can use the same action once channel recipients are configured.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test, existing `TaskDB`, `TaskScheduler`, `MessageBus`, and channel adapters.

---

## Scope

This plan implements Phase 3 from `docs/superpowers/specs/2026-06-14-agentforge-im-inbox-design.md`.

In scope:

- Shared digest composer with text fallback output.
- Digest content sections:
  - Completed tasks.
  - Needs-you tasks with `question`.
  - Failed tasks.
  - Heartbeat watcher decisions that are not idle.
  - Skill candidates or drafts waiting for attention.
  - Suggested next commands.
- `TRIGGER_DIGEST` inbound message type.
- REST API:
  - `POST /api/im-digests/preview`
  - `POST /api/im-digests/send`
- Digest settings surfaced through existing settings:
  - `im_digest_enabled`
  - `im_digest_cron`
  - `im_digest_channels`
  - `im_attention_digest_minutes`
- Text delivery through existing Slack, Feishu, Telegram, and Weixin channel objects when available.

Out of scope:

- Rich digest cards.
- UI settings controls in the renderer.
- Full cron automation loop if no recipients are configured.
- A second timer system separate from scheduler/heartbeat infrastructure.

## File Structure

- Create `backend/src/digests.ts`
  - Define digest types, source row normalization, composer, text renderer, and recipient parser.
- Add `backend/tests/digests.test.ts`
  - Unit tests for quiet empty digests, sections, suggested commands, and recipient parsing.
- Modify `backend/src/bus.ts`
  - Add `TRIGGER_DIGEST`.
- Modify `backend/tests/bus.test.ts`
  - Round-trip test for digest inbound action.
- Modify `backend/src/scheduler.ts`
  - Handle `TRIGGER_DIGEST` by returning a preview/sendable digest payload.
- Add `backend/tests/scheduler-digests.test.ts`
  - Scheduler tests for manual digest trigger and quiet behavior.
- Modify `backend/src/api.ts`
  - Add preview/send endpoints and expose digest settings.
- Modify `backend/tests/api-handler.test.ts`
  - API tests for preview, send, settings, and unavailable channel delivery errors.
- Modify channel adapters only as needed for small public send helpers.

## Task 1: Digest Composer

- [ ] **Step 1: Write failing composer tests**

Create `backend/tests/digests.test.ts` covering:

- Empty digest returns `has_content: false` and a quiet text body.
- Completed, failed, and question-waiting tasks produce separate sections.
- Non-idle heartbeat ticks produce watcher lines.
- Candidate/drafted skill patterns produce skill lines.
- Suggested commands include `/fix-ci <url>` after failed tasks and `/scan-skills` when skill items exist.
- Recipient parser accepts JSON array strings and rejects malformed entries.

- [ ] **Step 2: Implement `backend/src/digests.ts`**

Define:

- `IMDigestSection`
- `IMDigest`
- `IMDigestRecipient`
- `compose_im_digest(db, options)`
- `render_im_digest_text(digest)`
- `parse_im_digest_recipients(value)`

Keep the composer deterministic and bounded: default limit 10 rows per section.

- [ ] **Step 3: Verify**

Run:

```bash
cd backend && bun test tests/digests.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/digests.ts backend/tests/digests.test.ts
git commit -m "Add IM digest composer"
```

## Task 2: Bus and Scheduler Digest Action

- [ ] **Step 1: Write failing bus/scheduler tests**

Update `backend/tests/bus.test.ts` and add `backend/tests/scheduler-digests.test.ts`.

Expected behavior:

- `TRIGGER_DIGEST` round-trips through `MessageBus`.
- `TaskScheduler.handle_inbound_message(TRIGGER_DIGEST)` returns `{ status: "ready", digest }` when content exists.
- It returns `{ status: "quiet", digest }` when no content exists and `include_empty` is false.

- [ ] **Step 2: Implement bus and scheduler changes**

Add:

- `InboundMessageType.TRIGGER_DIGEST`
- `_handle_trigger_digest(msg)` in `TaskScheduler`

- [ ] **Step 3: Verify**

Run:

```bash
cd backend && bun test tests/bus.test.ts tests/scheduler-digests.test.ts tests/digests.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/bus.ts backend/src/scheduler.ts backend/tests/bus.test.ts backend/tests/scheduler-digests.test.ts
git commit -m "Add scheduler IM digest action"
```

## Task 3: Digest API and Delivery

- [ ] **Step 1: Write failing API tests**

Extend `backend/tests/api-handler.test.ts` for:

- `POST /api/im-digests/preview` returns a digest object and text body.
- `POST /api/im-digests/send` sends to an explicit recipient when the channel object is available.
- `POST /api/im-digests/send` returns `409` if no recipients are configured.
- `GET /api/settings` exposes digest settings.
- `PUT /api/settings` persists digest settings through the existing generic path.

- [ ] **Step 2: Implement API routes**

Add:

- `POST /api/im-digests/preview`
- `POST /api/im-digests/send`
- `send_im_digest(ctx, recipient, text)`

Channel delivery should use existing test seams:

- Slack: `_reply(channel_id, null, text)`
- Feishu: `_send_message(chat_id, text)`
- Telegram: send through `_api("sendMessage", ...)`
- Weixin: `_send_message(peer_id, text)` or the existing reply helper if available

- [ ] **Step 3: Verify**

Run:

```bash
cd backend && bun test tests/api-handler.test.ts tests/digests.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/api.ts backend/tests/api-handler.test.ts
git commit -m "Add IM digest API"
```

## Task 4: Phase 3 Quality Gate

- [ ] **Step 1: Run focused tests**

```bash
cd backend && bun test tests/digests.test.ts tests/scheduler-digests.test.ts tests/api-handler.test.ts tests/bus.test.ts
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

- [ ] **Step 3: Commit final cleanup if needed**

```bash
git status --short
git add <only files changed by this phase>
git commit -m "Complete IM digests phase"
```

Skip if clean.

## Self-Review

- Spec coverage:
  - Digest preview/send endpoints: Task 3.
  - Daily standup content shape: Task 1.
  - Attention-needed section: Task 1.
  - Watcher and skill sections: Task 1.
  - Scheduler reuse via inbound action: Task 2.
  - Existing settings path for digest settings: Task 3.
- Intentional gaps:
  - Rich cards and renderer settings controls are deferred.
  - Cron automation is represented through scheduler action and settings, but should only be activated when recipients are explicitly configured.
- Placeholder scan:
  - No `TODO`, `TBD`, or "similar to" placeholders remain.
