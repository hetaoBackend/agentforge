## Project Overview

AgentForge is a macOS desktop app (Electrobun + Bun/TypeScript) that provides a kanban-style task board for orchestrating AI coding agents (**Claude Code or OpenAI Codex CLI**). The TypeScript backend (running on Bun) manages task scheduling, execution, and persistence; the React frontend renders the board and streams live output. Tasks can also be created/monitored from chat channels (Telegram / Slack / Feishu / WeChat), and a **Skill Library** distills recurring task patterns into reusable Claude Code skills.

The entire project is TypeScript-only and uses **Bun** to build, run, test, and compile (no Python, no Node toolchain; Electrobun's Bun host runs the packaged app).

## Commands

### Backend (`backend/`)
```bash
# Run backend directly (dev) — listens on 127.0.0.1:9712 (loopback only)
cd backend && bun taskboard.ts

# Verify health
curl http://127.0.0.1:9712/api/health

# Optional: compile a standalone backend binary
cd backend && bun run compile
```

### Electrobun App
```bash
# Dev: Electrobun builds the Bun host + React view, starts the backend in-process,
# watches sources, and relaunches on changes.
cd taskboard-electron && bun run start

# Build distributable DMG (arm64)
cd taskboard-electron && bun run make
# Output: taskboard-electron/build/stable-macos-arm64/AgentForge.dmg
```

### Tests & Quality
```bash
# Backend (⭐ backend-quality CI job runs `make check`)
make check        # = cd backend && bun run check (tsc --noEmit + prettier --check + bun test --coverage)
make test         # bun test only
make lint         # tsc typecheck ONLY (no format-check, no tests — NOT the CI gate)
make format       # apply prettier formatting
cd backend && bun test  # run the suite directly

# Frontend (⭐ frontend-quality CI job runs all five, from taskboard-electron/)
cd taskboard-electron
bun run typecheck     # tsc over renderer + Electrobun host/config tsconfigs
bun run lint          # ESLint (flat config, typescript-eslint, eslint.config.mjs)
bun run format:check  # Prettier --check (bun run format to apply)
bun run test          # bun test (pins TZ=Asia/Shanghai — date tests assert local wall time)
bun run build:check   # Electrobun build — catches compile/import/resource errors
```
CI (`.github/workflows/ci.yml`) runs two jobs: **backend-quality** (`bun run check` in `backend/`)
and **frontend-quality** (typecheck + lint + format check + tests + build). The workflow uses
`concurrency` to cancel superseded runs on the same ref. Backend tests live in `backend/tests/*.test.ts`
(bun:test), frontend tests beside the renderer sources as `*.test.ts`.

## Architecture

### Desktop host model
The Electrobun Bun main process (`taskboard-electron/src/electrobun/main.ts`) starts the Bun backend in-process on startup and stops it on quit. The React renderer communicates with the backend exclusively via HTTP on `127.0.0.1:9712` (loopback only). There is no WebSocket for app data — the renderer polls the REST API with `fetch()`. Native desktop affordances, such as directory selection, use Electrobun RPC behind the existing renderer bridge facade.

### Bun backend (`backend/`)
TypeScript modules served by `Bun.serve` (entry `backend/taskboard.ts`):
- **`src/db.ts` — `TaskDB`** — SQLite layer (bun:sqlite) at `~/.agentforge/tasks.db`. Stores tasks, run history, and streaming output events. Method names keep the original Python snake_case spelling (they double as API JSON keys).
- **`src/executor.ts` — `AgentExecutor`** — Runs the agent CLI: `claude -p … --output-format stream-json --verbose --permission-mode bypassPermissions`, or `codex exec --json …`. Parses the NDJSON stream and persists each event to `task_output_events`.
- **`src/scheduler.ts` — `TaskScheduler`** — Polls every 2 seconds for due tasks. Supports four schedule types:
  - `immediate`: runs as soon as scheduled
  - `delayed`: runs after N seconds (relative time)
  - `scheduled_at`: runs once at a specific datetime (absolute time)
  - `cron`: recurring schedule using cron-parser for cron expression evaluation
- **Heartbeats** — Background watcher: on a cron/interval it runs a `check_prompt` via an agent that returns a JSON decision (idle/trigger/resume/notify) and may auto-create tasks.
- **Skill Library** (`src/skills.ts` + scheduler) — `TaskScheduler.run_skill_sweep` periodically (or via the manual "Scan" button) asks an agent to detect recurring patterns across completed runs (`skill_patterns` table), distills candidates into standard Claude Code `SKILL.md` files using the vendored `vendor/skill-creator`, and on approval writes them to `~/.agentforge/skills` symlinked into both `~/.claude/skills` and `~/.agents/skills`. Off by default (`skill_library_enabled` setting).
- **Channels** (`src/channels/`) — Optional Telegram / Slack / Feishu / WeChat bridges (a `MessageBus` in `src/bus.ts` decouples them from the scheduler). Feishu uses a lark WebSocket long-connection (`@larksuiteoapi/node-sdk`).
- **REST API** (`src/api.ts`, `src/server.ts`) — Endpoints under `/api/tasks*`, `/api/heartbeats*`, `/api/skill-patterns`, `/api/skills*`, `/api/settings`, `/api/channels/*`, `/api/health`.

### Electrobun main process (`taskboard-electron/src/electrobun/main.ts`)
- Starts `backend/src/server.ts` via `runServer(9712)` inside the Electrobun Bun host.
- Sets packaged resource env vars for the Weixin bridge and vendored `skill-creator`.
- Creates the main `BrowserWindow` at `views://main/index.html`.
- Exposes native directory picking to the renderer through Electrobun RPC while preserving `window.electronAPI.selectDirectory()` as a compatibility facade.

### Build pipeline (`taskboard-electron/scripts/`)
- `electrobun.config.ts` — Electrobun app metadata, Bun host entrypoint, React view entrypoint, copied assets/resources, and macOS packaging options.
- `build-electrobun-resources.ts` — compiles the Weixin bridge sidecar into `resources/weixin-bridge` before Electrobun copies resources.
- `bun run build:check` / `bun run build` — run `electrobun build`.
- `bun run make` — runs `electrobun build --env=stable` and produces the stable macOS DMG.

### React frontend (`taskboard-electron/src/renderer/App.tsx`)
Single large component (~6200 lines). Key design points:
- `API` constant hardcoded to `http://127.0.0.1:9712/api`.
- Three top-level views (tab switch): **Tasks** (kanban), **Heartbeats**, **Skills**.
- Kanban columns: **Queue** (pending/scheduled/blocked) → **Running** → **Done** (completed/failed/cancelled).
- `FormattedOutput` component parses stream-json events (type: `user`/`assistant`/`result`/`error`) and renders colorized output; trace/event aggregation helpers live in `traceSteps.ts` (tested by `traceSteps.test.ts`).
- Backend payload interfaces (snake_case) live in `src/renderer/types.ts`.
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
- After any change to backend code (or before pushing / reporting done), run **`make check`** — not `make lint`. `make lint` only runs the tsc typecheck; it skips `prettier --check` and the tests, so it will pass while CI still fails on formatting or a broken test.
- If `make check` reports formatting diffs, run `make format` to fix them, then re-run `make check`.
- For frontend-only changes, run the frontend gate from `taskboard-electron/`: `bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build:check` (this is exactly what the frontend-quality CI job runs). If `format:check` fails, run `bun run format` to fix.
