# AgentForge IM Inbox Design

**Status:** Draft  
**Date:** 2026-06-14  
**Scope:** Chat-to-Task Inbox, IM Runbooks, Agent Standup/Digest, Skill Suggestions

## 1. Product Thesis

AgentForge should treat IM as a first-class product surface, but not as a replacement for the desktop board.

The desktop app remains the place for deep inspection, configuration, and multi-task management. IM becomes the low-friction daily surface for four behaviors:

1. Drop messy context into AgentForge.
2. Turn that context into executable tasks or reusable runbooks.
3. Receive low-noise progress and standup summaries.
4. Approve useful skills when repeated work patterns emerge.

The user-facing promise:

> Forward a chat, screenshot, link, log, or rough instruction to AgentForge. It turns the mess into a clear task, runs the right agent, reports back when attention is needed, and gradually learns the recurring workflows worth saving.

This keeps AgentForge's core positioning intact: local-first, single-user, task-oriented agent orchestration for macOS.

## 2. Strategic Boundaries

- **Keep AgentForge single-user and local-first.** IM is a remote control and notification surface for the user's local Mac, not a multi-tenant team SaaS.
- **Do not build a general chat assistant.** IM messages should become tasks, runbooks, decisions, or summaries. Free-form conversation is only useful when attached to an AgentForge task.
- **Do not add more channels as the main bet.** The product value comes from better behavior on existing Feishu, Slack, Telegram, and WeChat integrations.
- **Preserve the kanban board.** IM should increase task creation and follow-up frequency; the desktop app still owns full history, settings, and detailed output.
- **Prefer explicit confirmation before expensive or ambiguous work.** IM input is often messy, forwarded, incomplete, or accidental.

## 3. One-Line Definition

AgentForge IM Inbox is a chat-native layer that converts incoming IM context into structured task briefs, exposes reusable runbooks as IM commands, sends scheduled agent standups, and asks for approval when repeated work can become a skill.

## 4. The Product Loop

```text
Chat / screenshot / forwarded message / link / log
        |
        v
IM Inbox extracts a structured task brief
        |
        v
User confirms or edits lightweight fields in IM
        |
        v
AgentForge creates and runs the task locally
        |
        v
IM reports only useful state changes and daily digests
        |
        v
Repeated workflows become runbooks or skill suggestions
        |
        v
Next time the user runs the same workflow from IM in one command
```

The loop matters more than any single feature. Chat-to-Task creates volume, runbooks create reuse, digests create return frequency, and skill suggestions create compounding value.

## 5. Feature Set

### 5.1 Chat-to-Task Inbox

**Goal**

Turn messy IM input into a clear AgentForge task before execution.

**Inputs**

- Plain messages.
- Forwarded chat records.
- Screenshots and images already supported by channel adapters.
- Links to PRs, issues, CI runs, docs, logs, or web pages.
- Existing reply-thread context when the message is sent inside a task conversation.

**Behavior**

When a message appears to be a new work request, AgentForge creates a `task_brief` draft instead of immediately running a task if any of these are true:

- The message contains forwarded context with multiple speakers.
- The message contains an image or attachment.
- The working directory is unknown or low-confidence.
- The requested action is ambiguous.
- The request appears expensive, destructive, or broad.

For simple direct commands with an obvious working directory, channels may keep the current fast path and create a task immediately.

**Task brief fields**

```json
{
  "title": "Fix login redirect regression",
  "goal": "Find and fix the redirect loop after password login.",
  "context_summary": "User forwarded a QA report and screenshot showing...",
  "source_items": [
    {
      "kind": "forwarded_message",
      "channel": "feishu",
      "source_ref": "message_id_or_thread_id"
    }
  ],
  "working_dir": "~/workspace/myapp",
  "working_dir_confidence": "high",
  "agent": "codex",
  "acceptance_criteria": [
    "Reproduce or identify the redirect loop.",
    "Patch the minimal relevant code.",
    "Run the focused auth tests or explain why they cannot run."
  ],
  "risk_level": "normal",
  "needs_confirmation": true
}
```

**IM interaction**

