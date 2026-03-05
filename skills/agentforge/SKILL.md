---
name: agentforge
version: 1.1.0
last_verified: "2026-02-13"
description: |
  AgentForge integration for creating and managing AI agent tasks with scheduling capabilities.
  Use when the user wants to: (1) Create tasks for AI agents to execute (immediately, delayed, at specific time, or on cron schedule),
  (2) Query task status and view task lists, (3) View task execution history and output, (4) Check what tasks
  are running/pending/completed, (5) Create DAG pipelines where tasks depend on each other, or (6) Cancel running or pending tasks.
  AgentForge runs a local HTTP API at http://127.0.0.1:9712 that manages task scheduling and execution.
---

# AgentForge Skill

Interact with AgentForge, a task orchestration system for AI coding agents.

## Script Path

The CLI script is located at `$SKILL_DIR/scripts/agentforge_api.py` relative to this skill's installation directory.

Resolve the absolute path before invoking:
```bash
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
python "$SKILL_DIR/scripts/agentforge_api.py" --method health
```

In practice, use the full absolute path when calling the script, e.g.:
```bash
python /path/to/skills/agentforge/scripts/agentforge_api.py --method list
```

**No external dependencies required** — the script uses only Python standard library (`urllib`, `json`, `argparse`).

## Quick Start

Use the CLI script with explicit `--method` parameter:

```bash
# Create an immediate task
python scripts/agentforge_api.py --method create \
  --prompt "Run the test suite" --title "Run tests" --dir /path/to/project

# List all tasks
python scripts/agentforge_api.py --method list

# Get task details
python scripts/agentforge_api.py --method get --task-id 5

# View live output
python scripts/agentforge_api.py --method output --task-id 5

# Retry a failed task
python scripts/agentforge_api.py --method retry --task-id 5

# Delete a task
python scripts/agentforge_api.py --method delete --task-id 5

# Cancel a task
python scripts/agentforge_api.py --method cancel --task-id 5
```

## Core Operations

### Creating Tasks

Create tasks using `--method create` with explicit parameters:

**Immediate execution:**
```bash
python scripts/agentforge_api.py --method create \
  --prompt "Fix the bug in login.py" \
  --title "Fix login bug" --dir ~/my-project
```

**Delayed execution:**
```bash
python scripts/agentforge_api.py --method create \
  --prompt "Send status report" --title "Status report" \
  --schedule delayed --delay 300
```

**At specific time (one-time execution):**
```bash
python scripts/agentforge_api.py --method create \
  --prompt "Deploy to production" --title "Production deploy" \
  --schedule scheduled_at --at "2026-02-15 14:30:00"
```

**Recurring cron schedule:**
```bash
python scripts/agentforge_api.py --method create \
  --prompt "Run daily backup" --title "Daily backup" \
  --schedule cron --cron "0 2 * * *" --max-runs 30
```

**With image attachments:**
```bash
python scripts/agentforge_api.py --method create \
  --prompt "Analyze this screenshot" --title "Screenshot analysis" \
  --image-paths "/path/to/image1.png,/path/to/image2.jpg"
```

**Working directory inference:**
- If user specifies a project or directory, use `--dir /path/to/project`
- If user mentions "current directory" or similar, use `--dir .` or omit (defaults to ".")
- If ambiguous, use `--dir .` as sensible default
- Only ask for clarification if genuinely unclear

### Querying Tasks

**List all tasks:**
```bash
python scripts/agentforge_api.py --method list
# Output: 🕐 #1: My task (pending)
#         ⏳ #2: Running task (running)
#         ✅ #3: Done task (completed)
```

**List with status filter:**
```bash
python scripts/agentforge_api.py --method list --status running
python scripts/agentforge_api.py --method list --status completed --json
```

**Get specific task:**
```bash
python scripts/agentforge_api.py --method get --task-id 5
# Returns full JSON with status, result, error, etc.
```

