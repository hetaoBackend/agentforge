# RFC: Codex CLI Support in AgentForge

**Status:** Draft
**Date:** 2026-03-16
**Author:** hetao

---

## Summary

Add OpenAI Codex CLI (`codex`) as a selectable agent backend alongside the existing Claude Code CLI (`claude`). Users will be able to choose `codex` per-task or as a global default.

---

## Motivation

AgentForge currently hard-codes the `claude` CLI in every execution path. The `agent` field already exists on the `tasks` table (defaulting to `"claude"`) but is never actually branched on. Adding Codex CLI support completes this abstraction, letting teams that prefer OpenAI models use the same orchestration layer.

---

## Codex CLI Overview

[Codex CLI](https://github.com/openai/codex) is OpenAI's terminal coding agent. The relevant operational characteristics are:

### Non-interactive execution

```bash
# Basic execution
codex exec "your task prompt here"

# With JSONL streaming (machine-readable)
codex exec --json "your task prompt here"

# With working directory
codex exec --json --cd /path/to/project "your task"

# Full automation (no approval prompts)
codex exec --json --ask-for-approval never "your task"

# Session resume
codex exec resume <SESSION_ID>
codex exec resume --last "follow-up prompt"
```

### Output behaviour

| Stream | Content |
|--------|---------|
| `stdout` | Final agent message (plain text) by default; JSONL events when `--json` is passed |
| `stderr` | Progress/status messages (always, regardless of `--json`) |

### JSONL event schema (`--json` mode)

Each line is a JSON object. Key event types:

| Type | Meaning |
|------|---------|
| `thread.started` | Session started; contains `session_id` |
| `turn.started` | Agent began a reasoning turn |
| `turn.completed` | Turn finished successfully |
| `turn.failed` | Turn failed; contains `error` |
| `item.started` / `item.completed` | Individual work item (see item types below) |
| `error` | Top-level error |

Key item types inside `item.*` events:

- `message` — agent text output (maps to `assistant` in Claude schema)
- `reasoning` — chain-of-thought text
- `tool_call` / `command` — shell command executed
- `file_change` — file write/edit
- `web_search` — web search performed
- `plan_update` — planning step

### Approval mode

`--ask-for-approval never` is the non-interactive equivalent of Claude's `--permission-mode bypassPermissions`.

### Authentication

Requires `CODEX_API_KEY` environment variable (OpenAI API key).

### Exit codes

- `0` — success
- Non-zero — failure (error message on stderr)

### Limitations vs Claude CLI

- No `--input-format stream-json` for multimodal stdin input (images must be passed as `--image <path>` flags)
- No `--verbose` flag; progress always goes to stderr
- Session resume works differently: `codex exec resume <id>` rather than `--resume <id>` inline

---

## Design

### Principle

Keep the per-agent logic entirely in `TaskScheduler._execute_task`. Introduce a private helper `_build_codex_command` alongside the existing Claude command-building logic. Event normalization is handled in `_parse_and_store_event` by detecting the active agent.

### No new abstraction layer

An `AgentBackend` base class would be over-engineered for two agents. The branching is contained in three methods:

1. `_execute_task` — command construction
2. `_parse_and_store_event` — JSONL → internal event schema normalization
3. `_extract_error_summary` — error extraction from Codex events

---

## Implementation Plan

### 1. Backend — `taskboard.py`

#### 1a. Command construction in `_execute_task`

Replace the current single code path with an agent branch:

```python
agent = task.get("agent", "claude")

if agent == "codex":
    cmd = [
        "codex", "exec",
        "--json",
        "--ask-for-approval", "never",
        "--cd", os.path.expanduser(task["working_dir"]),
    ]
    if task.get("session_id"):
        # codex exec resume <id> [prompt]
        cmd = ["codex", "exec", "resume", task["session_id"]] + [prompt]
    else:
        cmd.append(prompt)
    # Images: pass each as --image flag
    for img_path in image_paths or []:
        cmd.extend(["--image", img_path])
    use_stdin = False  # codex does not support stream-json stdin
else:
    # existing Claude logic (unchanged)
    ...
```

Note: when `--cd` is passed to Codex, the `cwd` argument to `subprocess.Popen` still needs to be set to the same directory for consistent process group behaviour.

#### 1b. JSONL normalization in `_parse_and_store_event`

Codex events are mapped to the internal schema that the frontend already understands:

| Codex event | Internal type | Notes |
|-------------|---------------|-------|
| `item.completed` where item type = `message` | `assistant` | Agent text response |
| `item.completed` where item type = `reasoning` | `assistant` | Prefixed with `[thinking] ` |
| `item.completed` where item type = `command` | raw JSON stored as-is | Tool use event |
| `turn.completed` | `result` | `content` = final message if present |
| `turn.failed` / `error` | `error` | `content` = error message |
| `thread.started` | skip (session_id extracted separately) | |
| other | store raw JSON | |

```python
def _parse_codex_event(self, event: dict) -> tuple[str, str] | None:
    """Return (event_type, content) for storage, or None to skip."""
    etype = event.get("type", "")
    if etype == "item.completed":
        item = event.get("item", {})
        itype = item.get("type", "")
        if itype == "message":
            return "assistant", item.get("content", "")
        elif itype == "reasoning":
            return "assistant", f"[thinking] {item.get('content', '')}"
        else:
            return etype, json.dumps(event, ensure_ascii=False)
    elif etype in ("turn.failed", "error"):
        return "error", event.get("error", event.get("message", ""))
    elif etype == "turn.completed":
        msg = event.get("message", "")
        if msg:
            return "result", msg
        return None
    elif etype == "thread.started":
        return None  # handled by session_id extraction
    else:
        return etype, json.dumps(event, ensure_ascii=False)
```

#### 1c. Session ID extraction

After execution, extract `session_id` from the `thread.started` event in stdout:

```python
for line in raw_stdout.splitlines():
    try:
        event = json.loads(line)
        if event.get("type") == "thread.started" and event.get("session_id"):
            extracted_session_id = event["session_id"]
            break
    except json.JSONDecodeError:
        pass
```

#### 1d. Success/output extraction

For Codex, the final stdout line after `turn.completed` is the plain-text final message. With `--json`, walk events to find the last `turn.completed` with a message:

```python
if agent == "codex":
    for line in reversed(raw_stdout.splitlines()):
        try:
            event = json.loads(line)
            if event.get("type") == "turn.completed" and event.get("message"):
                out = event["message"]
                break
        except json.JSONDecodeError:
            pass
    success, output = True, out or raw_stdout
```

#### 1e. Validation helper

Extend `AgentExecutor.run` (used for pre-flight checks) to handle `codex`:

```python
except FileNotFoundError:
    if agent == "codex":
        success, output = False, "codex CLI not found. Install with: npm install -g @openai/codex"
    else:
        success, output = False, "claude CLI not found. Is it installed?"
```

#### 1f. Settings API

No schema changes needed. `default_agent` already stored in settings. Expose `codex` as a valid value in the `/api/settings` response.

---

### 2. Frontend — `App.jsx`

#### 2a. Agent selector in task creation form

```jsx
<select name="agent" value={form.agent} onChange={handleChange}>
  <option value="claude">Claude (claude CLI)</option>
  <option value="codex">Codex (OpenAI codex CLI)</option>
</select>
```

#### 2b. Settings panel

Add `codex` to the default agent dropdown alongside `claude`.

#### 2c. Output rendering

No changes needed. The `FormattedOutput` component already handles `assistant`, `result`, and `error` event types, which are the normalized types Codex events will be stored as.

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
        └── stderr (progress) → stderr_thread (discarded, not stored)
        │
        ▼
  turn.completed → success=True, output=final message
  turn.failed    → success=False, output=error message
        │
        ▼
  session_id extracted from thread.started event
  task.status → completed / failed
```

---

## Open Questions

| # | Question | Impact |
|---|----------|--------|
| 1 | Does `codex exec` reliably exit 0 on success? Need to verify exit code convention across versions. | Error detection |
| 2 | Are multimodal `--image` paths passed inline to `codex exec`? Need to test with actual binary. | Image support |
| 3 | Does Codex spawn sub-agents (like Claude's Task tool)? | Sub-agent wait loop |
| 4 | Is there a `--timeout` flag or does Codex rely on the caller to kill the process? | Timeout handling |

---

## Acceptance Criteria

- [ ] Task with `agent: "codex"` executes via `codex exec --json ...` in `working_dir`
- [ ] Live output displayed in kanban board output panel during execution
- [ ] Task status transitions correctly: pending → running → completed / failed
- [ ] `session_id` extracted and stored for session resume
- [ ] Error shown in UI when codex CLI is not installed
- [ ] `codex` selectable in task creation form and settings panel
- [ ] Claude tasks unaffected (full backward compatibility)

---

## Non-Goals

- Cloud-mode (`codex cloud`) — out of scope for this RFC
- Gemini CLI, Aider, or other agents — separate RFC
- Result output schema validation (`--output-schema`) — future enhancement