The user sees a concise brief:

```text
Draft task: Fix login redirect regression
Repo: ~/workspace/myapp
Agent: codex

Goal:
Find and fix the redirect loop after password login.

Acceptance:
1. Identify the cause.
2. Patch the minimal relevant code.
3. Run focused auth tests.

Reply "run" to start, "edit <field>: <value>" to adjust, or "discard".
```

Feishu and Slack can later render this as interactive cards/buttons. Telegram and WeChat can use text commands first.

**Why this matters**

The current "send any message to create a task" model is fast, but it treats all IM input as clean task text. Chat-to-Task Inbox acknowledges that the best IM inputs are often messy: forwarded conversations, screenshots, links, partial thoughts, and production symptoms.

### 5.2 IM Runbooks

**Goal**

Make repeatable AgentForge workflows runnable from IM with short, memorable commands.

**Definition**

An IM runbook is a named command that expands into a task template, prompt shape, agent choice, schedule defaults, and optional confirmation policy.

Examples:

```text
/review-pr https://github.com/acme/app/pull/42
/fix-ci https://github.com/acme/app/actions/runs/123
/summarize-thread
/write-tests backend/src/auth.ts
/release-check
/scan-skills
```

**Runbook sources**

Runbooks can come from three places:

1. Built-in AgentForge runbooks.
2. User-created templates from the Template Library.
3. Promoted skills or skill patterns that expose a command alias.

**Minimum built-in runbooks**

| Command | Purpose | Confirmation |
|---|---|---|
| `/review-pr <url>` | Review a PR and summarize risks, bugs, and missing tests. | Optional |
| `/fix-ci <url>` | Inspect a failing CI run and propose or apply a fix. | Required before code changes if repo is unclear |
| `/summarize-thread` | Summarize the current IM thread into a task brief or notes. | Required before task creation |
| `/write-tests <path>` | Add or improve tests for a file or module. | Optional |
| `/release-check` | Run a release readiness checklist for the active repo. | Required |
| `/scan-skills` | Trigger a manual Skill Library scan. | Required |

**Command resolution**

Command parsing should be channel-independent:

```text
Inbound IM text
  -> Channel adapter normalizes sender/thread metadata
  -> RunbookRegistry matches command and arguments
  -> Runbook expands to TaskBrief or direct Task
  -> User confirms if required
  -> Scheduler receives the final Task
```

**Why this matters**

Runbooks turn AgentForge from a task queue into a personal automation menu. They also create a natural bridge between IM, Template Library, and Skill Library.

### 5.3 Agent Standup / Digest

**Goal**

Bring AgentForge back into the user's daily flow without noisy per-event spam.

**Digest types**

1. **Daily standup:** A scheduled summary of recent task activity.
2. **Attention digest:** A batched message when one or more tasks need user input.
3. **Watcher digest:** A summary of heartbeat-triggered signals.
4. **Skill digest:** New skill candidates or draft skills waiting for approval.

**Default behavior**

- Daily standup is opt-in.
- Attention digest is enabled for tasks created from that channel.
- Digest messages are grouped by channel and user.
- Idle heartbeat ticks stay silent.

**Daily standup shape**

```text
AgentForge Standup

Completed:
1. Fixed auth redirect regression (#184)
2. Reviewed billing PR and found 2 test gaps

Needs you:
1. CI fix task is waiting for approval to edit workflow files
2. Skill draft "fix-ci-runbook" is ready to review

Failed:
1. Release check could not run tests: missing env DATABASE_URL

Suggested next:
/fix-ci <url>
/scan-skills
```

**Scheduling**

The digest should reuse the existing heartbeat/scheduler infrastructure instead of introducing a second timer system.

Suggested settings:

| Key | Default | Meaning |
|---|---|---|
| `im_digest_enabled` | `0` | Master switch for scheduled standups. |
| `im_digest_cron` | `0 9 * * 1-5` | Weekday 9 AM by default. |
| `im_digest_channels` | `[]` | Explicit channels and recipients to notify. |
| `im_attention_digest_minutes` | `20` | Batch user-input notifications within this window. |

