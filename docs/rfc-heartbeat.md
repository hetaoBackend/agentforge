# RFC: Heartbeat Triggers in AgentForge

**Status:** Draft
**Date:** 2026-03-18
**Author:** Codex

---

## Summary

Introduce a new `heartbeat` resource in AgentForge for low-noise, periodic "check before acting" automation.

Unlike an existing cron task, a heartbeat does not directly execute a full agent run every time it wakes up. Instead, it performs a lightweight decision step first. Only when that decision says there is actionable work does AgentForge create or resume a real task.

This RFC proposes:

- a dedicated heartbeat model separate from `tasks`
- silent idle behavior by default
- structured decision output instead of token or keyword matching
- explicit deduplication and cooldown semantics
- a small first version that coexists cleanly with the current scheduler

---

## Motivation

AgentForge already supports `immediate`, `delayed`, `scheduled_at`, and `cron` tasks. Those schedules answer one question well: "when should this task run?"

They do not answer a different question: "when should the system check whether a task is worth creating at all?"

Today, if a user wants "every 10 minutes, check whether my repo needs review; if yes, create a review task," the closest fit is a cron task. That works, but it has undesirable behavior:

- every wake-up becomes a real task run
- empty checks pollute task history and output history
- idle cycles create noise in channels and UI
- deduplication has to be reimplemented in prompt logic

Heartbeat addresses this gap by introducing a higher-level trigger primitive:

- `cron task`: execute on schedule
- `heartbeat`: inspect on schedule, then decide whether to execute

This design is inspired by the recent heartbeat redesign in `HKUDS/nanobot`, whose release notes describe moving from fragile token detection to a virtual decision mechanism and making heartbeat truly silent when idle.

References:

