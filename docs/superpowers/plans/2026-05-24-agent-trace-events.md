# Agent Trace Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show intermediate tool calls and tool results for Claude and Codex task runs in stored events, Feishu streaming cards, and the desktop task detail view.

**Architecture:** Add a small normalization layer inside `TaskScheduler` that converts provider-specific stream JSON into stable display event types (`assistant`, `tool_call`, `tool_result`, `command_execution`, `file_change`, `web_search`, `error`, `result`). Keep the existing `task_output_events` schema and encode structured event details as JSON strings where useful, so existing data and API routes remain compatible. Let Feishu and the renderer format those stable event types rather than parsing raw provider payloads.

**Tech Stack:** Python `BaseHTTPRequestHandler` backend, SQLite event storage, pytest, React/Vite renderer, Feishu interactive card JSON.

---

### Task 1: Backend Trace Normalization

**Files:**
- Modify: `taskboard.py`
- Modify: `tests/test_claude_streaming_events.py`
- Modify: `tests/test_codex_streaming_events.py`

- [x] **Step 1: Write failing Claude tests**

Add tests asserting that Claude `assistant.message.content` blocks with `tool_use` and `tool_result` are stored as `tool_call` and `tool_result`, with JSON content containing stable fields like `name`, `input`, `tool_use_id`, `content`, and `is_error`.

- [x] **Step 2: Write failing Codex tests**

Add tests asserting that Codex `command_execution`, `mcp_tool_call`, `web_search`, and `file_change` items normalize into stable event types, are stored, and are fired to listeners for live streaming.

- [x] **Step 3: Run targeted tests and confirm RED**

Run `uv run pytest -q tests/test_claude_streaming_events.py tests/test_codex_streaming_events.py`. Expected: new tests fail because the normalization and live listener behavior do not exist yet.

- [x] **Step 4: Implement normalization helpers**

Add private helpers on `TaskScheduler` to format JSON payloads consistently and redact obvious secret-looking keys from tool arguments/results before display storage.

- [x] **Step 5: Wire live listener events**

Update `_parse_and_store_event()` so display-worthy trace event types are stored and passed to `_fire_output_listeners()`, not only `assistant`.

- [x] **Step 6: Run targeted tests and confirm GREEN**

Run the same targeted pytest command. Expected: all targeted tests pass.

### Task 2: Feishu Execution Process Rendering

**Files:**
- Modify: `channels/feishu_channel.py`
- Modify: `tests/test_feishu_message_rendering.py`

- [x] **Step 1: Write failing Feishu writer tests**

Add tests asserting `_FeishuStreamWriter` appends `tool_call`, `tool_result`, and `command_execution` events into the streaming history snapshot, and still ignores unrelated tasks.

- [x] **Step 2: Run focused Feishu tests and confirm RED**

Run `uv run pytest -q tests/test_feishu_message_rendering.py`. Expected: new tests fail because the writer filters non-assistant events.

- [x] **Step 3: Implement trace display formatting**

Update `_FeishuStreamWriter` to accept trace event types, render each as compact plain text lines, keep assistant/thinking behavior unchanged, and rename the panel header from `思考过程` to `执行过程`.

- [x] **Step 4: Run focused Feishu tests and confirm GREEN**

Run the focused Feishu tests. Expected: all Feishu rendering tests pass.

### Task 3: Desktop Renderer Event Formatting

**Files:**
- Modify: `taskboard-electron/src/renderer/App.jsx`

- [x] **Step 1: Update event content rendering**

Teach `EventContent` to pretty-print JSON payloads for `tool_call`, `tool_result`, `command_execution`, `file_change`, and `web_search` while falling back to plain text for older rows.

- [x] **Step 2: Update event colors and labels**

Extend `getEventTypeColor()` and labels in the Output Events view so new trace event types are easy to scan.

- [x] **Step 3: Run renderer build**

Run `cd taskboard-electron && npx vite build --config vite.renderer.config.mjs`. Expected: build succeeds.

### Task 4: Full Verification

**Files:**
- Modify: `docs/todo.md`

- [x] **Step 1: Run backend check**

Run `make check`. Expected: lint, format check, and pytest pass.

- [x] **Step 2: Run renderer build**

Run `cd taskboard-electron && npx vite build --config vite.renderer.config.mjs`. Expected: build succeeds.

- [x] **Step 3: Update todo**

Mark the implementation todo item complete only after the verification commands pass.
