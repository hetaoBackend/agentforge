# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentForge is a macOS desktop app (Electron + Python) that provides a kanban-style task board for orchestrating AI coding agents (Claude Code CLI). The Python backend manages task scheduling, execution, and persistence; the React frontend renders the board and streams live output.

## Commands

### Python Backend
```bash
# Run backend directly (dev)
uv run taskboard.py

# Run with explicit port (default 9712)
uv run taskboard.py  # listens on 0.0.0.0:9712

# Verify health
curl http://127.0.0.1:9712/api/health

# Build PyInstaller binary (must run from project root)
uv run pyinstaller --onefile --name taskboard \
  --distpath taskboard-electron/resources \
  --hidden-import croniter --hidden-import dateutil --hidden-import pytz \
  taskboard.py
```

### Electron App
```bash
# Dev: starts Electron + Vite dev server (spawns uv run taskboard.py automatically)
cd taskboard-electron && npm start

# Build distributable DMG (arm64)
cd taskboard-electron && npm run make
# Output: taskboard-electron/out/make/AgentForge-1.0.0-arm64.dmg
```

There are no automated tests in this project.

## Architecture

### Two-process model
The Electron main process (`taskboard-electron/src/main.js`) spawns the Python backend on startup and kills it on quit. The React renderer communicates with the backend exclusively via HTTP on `localhost:9712`. There is no WebSocket or IPC for data — all API calls use `fetch()` against the REST API.

### Python backend (`taskboard.py`)
Single-file HTTP server (`BaseHTTPRequestHandler`) with:
- **`TaskDB`** — SQLite layer at `~/.agentforge/tasks.db`. Thread-safe with a lock. Stores tasks, run history, and streaming output events.
- **`AgentExecutor`** — Runs `claude` CLI with `--output-format stream-json --verbose --permission-mode acceptEdits`. Parses the NDJSON stream and persists each event to `task_output_events`.
- **`TaskScheduler`** — Background thread that polls every 2 seconds for due tasks. Supports four schedule types:
  - `immediate`: runs as soon as scheduled
  - `delayed`: runs after N seconds (relative time)
  - `scheduled_at`: runs once at a specific datetime (absolute time)
  - `cron`: recurring schedule using croniter for cron expression evaluation
- **REST API** — Endpoints under `/api/tasks`, `/api/tasks/{id}/runs`, `/api/tasks/{id}/output`, `/api/tasks/{id}/events`, `/api/health`.

### Electron main process (`taskboard-electron/src/main.js`)
- In **dev mode**: `app.getAppPath()` returns `taskboard-electron/`, so `path.join(app.getAppPath(), '..')` resolves to project root for `uv run taskboard.py`. The `cwd` option must point to project root when spawning.
- In **packaged mode**: uses the binary at `resources/taskboard` bundled inside the `.app`.
- Polls `/api/health` (15s timeout) before loading the UI.
- Exposes `window.electronAPI.selectDirectory()` to renderer via context bridge for native directory picker.

### React frontend (`taskboard-electron/src/renderer/App.jsx`)
Single large component (~1500 lines). Key design points:
- `API` constant hardcoded to `http://127.0.0.1:9712/api`.
- Kanban columns: **Queue** (pending/scheduled/blocked) → **Running** → **Done** (completed/failed/cancelled).
- `FormattedOutput` component parses stream-json events (type: `user`/`assistant`/`result`/`error`) from the backend and renders colorized output.
- Task creation supports four schedule types:
  - `immediate`: run immediately
  - `delayed`: run after N seconds
  - `scheduled_at`: run once at a specific date/time (uses `<input type="datetime-local">`)
  - `cron`: recurring schedule (cron expression string)

### Data flow for task execution
1. User creates task via React form → `POST /api/tasks`
2. Scheduler picks up task → `AgentExecutor.run()` spawns `claude` CLI
3. NDJSON output streamed and written to `task_output_events` table per line
4. Frontend polls `/api/tasks/{id}/output` or `/api/tasks/{id}/events` to display live output
5. On finish, task status updated to `completed` or `failed`

## Workflow Rules

### Task Tracking with docs/todo.md
- **Before starting any task**: Record the task in `todo.md` with a pending status before beginning work.
- **Before notifying completion**: Double-confirm the task is actually done (verify changes, run relevant checks), then update the corresponding entry in `todo.md` to reflect the completed status.
- This ensures all work is tracked and verified before being reported as finished.