- [HKUDS/nanobot](https://github.com/HKUDS/nanobot)
- [nanobot v0.1.4.post2 release notes](https://newreleases.io/project/github/HKUDS/nanobot/release/v0.1.4.post2)

---

## Goals

- Provide a first-class abstraction for periodic inspection that does not always create a task.
- Keep idle heartbeat cycles invisible to the main kanban flow by default.
- Reuse the existing AgentForge scheduler, task execution, and MessageBus architecture.
- Make trigger decisions structured, testable, and debuggable.
- Prevent repeated wake-ups from creating duplicate tasks for the same signal.

---

## Non-Goals

- Replace the existing cron scheduling system.
- Replace `/api/health` or any process liveness check.
- Build a general-purpose workflow engine in v1.
- Add complex multi-step self-orchestration inside heartbeat itself.
- Expose every idle tick as a full task or full run.

---

## Background

AgentForge's current scheduler is task-centric. A task is persisted in SQLite, moved through statuses such as `pending`, `scheduled`, `running`, `completed`, and `failed`, and accumulates task runs plus output events.

That model is correct for real executions, but it is too heavy for a "watcher" abstraction. A watcher needs a lightweight place to store:

- when it last checked
- what it decided
- why it stayed idle
- which signal it already triggered on

If heartbeat is modeled as a normal cron task, AgentForge loses the ability to distinguish:

- "I checked and nothing needed to happen"
- "I executed real work"

That distinction is the main reason heartbeat should be a separate concept.

---

## Terminology

### Heartbeat

A persistent configuration that describes:

- when to wake up
- what to inspect
- how to decide whether work is needed
- what action to take if the decision is positive

### Tick

A single execution of a heartbeat's periodic check.

### Decision

The structured output of a tick, describing whether the heartbeat stayed idle, created work, resumed work, notified a user, or failed.

### Action

The concrete side effect taken after a non-idle decision, such as creating a task.

---

## Cron vs Heartbeat

The distinction is central to this RFC.

### Cron task

A cron task is a real task whose schedule happens to be recurring.

Properties:

- wakes up on schedule
- always executes real agent work
- always creates a task run
- always writes output history
- always participates in normal task lifecycle

It answers:

- "When should this task run again?"

### Heartbeat

A heartbeat is a trigger resource that may or may not produce a task.

Properties:

- wakes up on schedule
- performs a decision step first
- only creates or resumes a real task when needed
- stays silent when idle
- tracks trigger-level history separately from task history

It answers:

- "When should the system check whether there is work worth creating?"

### Practical example

Requirement:

"Every 10 minutes, check whether there are new commits in this repo that have not been reviewed. If yes, create a review task. If not, do nothing."

With cron:

- a real task runs every 10 minutes
- most runs may be empty
- the board fills with no-op history

With heartbeat:

- the heartbeat ticks every 10 minutes
- idle ticks remain internal
- only meaningful changes create real tasks

---

## Design Principles

### 1. Silent When Idle

An idle heartbeat should not create a task, a run, or user-facing notification by default.

It may still update internal metadata such as:

- `last_tick_at`
- `last_decision`
- `last_error`

### 2. Decision Before Action

Heartbeat exists to separate "inspection" from "execution." The system must never assume that a scheduled wake-up implies real work.

### 3. Structured Over Heuristic

Decision output must be structured JSON, not a magic token such as `HEARTBEAT_OK` and not regex matching over free-form text.

This makes behavior:

- explicit
- testable
- less fragile

### 4. Low-Noise Observability

Heartbeat must remain debuggable without polluting the main task board.

### 5. Reuse Existing Execution Paths

Once a heartbeat decides that real work is needed, it should hand off to the existing task pipeline rather than inventing a second task execution system.

### 6. State Lives in Storage, Not Session

Heartbeat is primarily a trigger mechanism, not a long-running conversation.

Its persistent state should therefore live in AgentForge's own storage layer, not in an ever-growing model session. The system should remember heartbeat progress through explicit fields such as:

- `last_tick_at`
- `last_decision`
- `last_triggered_at`
- `last_dedupe_key`
- tick history

This keeps heartbeat behavior deterministic, debuggable, and inexpensive over long periods of time.

---

## Proposed Model

### New resource type: `heartbeat`

Heartbeat is a first-class resource, persisted separately from `tasks`.

Each heartbeat contains:

- identity and status
- schedule
- check definition
- action template
- deduplication metadata
- last known results

### Decision types

The decision layer should support this enum:

- `idle`
- `trigger_task`
- `resume_task`
- `notify_only`
- `error`

For v1, AgentForge only needs to implement:

- `idle`
- `trigger_task`
- `error`

The others can be reserved for future expansion.

### Session strategy

Heartbeat should support a session policy, but the default must be stateless.

Recommended model:

- `stateless`: every decision tick runs in a fresh session
- `sticky`: future option for specialized long-running heartbeat patterns

V1 recommendation:

- implement heartbeat decision ticks as `stateless` only

Rationale:

- avoids unbounded context growth
- avoids stale or polluted decision context
- keeps trigger behavior reproducible
- ensures deduplication depends on explicit database state rather than hidden model memory

Important distinction:

- heartbeat decision state belongs in heartbeat tables
- task execution state may still use normal task `session_id` / resume behavior after a heartbeat creates a real task

---

## Data Model

### `heartbeats`

Suggested columns:

```text
id INTEGER PRIMARY KEY
name TEXT NOT NULL
enabled INTEGER NOT NULL DEFAULT 1
working_dir TEXT NOT NULL
schedule_type TEXT NOT NULL            -- 'cron' | 'interval'
cron_expr TEXT
interval_seconds INTEGER
check_prompt TEXT NOT NULL
action_prompt_template TEXT
default_agent TEXT DEFAULT 'claude'
cooldown_seconds INTEGER DEFAULT 0
last_tick_at TEXT
last_decision TEXT
last_error TEXT
last_triggered_at TEXT
last_dedupe_key TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Notes:

- `schedule_type` is intentionally narrower than tasks in v1.
- `action_prompt_template` is only used if the decision says to create a task.
- `last_dedupe_key` is a convenience field for quick visibility, not the source of truth.

### `heartbeat_ticks`

Suggested columns:

```text
id INTEGER PRIMARY KEY
heartbeat_id INTEGER NOT NULL
started_at TEXT NOT NULL
finished_at TEXT
status TEXT NOT NULL                   -- 'idle' | 'triggered' | 'error'
decision_type TEXT
decision_payload TEXT
task_id INTEGER
error TEXT
FOREIGN KEY (heartbeat_id) REFERENCES heartbeats(id)
FOREIGN KEY (task_id) REFERENCES tasks(id)
```

Purpose:

- preserve lightweight audit history
- keep heartbeat history separate from task runs
- support UI inspection and debugging

### Optional `heartbeat_dedup`

This table is optional in v1, but likely useful:

```text
id INTEGER PRIMARY KEY
heartbeat_id INTEGER NOT NULL
dedupe_key TEXT NOT NULL
task_id INTEGER
triggered_at TEXT NOT NULL
UNIQUE(heartbeat_id, dedupe_key)
```

This makes cooldown and repeated-trigger suppression easier to implement correctly.

---

## Decision Contract

Heartbeat decisions should be returned as JSON.

### Idle example

```json
{
  "decision": "idle",
  "reason": "No actionable change detected",
  "dedupe_key": "repo:/Users/me/project:head:abc123",
  "title": "",
  "prompt": "",
  "metadata": {}
}
```

### Trigger example

```json
{
  "decision": "trigger_task",
  "reason": "Found 3 changed files since last reviewed commit",
  "dedupe_key": "repo:/Users/me/project:review:abc123",
  "title": "Review latest changes in project",
  "prompt": "Review the latest changes since commit abc123 and summarize risks, regressions, and missing tests.",
  "metadata": {
    "source": "heartbeat",
    "heartbeat_id": 12
  }
}
```

### Error example

```json
{
  "decision": "error",
  "reason": "Git command failed: repository not found",
  "dedupe_key": "",
  "title": "",
  "prompt": "",
  "metadata": {}
}
```

### Required fields

- `decision`
- `reason`
- `dedupe_key`
- `title`
- `prompt`
- `metadata`

### Why structured output matters

This avoids several classes of failure:

- ambiguous free-form outputs
- accidental token collisions
- brittle string matching in multiple languages
- hidden prompt regressions when model behavior changes

---

## Scheduler Behavior

Heartbeat should run alongside the current task scheduler, but not as a normal task.

### Tick lifecycle

1. Scheduler finds due heartbeats.
2. For each due heartbeat, AgentForge creates a `heartbeat_tick` record.
3. The heartbeat executes a decision step.
4. AgentForge parses and validates the decision JSON.
5. The system checks cooldown and dedupe constraints.
6. If the decision is `idle`, mark the tick idle and update heartbeat metadata.
7. If the decision is `trigger_task`, create a real task through the existing task submission path.
8. Mark the tick as `triggered` and associate it with the created task.
9. If any step fails, mark the tick as `error`.

### Session behavior during a tick

For v1, the decision step of a heartbeat tick should always execute in a fresh session.

That means:

- no heartbeat-level `session_id` is persisted or resumed
- decision consistency relies on persisted heartbeat metadata and tick history
- if a tick triggers a real task, that task may then use its own normal session semantics

This preserves a clean separation:

- heartbeat checks for work
- tasks carry conversational or execution continuity

### Concurrency

As with tasks, a heartbeat should not have overlapping active ticks unless explicitly enabled in the future.

V1 rule:

- one active tick per heartbeat at a time

### Failure behavior

A failed heartbeat tick should not automatically create a failed task. It should remain a heartbeat-level error unless a future policy says otherwise.

---

## Deduplication and Cooldown

Heartbeat needs explicit trigger suppression. This is one of the biggest differences from cron.

### Definitions

- `dedupe_key`: identity of the external signal that triggered action
- `cooldown_seconds`: minimum time before the same signal may trigger again

### Rules

If a decision returns `trigger_task`, AgentForge should suppress that trigger when:

- the same `heartbeat_id + dedupe_key` was already triggered inside cooldown
- the previously created task for that `dedupe_key` is still `pending`, `scheduled`, `blocked`, or `running`

### Result

The heartbeat may still record the tick, but the action is downgraded to `idle` with a reason such as:

- "Suppressed duplicate signal during cooldown"

---

## Action Dispatch

When a heartbeat decides to act, it should dispatch through existing code paths.

### `trigger_task`

Use the normal task creation path with metadata that records heartbeat provenance.

Suggested metadata fields:

- `source = "heartbeat"`
- `heartbeat_id`
- `heartbeat_tick_id`
- `dedupe_key`

This preserves a clean boundary:

- heartbeat decides
- task system executes

### `resume_task`

Reserved for future versions. The likely use case is reviving a waiting conversational task when a heartbeat detects new context.

### `notify_only`

Reserved for future versions. This would route through MessageBus without creating a task.

---

## API Proposal

Suggested endpoints:

- `GET /api/heartbeats`
- `POST /api/heartbeats`
- `GET /api/heartbeats/{id}`
- `PUT /api/heartbeats/{id}`
- `DELETE /api/heartbeats/{id}`
- `POST /api/heartbeats/{id}/run-now`
- `POST /api/heartbeats/{id}/pause`
- `POST /api/heartbeats/{id}/resume`
- `GET /api/heartbeats/{id}/ticks`

### Example create payload

```json
{
  "name": "Repo review watcher",
  "working_dir": "~/projects/myapp",
  "schedule_type": "interval",
  "interval_seconds": 600,
  "check_prompt": "Check whether there are new commits since the last reviewed commit. Return heartbeat decision JSON only.",
  "action_prompt_template": "Review the latest code changes and summarize bugs, regressions, and missing tests.",
  "default_agent": "claude",
  "cooldown_seconds": 1800,
  "enabled": true
}
```

### Example response

```json
{
  "id": 12,
  "name": "Repo review watcher",
  "enabled": true,
  "schedule_type": "interval",
  "interval_seconds": 600,
  "last_tick_at": "2026-03-18T10:30:00",
  "last_decision": "idle",
  "last_triggered_at": "2026-03-18T09:40:00"
}
```

---

## UI Proposal

Heartbeat should not be rendered as ordinary cards in the existing Queue / Running / Done columns.

Suggested UI treatment:

- a dedicated `Heartbeats` tab or panel
- compact list view rather than kanban
- one row per heartbeat

Suggested columns:

- name
- enabled / paused
- schedule
- next tick
- last decision
- last triggered task
- last error

Suggested actions:

- run now
- pause / resume
- edit
- view recent ticks

### Tick inspection

The heartbeat detail view should show recent ticks with:

- time
- decision
- reason
- dedupe key
- linked task, if any
- error, if any

Idle ticks should be visible in heartbeat details, but not in the main task board by default.

---

## Observability

Heartbeat should be observable without becoming noisy.

### Internal visibility

Store:

- last tick time
- last decision
- last trigger time
- last error
- recent ticks

### Logging

Recommended log levels:

- `debug`: decision payloads, suppressed duplicates
- `info`: actual task-triggering events
- `warning`: malformed decisions, repeated scheduler anomalies
- `error`: execution failures

### Notifications

By default:

- idle heartbeat ticks do not notify users
- triggered tasks behave like normal tasks and may notify via existing channels

---

## Security and Safety Considerations

Heartbeat introduces recurring automated inspection and therefore deserves guardrails.

### Prompt safety

Heartbeat decision prompts should be constrained to return JSON only.

### Working directory safety

Heartbeat should reuse the same working directory safety assumptions already enforced for normal task execution.

### Runaway automation

Cooldown and dedupe exist partly as correctness features, but also as safety features to avoid accidental flood behavior.

### User visibility

Because heartbeat may create tasks on its own, the UI should always show:

- what heartbeat created the task
- why it triggered

---

## Alternatives Considered

### 1. Use cron tasks only

Rejected because it conflates "check" with "execute" and creates excessive no-op runs.

### 2. Add a boolean flag to cron tasks, such as `silent_if_noop`

Rejected because it still overloads the task abstraction. The system would have to infer or special-case whether a task actually "did nothing," which is much less explicit than a dedicated heartbeat resource.

### 3. Parse a magic token from free-form output

Rejected because it is fragile, hard to validate, and too easy to regress as prompts evolve.

### 4. Emit every heartbeat tick as a task card

Rejected because it undermines the entire goal of low-noise monitoring.

---

## Rollout Plan

### Phase 1: Minimal viable heartbeat

Scope:

- heartbeat CRUD
- schedule types: `cron` and `interval`
- decision types: `idle`, `trigger_task`, `error`
- tick history
- dedupe and cooldown
- basic UI list and tick inspection

No support yet for:

- `resume_task`
- `notify_only`
- custom tool APIs for decision logic
- channel-specific routing policies

### Phase 2: Richer actions

Potential additions:

- resume existing task
- direct channel notifications
- richer per-heartbeat policies
- heartbeat-specific templates for common watcher types

### Phase 3: Advanced policies

Potential additions:

- backlog thresholds
- max tasks per day
- dependency-aware heartbeats
- per-channel or per-user routing

---

## Open Questions

1. Should idle ticks be persisted indefinitely, or should AgentForge retain only the last N ticks per heartbeat?
2. Should heartbeat creation be limited to the desktop UI first, or should chat channels be allowed to create them too?
3. Should `trigger_task` create a brand-new task every time, or optionally update/reuse an existing open task for the same dedupe key?
4. Should v1 expose only stateless heartbeat decisions, or should a sticky-session mode be designed now but left unimplemented?
5. Should heartbeat-created tasks be visually marked in the main board, for example with a `heartbeat` badge?

---

## Recommendation

Implement heartbeat as a separate first-class resource rather than as a modified cron task.

This keeps the mental model clean:

- tasks represent real work
- cron defines when real work runs
- heartbeat defines when the system checks whether real work should exist

That separation makes AgentForge better suited for proactive automation without turning the board into a history of empty checks.