**Why this matters**

AgentForge should feel alive without being needy. A good digest creates a reason to return and a compact sense that local agents are working on the user's behalf.

### 5.4 Skill Suggestions in IM

**Goal**

Move Skill Library approval into the same surface where the user already sees task outcomes.

**Trigger**

When Skill Library marks a pattern as `candidate` or `drafted`, AgentForge may send an IM suggestion if:

- the source tasks originated from that IM channel, or
- the user opted into global skill suggestions for that channel.

**Message shape**

```text
Skill suggestion: fix-ci-investigation

I found this recurring workflow across 3 tasks:
Investigate a failed CI run, identify the failing job, patch the minimal issue,
run the focused test, and update the PR summary.

Source tasks:
1. #183 Fix frontend CI
2. #191 Repair backend test job
3. #205 Update release workflow

Reply:
"draft" to generate a SKILL.md draft
"approve" to install after draft review
"dismiss" to stop suggesting this pattern
```

**Approval policy**

- IM can request draft generation.
- IM can approve installation only after the draft exists and has been shown or linked.
- Desktop UI remains the richest editor for the full `SKILL.md`.
- If the skill writes files under `~/.agentforge/skills`, `~/.claude/skills`, or `~/.agents/skills`, the approval message must explicitly say so.

**Why this matters**

Skill Library is the long-term compounding layer. IM suggestions make that compounding visible at the moment the user remembers the repeated work.

## 6. Architecture

### 6.1 New Backend Concepts

#### `TaskBrief`

A pending, structured draft that may become a real task.

Responsibilities:

- Store extracted task intent before execution.
- Preserve source IM context.
- Track confirmation status.
- Avoid polluting the task board with ambiguous or accidental messages.

Suggested statuses:

```text
draft -> confirmed -> converted
draft -> discarded
draft -> expired
```

#### `Runbook`

A reusable command definition that expands IM input into a task brief or task.

Responsibilities:

- Own command names and aliases.
- Validate arguments.
- Produce task title, prompt, working directory hints, agent choice, and confirmation policy.
- Bridge Template Library and Skill Library into IM.

#### `DigestJob`

A scheduled summarization pass that reads recent AgentForge state and sends one compact outbound message.

Responsibilities:

- Use existing scheduler/heartbeat timing.
- Summarize tasks, blocked states, heartbeat signals, and skill candidates.
- Avoid one-message-per-event spam.

### 6.2 Reused Existing Infrastructure

| Existing piece | Reuse |
|---|---|
| `MessageBus` inbound actions | Add brief confirmation, runbook execution, and digest-triggered actions. |
| Channel adapters | Normalize IM metadata and render channel-specific brief/digest messages. |
| `TaskScheduler.submit_task` | Final task execution remains unchanged after confirmation. |
| Heartbeats | Schedule daily digests and watcher summaries. |
| Skill Library tables | Source skill suggestions and draft status. |
| Template Library design | Source user-defined runbooks. |
| `task_output_events` | Feed digest summaries and skill suggestions. |

### 6.3 Channel Adapter Responsibilities

Each channel adapter should stay thin:

- Parse channel-specific events into normalized IM messages.
- Preserve sender, chat, thread, root message, attachments, and forwarded metadata.
- Render text fallback for all features.
- Use richer cards/buttons only where the channel supports them.

The business logic for briefs, runbooks, digest generation, and skill suggestions should live in shared backend modules, not separately in each channel.

## 7. Data Model

### 7.1 `task_briefs`

```sql
CREATE TABLE task_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'draft',
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    context_summary TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '[]',
    working_dir TEXT,
    working_dir_confidence TEXT NOT NULL DEFAULT 'unknown',
    agent TEXT,
    risk_level TEXT NOT NULL DEFAULT 'normal',
    needs_confirmation INTEGER NOT NULL DEFAULT 1,
    source_channel TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    source_metadata TEXT NOT NULL DEFAULT '{}',
    created_task_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT
);
```

### 7.2 `im_runbooks`

