# RFC: Codex CLI Support in AgentForge

**Status:** Implemented
**Date:** 2026-03-16
**Updated:** 2026-03-17
**Author:** hetao

---

## Summary

Add OpenAI Codex CLI (`codex`) as a selectable agent backend alongside the existing Claude Code CLI (`claude`). Users can choose `codex` per-task or as a global default.

---

## Motivation

AgentForge currently hard-codes the `claude` CLI in every execution path. The `agent` field already exists on the `tasks` table (defaulting to `"claude"`) but is never actually branched on. Adding Codex CLI support completes this abstraction, letting teams that prefer OpenAI models use the same orchestration layer.

---

## Codex CLI Overview

[Codex CLI](https://github.com/openai/codex) is OpenAI's terminal coding agent, built in Rust. Latest stable: `rust-v0.115.0`.

### Installation

```bash
npm install -g @openai/codex
# or
brew install --cask codex
```

### Non-interactive execution

```bash
# Basic execution
codex exec "your task prompt here"

# With JSONL streaming (machine-readable output)
codex exec --json "your task prompt here"

# With working directory
codex exec --json --cd /path/to/project "your task"

# Full automation (no approval prompts)
codex exec --json --ask-for-approval never "your task"

# Session resume (thread_id from thread.started event)
codex exec resume --json --ask-for-approval never <THREAD_ID> "follow-up prompt"
codex exec resume --last --json "follow-up prompt"
```

### Output behaviour

| Stream | Content |
|--------|---------|
| `stdout` | Final agent message (plain text) by default; JSONL events when `--json` is passed |
| `stderr` | Progress/status messages (always, regardless of `--json`) |

### JSONL event schema (`--json` mode)

Each line is a JSON object. Key top-level event types:

| Type | Schema | Notes |
|------|--------|-------|
| `thread.started` | `{ type, thread_id: string }` | Session started; use `thread_id` for resume |
| `turn.started` | `{ type }` | Agent began a reasoning turn |
| `turn.completed` | `{ type, usage: { input_tokens, cached_input_tokens, output_tokens } }` | Token usage only, no message |
| `turn.failed` | `{ type, error: { message: string } }` | Turn failed; error is a nested object |
| `item.started` | `{ type, item: ThreadItem }` | Item work began |
| `item.updated` | `{ type, item: ThreadItem }` | Partial update (streaming) |
| `item.completed` | `{ type, item: ThreadItem }` | Item finished |
| `error` | `{ type, message: string }` | Top-level error |

Key `ThreadItem` types (discriminated by `item.type`):

| `item.type` | Key fields | Maps to |
|-------------|-----------|---------|
| `agent_message` | `text: string` | Agent text output (→ `assistant` event) |
| `reasoning` | `text: string` | Chain-of-thought (→ `assistant` with `[thinking]` prefix) |
| `command_execution` | `command: string`, `aggregated_output: string`, `exit_code: int?`, `status` | Shell command |
| `file_change` | `changes: [{path, kind}]`, `status` | File write/edit |
| `mcp_tool_call` | `server`, `tool`, `arguments`, `result?`, `error?`, `status` | MCP tool |
| `web_search` | `id`, `query`, `action` | Web search |
| `todo_list` | `items: [{text, completed}]` | Planning steps |
| `error` | `message: string` | Item-level error |

> **Note:** Items go through `started` → zero or more `updated` → `completed`. Parsers must handle all three; only `completed` is used for storage.

### Approval mode

`--ask-for-approval never` (default for `codex exec`) is the non-interactive equivalent of Claude's `--permission-mode bypassPermissions`.

Other values: `untrusted`, `on-request`.

### Authentication

Requires `CODEX_API_KEY` or `OPENAI_API_KEY` environment variable.

### Exit codes

- `0` — success
- `1` — any failure (auth error, exec policy, fatal turn error, etc.)

### Sandbox flag (optional)

`--sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`. If omitted, no sandbox is applied.

### Git repo requirement

Codex requires a Git repository by default. Pass `--skip-git-repo-check` to allow execution outside a Git repo.

### Limitations vs Claude CLI

| Feature | Codex CLI | Claude CLI |
|---------|-----------|-----------|
| Output format flag | `--json` | `--output-format stream-json --verbose` |
| Agent text event | `item.completed` + `item.type == "agent_message"`, field `text` | `type == "assistant"`, nested content |
| Session ID field | `thread.started.thread_id` | `result.session_id` |
| Session resume | `codex exec resume <THREAD_ID>` | `--resume <SESSION_ID>` inline |
| Working dir | `--cd` | No equivalent flag |
| Approval mode flag | `--ask-for-approval` | `--permission-mode` |
| Final message location | Last `agent_message` item | `result` event |
| Token usage | `turn.completed.usage` | `result` event |
| Git repo check | Required by default | No requirement |
| Auth env var | `CODEX_API_KEY` / `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` |

---

## Design

### Principle

Keep the per-agent logic entirely in `TaskScheduler._execute_task`. Introduce a private helper `_parse_codex_event` alongside the existing Claude parsing logic. Event normalization handles the schema differences transparently.

### No new abstraction layer

An `AgentBackend` base class would be over-engineered for two agents. The branching is contained in three methods:

1. `_execute_task` — command construction and result extraction
2. `_parse_codex_event` — JSONL → internal event schema normalization
3. `_parse_and_store_event` — routes to the appropriate parser

---

## Implementation

### Backend — `taskboard.py`

#### Command construction

```python
agent = task.get("agent", "claude")

if agent == "codex":
    working_dir_expanded = os.path.expanduser(task["working_dir"])
    if task.get("session_id"):
        cmd = [
            "codex", "exec", "resume",
            "--json",
            "--ask-for-approval", "never",
            task["session_id"],
            prompt,
        ]
    else:
        cmd = [
            "codex", "exec",
            "--json",
            "--ask-for-approval", "never",
            "--cd", working_dir_expanded,
            prompt,
        ]
    for img_path in image_paths or []:
        cmd.extend(["--image", img_path])
```

#### JSONL normalization (`_parse_codex_event`)

```python
def _parse_codex_event(self, event: dict) -> tuple:
    etype = event.get("type", "")
    if etype == "item.completed":
        item = event.get("item", {})
        itype = item.get("type", "")
        if itype == "agent_message":
            return "assistant", item.get("text", "")
        elif itype == "reasoning":
            text = item.get("text", "")
            return ("assistant", f"[thinking] {text}") if text else (None, None)
        elif itype == "command_execution":
            cmd = item.get("command", "")
            out = item.get("aggregated_output", "")
            return etype, f"$ {cmd}\n{out}".strip()
        else:
            return etype, json.dumps(event, ensure_ascii=False)
    elif etype == "turn.failed":
        err = event.get("error", {})
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        return "error", msg
    elif etype == "error":
        return "error", event.get("message", "")
    elif etype == "turn.completed":
        # turn.completed only carries usage stats; skip it
        return None, None
    elif etype in ("thread.started", "turn.started", "item.started", "item.updated"):
        return None, None
    else:
        return etype, json.dumps(event, ensure_ascii=False)
```

#### Session ID extraction

```python
# Codex emits thread_id in the thread.started event
if event.get("type") == "thread.started" and event.get("thread_id"):
    extracted_session_id = event["thread_id"]
```

> **Key difference from original RFC:** The field is `thread_id`, not `session_id`. The `thread.started` event does not have a `session_id` field.

#### Final output extraction

```python
# Codex: final output is the last agent_message item text
out = ""
for line in raw_stdout.splitlines():
    try:
        event = json.loads(line.strip())
        if (event.get("type") == "item.completed"
                and event.get("item", {}).get("type") == "agent_message"):
            out = event["item"].get("text", "")
    except json.JSONDecodeError:
        pass
success, output = True, out or raw_stdout
```

> **Key difference from original RFC:** The final message is NOT in `turn.completed.message` (that field does not exist). It comes from the last `agent_message` item.

### Frontend — `App.jsx`

#### Agent selector in task creation form

```jsx
<select name="agent" value={form.agent} onChange={handleChange}>
  <option value="claude">Claude (claude CLI)</option>
  <option value="codex">Codex (OpenAI codex CLI)</option>
</select>
```

#### Settings panel

`codex` added to the default agent dropdown alongside `claude`.

#### Output rendering

No changes needed. The `FormattedOutput` component already handles `assistant`, `result`, and `error` event types.

---

## Data Flow (Codex path)

```
User creates task (agent="codex")
        │
        ▼
POST /api/tasks  →  tasks.agent = "codex"
        │
        ▼
TaskScheduler._execute_task()
  cmd = ["codex", "exec", "--json", "--ask-for-approval", "never", "--cd", ..., prompt]
  subprocess.Popen(cmd, stdout=PIPE, stderr=PIPE, start_new_session=True)
        │
        ├── stdout (JSONL) → _parse_codex_event() → db.add_output_event()
        └── stderr (progress) → discarded
        │
        ▼
  turn.completed → (usage stats only)
  turn.failed    → success=False, output=error.message
  last agent_message item → success=True, output=item.text
        │
        ▼
  thread_id extracted from thread.started event
  task.status → completed / failed
```

---

## Open Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Does `codex exec` exit 0 reliably on success? | Confirmed: exit 0 on success, exit 1 on any error |
| 2 | Are `--image` paths passed inline to resume? | Supported: `-i` flag works on both `exec` and `exec resume` |
| 3 | Does Codex spawn sub-agents? | Yes: `collab_tool_call` item type with `spawn_agent` tool |
| 4 | Is there a `--timeout` flag? | No native flag; caller must kill the process |
| 5 | Git repo required? | Yes by default; `--skip-git-repo-check` to bypass |

---

## Acceptance Criteria

- [x] Task with `agent: "codex"` executes via `codex exec --json ...` in `working_dir`
- [x] Live output displayed in kanban board output panel during execution
- [x] Task status transitions correctly: pending → running → completed / failed
- [x] `thread_id` extracted from `thread.started` event and stored as `session_id`
- [x] Error shown in UI when codex CLI is not installed
- [x] `codex` selectable in task creation form and settings panel
- [x] Claude tasks unaffected (full backward compatibility)

---

## Non-Goals

- Cloud-mode (`codex cloud`) — out of scope
- Gemini CLI, Aider, or other agents — separate RFC
- Result output schema validation (`--output-schema`) — future enhancement
- Sub-agent (`collab_tool_call`) orchestration — future enhancement
