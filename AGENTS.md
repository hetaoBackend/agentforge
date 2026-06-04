## Project Overview

AgentForge is a macOS desktop app (Electron + Python) that provides a kanban-style task board for orchestrating AI coding agents (**Claude Code or OpenAI Codex CLI**). The Python backend manages task scheduling, execution, and persistence; the React frontend renders the board and streams live output. Tasks can also be created/monitored from chat channels (Telegram / Slack / Feishu / WeChat), and a **Skill Library** distills recurring task patterns into reusable Claude Code skills.

## Commands

### Python Backend
```bash
# Run backend directly (dev)
uv run taskboard.py

# Run with explicit port (default 9712)
uv run taskboard.py  # listens on 127.0.0.1:9712 (loopback only — not network-exposed)

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

### Tests & Quality
```bash
# Backend (⭐ backend-quality CI job runs `make check`)
make check        # ruff lint + ruff format --check + pytest (coverage, fail_under=90)
make test         # pytest only
make lint         # ruff check ONLY (no format-check, no tests — NOT the CI gate)
make format       # apply ruff formatting
uv run pytest -q  # run the Python suite directly

# Frontend (⭐ frontend-quality CI job runs all four, from taskboard-electron/)
cd taskboard-electron
npm run lint          # ESLint (flat config, eslint.config.mjs)
npm run format:check  # Prettier --check (npm run format to apply)
npm test              # node --test (pins TZ=Asia/Shanghai — date tests assert local wall time)
npm run build:check   # vite renderer build — catches compile/import errors
```
CI (`.github/workflows/ci.yml`) runs two jobs: **backend-quality** (`make check`)
and **frontend-quality** (lint + format check + tests + build). The workflow uses
`concurrency` to cancel superseded runs on the same ref. There are 34 pytest files
under `tests/` (backend coverage gate is 90%) plus `.test.mjs` files beside the renderer.

## Architecture

### Two-process model
The Electron main process (`taskboard-electron/src/main.js`) spawns the Python backend on startup and kills it on quit. The React renderer communicates with the backend exclusively via HTTP on `127.0.0.1:9712` (loopback only). There is no WebSocket or IPC for data — the renderer polls the REST API with `fetch()`.

### Python backend (`taskboard.py`)
Single-file HTTP server (`BaseHTTPRequestHandler`) with:
- **`TaskDB`** — SQLite layer at `~/.agentforge/tasks.db`. Thread-safe with a lock. Stores tasks, run history, and streaming output events.
- **`AgentExecutor`** — Runs the agent CLI: `claude -p … --output-format stream-json --verbose --permission-mode bypassPermissions`, or `codex exec --json …`. Parses the NDJSON stream and persists each event to `task_output_events`.
- **`TaskScheduler`** — Background thread that polls every 2 seconds for due tasks. Supports four schedule types:
  - `immediate`: runs as soon as scheduled
  - `delayed`: runs after N seconds (relative time)
  - `scheduled_at`: runs once at a specific datetime (absolute time)
  - `cron`: recurring schedule using croniter for cron expression evaluation
- **`Heartbeat`** — Background watcher: on a cron/interval it runs a `check_prompt` via an agent that returns a JSON decision (idle/trigger/resume/notify) and may auto-create tasks.
- **Skill Library** — `TaskScheduler.run_skill_sweep` periodically (or via the manual "Scan" button) asks an agent to detect recurring patterns across completed runs (`skill_patterns` table), distills candidates into standard Claude Code `SKILL.md` files using the vendored `vendor/skill-creator`, and on approval writes them to `~/.agentforge/skills` symlinked into both `~/.claude/skills` and `~/.agents/skills`. Off by default (`skill_library_enabled` setting).
- **Channels** (`channels/`) — Optional Telegram / Slack / Feishu / WeChat bridges (a `MessageBus` in `taskboard_bus.py` decouples them from the scheduler). Feishu uses a lark WebSocket long-connection.
- **REST API** — Endpoints under `/api/tasks*`, `/api/heartbeats*`, `/api/skill-patterns`, `/api/skills*`, `/api/settings`, `/api/channels/*`, `/api/health`.

### Electron main process (`taskboard-electron/src/main.js`)
- In **dev mode**: `app.getAppPath()` returns `taskboard-electron/`, so `path.join(app.getAppPath(), '..')` resolves to project root for `uv run taskboard.py`. The `cwd` option must point to project root when spawning.
- In **packaged mode**: uses the binary at `resources/taskboard` bundled inside the `.app`.
- Polls `/api/health` (15s timeout) before loading the UI.
- Exposes `window.electronAPI.selectDirectory()` to renderer via context bridge for native directory picker.

### React frontend (`taskboard-electron/src/renderer/App.jsx`)
Single large component (~4200 lines). Key design points:
- `API` constant hardcoded to `http://127.0.0.1:9712/api`.
- Three top-level views (tab switch): **Tasks** (kanban), **Heartbeats**, **Skills**.
- Kanban columns: **Queue** (pending/scheduled/blocked) → **Running** → **Done** (completed/failed/cancelled).
- `FormattedOutput` component parses stream-json events (type: `user`/`assistant`/`result`/`error`) and renders colorized output; trace/event aggregation helpers live in `traceSteps.mjs` (tested by `traceSteps.test.mjs`).
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

### Always run `make check` after changing code
- After any change to Python code (or before pushing / reporting done), run **`make check`** — not `make lint`. `make lint` only runs `ruff check`; it skips `ruff format --check` and the tests, so it will pass while CI still fails on formatting or a broken test.
- If `make check` reports formatting diffs, run `make format` to fix them, then re-run `make check`.
- For frontend-only changes, run the frontend gate from `taskboard-electron/`: `npm run lint && npm run format:check && npm test && npm run build:check` (this is exactly what the frontend-quality CI job runs). If `format:check` fails, run `npm run format` to fix.
