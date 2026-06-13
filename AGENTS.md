## Project Overview

AgentForge is a macOS desktop app (Electron + Bun/TypeScript) that provides a kanban-style task board for orchestrating AI coding agents (**Claude Code or OpenAI Codex CLI**). The TypeScript backend (running on Bun) manages task scheduling, execution, and persistence; the React frontend renders the board and streams live output. Tasks can also be created/monitored from chat channels (Telegram / Slack / Feishu / WeChat), and a **Skill Library** distills recurring task patterns into reusable Claude Code skills.

The entire project is TypeScript-only and uses **Bun** to build, run, test, and compile (no Python, no Node toolchain — Electron's bundled Node runs the packaged app, but all tooling is Bun).

## Commands

### Backend (`backend/`)
```bash
# Run backend directly (dev) — listens on 127.0.0.1:9712 (loopback only)
cd backend && bun taskboard.ts

# Verify health
curl http://127.0.0.1:9712/api/health

# Compile single-file binary for packaging (replaces PyInstaller)
cd taskboard-electron && bun scripts/build-backend.ts
# (equivalent: cd backend && bun run compile)
```

### Electron App
```bash
# Dev: Bun-builds main/preload/renderer, launches Electron with watch + reload
# (spawns `bun backend/taskboard.ts` automatically)
cd taskboard-electron && bun run start

# Build distributable DMG (arm64)
cd taskboard-electron && bun run make
# Output: taskboard-electron/out/make/AgentForge-1.0.0-arm64.dmg
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
bun run typecheck     # tsc over renderer + main/preload tsconfigs
bun run lint          # ESLint (flat config, typescript-eslint, eslint.config.mjs)
bun run format:check  # Prettier --check (bun run format to apply)
bun run test          # bun test (pins TZ=Asia/Shanghai — date tests assert local wall time)
bun run build:check   # Bun.build of main/preload/renderer — catches compile/import errors
```
CI (`.github/workflows/ci.yml`) runs two jobs: **backend-quality** (`bun run check` in `backend/`)
and **frontend-quality** (typecheck + lint + format check + tests + build). The workflow uses
`concurrency` to cancel superseded runs on the same ref. Backend tests live in `backend/tests/*.test.ts`
(bun:test), frontend tests beside the renderer sources as `*.test.ts`.

## Architecture

### Two-process model
The Electron main process (`taskboard-electron/src/main.ts`) spawns the Bun backend on startup and kills it on quit. The React renderer communicates with the backend exclusively via HTTP on `127.0.0.1:9712` (loopback only). There is no WebSocket or IPC for data — the renderer polls the REST API with `fetch()`.

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

### Electron main process (`taskboard-electron/src/main.ts`)
- In **dev mode**: `app.getAppPath()` returns `taskboard-electron/`, so `path.join(app.getAppPath(), '..')` resolves to project root for `bun backend/taskboard.ts`. The `cwd` option must point to project root when spawning.
- In **packaged mode**: uses the `bun build --compile` binary at `resources/taskboard` bundled inside the `.app`.
- Polls `/api/health` (15s timeout) before loading the UI.
- Exposes `window.electronAPI.selectDirectory()` to renderer via context bridge for native directory picker.

### Build pipeline (`taskboard-electron/scripts/`)
- `build.ts` — `Bun.build` bundles main (CJS, electron external), preload (CJS), and renderer (HTML entrypoint → `.bun/renderer/`). Replaces the old Vite plugin.
- `dev.ts` — watch-rebuild + Electron launcher; renderer rebuilds trigger window reload (main.ts watches `.bun/renderer`), backend `.ts` changes restart the backend.
- `build-backend.ts` — `bun build --compile` of `backend/taskboard.ts` into `resources/taskboard`.
- electron-forge is retained only for packaging/DMG (`bunx electron-forge package|make`); `forge.config.js` ships `.bun/` output via packager ignore rules.

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