```sql
CREATE TABLE im_runbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL, -- builtin | template | skill
    source_id TEXT,
    command_schema TEXT NOT NULL DEFAULT '{}',
    prompt_template TEXT NOT NULL,
    default_agent TEXT,
    confirmation_policy TEXT NOT NULL DEFAULT 'auto',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

### 7.3 `im_delivery_refs`

Persist channel/thread mappings that are currently held partly in memory by channel adapters.

```sql
CREATE TABLE im_delivery_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    brief_id INTEGER,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_id TEXT,
    message_id TEXT,
    recipient_id TEXT,
    purpose TEXT NOT NULL, -- origin | brief | notification | digest | skill_suggestion
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

This makes IM follow-up behavior more durable across backend restarts.

## 8. API Surface

### 8.1 Task Briefs

```text
GET    /api/task-briefs
GET    /api/task-briefs/:id
POST   /api/task-briefs
PATCH  /api/task-briefs/:id
POST   /api/task-briefs/:id/confirm
POST   /api/task-briefs/:id/discard
```

`POST /api/task-briefs/:id/confirm` creates the real task and returns `{ task_id }`.

### 8.2 Runbooks

```text
GET    /api/im-runbooks
POST   /api/im-runbooks
PATCH  /api/im-runbooks/:id
DELETE /api/im-runbooks/:id
POST   /api/im-runbooks/:name/preview
POST   /api/im-runbooks/:name/run
```

`preview` returns a `TaskBrief` without creating a task. `run` either creates a brief or a task depending on confirmation policy.

### 8.3 Digests

```text
POST /api/im-digests/preview
POST /api/im-digests/send
```

The preview endpoint helps the desktop UI show what the next digest would contain.

## 9. Message Routing

### 9.1 New MessageBus Inbound Types

```text
CREATE_BRIEF
CONFIRM_BRIEF
DISCARD_BRIEF
RUN_RUNBOOK
PREVIEW_RUNBOOK
TRIGGER_DIGEST
SKILL_SUGGESTION_ACTION
```

These actions should complement existing `CREATE_TASK`, `RESUME_TASK`, `RESPOND_TASK`, `CANCEL_TASK`, and `STATUS_QUERY`.

### 9.2 Routing Priority

When an inbound IM message arrives:

1. If it is a reply inside an active task thread, route to existing resume/respond behavior.
2. If it is a known runbook command, route to RunbookRegistry.
3. If it is a brief action such as `run`, `discard`, or `edit`, apply it to the active brief.
4. If it is a skill suggestion action, route to Skill Library.
5. Otherwise, run Chat-to-Task classification.
6. If classification is high-confidence and safe, create a task.
7. If classification is ambiguous, create a task brief.

This preserves current reply-to-resume behavior and avoids breaking the fastest path.

## 10. Classification and Extraction

### 10.1 Classifier Output

The classifier should return structured JSON:

```json
{
  "intent": "new_task",
  "confidence": "medium",
  "should_create_brief": true,
  "reason": "Forwarded context with unclear target repository.",
  "brief": {
    "title": "...",
    "goal": "...",
    "context_summary": "...",
    "acceptance_criteria": ["..."],
    "working_dir": null,
    "working_dir_confidence": "unknown",
    "agent": "codex",
    "risk_level": "normal"
  }
}
```

Supported intents:

```text
new_task
resume_task
runbook
status_query
cancel_task
digest_request
skill_action
ignore
```

### 10.2 Cost Control

Classification should be rule-first, agent-second:

- Slash commands and simple replies do not need an agent call.
- Explicit `/new`, `/dir`, `/agent`, `/status`, `/cancel`, and `/resume` keep current deterministic handling.
- Forwarded messages, images, long text, and unclear repo references may call the configured classification agent.
- The classifier should have a small context window and should not read task output history unless explicitly summarizing a thread.

## 11. Error Handling

- If classification fails, fall back to current behavior only for simple text. For complex forwarded or media input, ask the user to retry or clarify.
- If a brief expires, future `run` replies should say the draft expired and offer to regenerate it.
- If a runbook argument is invalid, return usage examples rather than creating a malformed task.
- If digest generation fails, log the failure and send no partial digest unless the user manually requested one.
- If an IM send fails, task state must not change.
- If a channel does not support cards/buttons, all actions must remain possible through text replies.