**Task status values:**
- `pending`: Ready to run
- `scheduled`: Waiting for scheduled time
- `running`: Currently executing
- `completed`: Successfully finished
- `failed`: Execution failed
- `cancelled`: Manually cancelled
- `blocked`: Waiting for upstream DAG dependencies to complete

### Retrying Failed Tasks

**Retry a failed task (re-enqueue for execution):**
```bash
python scripts/agentforge_api.py --method retry --task-id 5
# Returns: {"status": "pending"}
```

- Only tasks with status `failed` or `cancelled` can be retried
- The task is reset to `pending` and will be picked up by the scheduler

### Deleting Tasks

**Permanently delete a task:**
```bash
python scripts/agentforge_api.py --method delete --task-id 5
# Returns: {"status": "deleted"}
```

- Deletes the task and all associated run history and output events
- Running tasks should be cancelled before deleting

### Cancelling Tasks

**Cancel a running or pending task:**
```bash
python scripts/agentforge_api.py --method cancel --task-id 5
# Returns: {"status": "cancelled"}
```

- Cancelling a running task kills the underlying agent process immediately
- Cancelling a task in a DAG pipeline will also cascade-cancel all downstream blocked tasks
- Can cancel tasks with status: `pending`, `scheduled`, `running`, or `blocked`

### Viewing Task History

**Get run history:**
```bash
python scripts/agentforge_api.py --method runs --task-id 5
```

**Get live output for running task:**
```bash
python scripts/agentforge_api.py --method output --task-id 5
# Shows: Status: Running
#        Output: [live accumulated output]
```

**Get structured events:**
```bash
python scripts/agentforge_api.py --method events --task-id 5 --limit 100
```

## Response Formatting

When displaying task information to users:

**Task lists:** Show ID, title, status, and relevant metadata in a table or bullet format

**Task details:** Include status, working directory, schedule info, result/error if present

**Run history:** Show run ID, status, start/end times, and brief result summary

**Live output:** Stream or display accumulated output for running tasks

### DAG Pipelines (Task Dependencies)

Create workflows where tasks automatically trigger downstream tasks upon completion.

**Create a task with upstream dependencies:**
```bash
# Task #12 will be BLOCKED until tasks #10 and #11 complete
python scripts/agentforge_api.py --method create \
  --prompt "Analyze results" --title "Analysis" --dir ~/project \
  --depends-on 10,11 --dag-id my-pipeline

# Inject upstream results into the prompt automatically
python scripts/agentforge_api.py --method create \
  --prompt "Summarize the findings" --title "Summary" --dir ~/project \
  --depends-on 12 --inject-result --dag-id my-pipeline
```

**View a full DAG pipeline:**
```bash
python scripts/agentforge_api.py --method dag --dag-id my-pipeline
# Output:
#   DAG: my-pipeline (3 tasks)
#   ✅ #10: Build (completed)
#   ✅ #11: Test (completed)
#   ⏳ #12: Analysis (running) <- #10, #11
```

**Behavior:**
- Downstream tasks start as `blocked` if any upstream is not yet `completed`
- When ALL upstream tasks complete -> downstream automatically unblocks to `pending`
- If ANY upstream task fails -> all reachable downstream tasks are cascade-cancelled
- Use `--inject-result` to prepend upstream task results into the downstream prompt

## Error Handling

The CLI provides specific error messages:

- **AgentForge not running:** `Connection failed: AgentForge is not running.` with startup instructions
- **API errors:** `API error (HTTP 404): Task not found` with HTTP status code and server error detail
- **Network errors:** `Network error: <reason>` for other connectivity issues

## Implementation Notes

- The CLI script (`scripts/agentforge_api.py`) handles all HTTP communication
- Uses only Python standard library (no `pip install` needed)
- Default API endpoint: `http://127.0.0.1:9712/api`
- AgentForge must be running locally for this skill to work
- All task execution happens asynchronously via the AgentForge scheduler
- All commands output JSON by default (except `list` which has formatted output)
- Use `--json` flag with `list` and `output` commands for JSON output