## 12. Privacy and Safety

- IM content is already entering AgentForge through user-configured channels. This feature must not introduce any new remote service beyond the configured channel APIs and selected local/CLI agent.
- Store source metadata needed for traceability, but do not duplicate large raw attachments in new tables when existing media handling already stores them.
- Confirmation is required before:
  - installing skills,
  - broad or destructive repo changes,
  - running unclear forwarded requests,
  - sending scheduled digests to a newly configured recipient.
- Digest content should avoid dumping large code/output blocks. It should summarize and link back to task IDs.

## 13. Rollout Plan

### Phase 1: Chat-to-Task Briefs

- Add `TaskBrief` model and APIs.
- Add deterministic brief confirmation/discard flow.
- Support text fallback in all channels.
- Preserve current immediate task creation for simple messages.

### Phase 2: IM Runbooks

- Add shared RunbookRegistry.
- Ship built-in runbooks for PR review, CI fix, thread summary, test writing, release check, and skill scan.
- Add text command support across Feishu, Slack, Telegram, and WeChat.
- Connect user templates as runbook sources after the core path works.

### Phase 3: Digests

- Add digest preview and scheduled daily standup.
- Reuse heartbeat/scheduler timing.
- Batch attention-needed notifications.
- Add settings in the desktop app.

### Phase 4: Skill Suggestions

- Send IM suggestions for Skill Library candidates.
- Support draft generation and dismissal from IM.
- Allow final approval from IM only after the draft content is visible or linked.

## 14. Testing

### Backend unit tests

- Task brief creation, edit, confirm, discard, expiry.
- Runbook command parsing and argument validation.
- Routing priority between task replies, runbooks, brief actions, and new task classification.
- Digest grouping and quiet behavior when there is no useful content.
- Skill suggestion action handling.

### Channel tests

- Feishu, Slack, Telegram, and WeChat text fallback for brief confirmation.
- Thread/chat mapping persists through `im_delivery_refs`.
- Existing reply-to-resume behavior still wins over new task classification.
- Failed sends do not mutate task or brief state.

### Integration tests

- Forwarded message creates a brief, user replies `run`, scheduler receives a task.
- `/review-pr <url>` previews or creates the expected task.
- Daily digest summarizes completed, failed, and waiting tasks without including idle heartbeat ticks.
- Skill candidate emits a suggestion and `dismiss` prevents repeated suggestions.

## 15. Success Criteria

The feature is successful if:

- Users can forward messy IM context and get a clear task brief instead of hand-writing prompts.
- Users can run common workflows from IM without opening the desktop app.
- Digests increase awareness without increasing notification noise.
- Skill Library suggestions become visible and actionable at the moment repeated work is fresh.
- Existing channel behavior for simple task creation and reply-to-resume remains intact.

## 16. Explicit Non-Goals

- No team workspace, shared assignment model, or multi-user permission system.
- No new public network listener.
- No requirement to build rich cards before text fallback works.
- No generic chatbot persona.
- No automatic skill installation without explicit user approval.
- No replacement of the desktop app's task board or settings UI.

## 17. Open Design Decisions

These decisions are intentionally narrowed to implementation-time choices, not unresolved product scope:

| Decision | Recommended default |
|---|---|
| First rich channel | Feishu, because existing card and streaming support is strongest. |
| Brief expiration | 7 days for draft briefs. |
| Classifier agent | Use the current default agent unless a dedicated setting is added. |
| Direct-create threshold | Only direct-create when text is short, action is clear, and working directory confidence is high. |
| Digest default | Opt-in scheduled digest; attention-needed messages only for tasks created from that channel. |

## 18. Self-Review

- No implementation is required by this spec before user approval.
- The scope is decomposed into four phases and can be implemented incrementally.
- The design keeps AgentForge local-first and single-user.
- Existing reply-to-resume behavior is preserved as the highest-priority route.
- Every rich IM interaction has a text fallback.
- Skill installation remains approval-gated.
