# TypeScript + Bun Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the entire AgentForge project to TypeScript only — Python backend ported to Bun-native TypeScript, Electron/React frontend converted from JS/JSX to TS/TSX — with Bun as the toolchain for build, run, test, and compile (replacing uv/pytest/PyInstaller/npm/node-test, and replacing Vite with `Bun.build`).

**Architecture:** The Python single-file backend (`taskboard.py`, 5240 lines) becomes a modular TypeScript app in `backend/` running on Bun: `bun:sqlite` for `TaskDB`, `Bun.serve` for the HTTP API on `127.0.0.1:9712`, `Bun.spawn` for agent CLI execution, `cron-parser` for cron evaluation. Chat channels port to official TS SDKs (`@slack/socket-mode`, `@larksuiteoapi/node-sdk`) or plain `fetch` (Telegram). The REST API contract is preserved exactly so the React frontend keeps working unchanged. The Electron app keeps electron-forge for DMG packaging but drops `plugin-vite`; main/preload/renderer are bundled by `Bun.build` scripts. The backend binary for packaging is produced by `bun build --compile` instead of PyInstaller.

**Tech Stack:** Bun ≥1.3 (runtime, test runner, bundler, single-file compiler, package manager), TypeScript 5 (strict), `bun:sqlite`, `cron-parser`, `@slack/web-api` + `@slack/socket-mode`, `@larksuiteoapi/node-sdk`, Electron 40 + electron-forge (packaging only), React 19, ESLint (typescript-eslint) + Prettier.

**Porting convention (applies to every port task):** The existing Python/JS file named in the task is the authoritative spec — translate behavior 1:1 (same route paths, status codes, JSON field names, SQL schema, timestamps format, error strings that tests assert on). The pytest file(s) named in the task define the acceptance tests: port them to `bun:test` (`describe/test/expect`, `mock()` for monkeypatching) before or alongside the implementation, and they must pass. Where Python tests monkeypatch module attributes, design the TS module with injectable dependencies (constructor params or exported setters) so tests can substitute fakes.

---

## File Structure

```
backend/
  package.json            # name agentforge-backend; deps below
  tsconfig.json           # strict, moduleResolution bundler, types ["bun-types"]
  bunfig.toml             # [test] coverage settings
  taskboard.ts            # entry: parses port, calls runServer (compiled by `bun build --compile`)
  src/
    types.ts              # TaskStatus, ScheduleType, HeartbeatScheduleType, HeartbeatDecisionType, Task, Heartbeat interfaces
    util.ts               # getEnv, parseComparableDatetime, normalizeDatetimeForStorage, parseJsonObject
    db.ts                 # TaskDB (bun:sqlite, Database with WAL; sync API ≙ Python's lock semantics)
    bus.ts                # InboundMessage/OutboundMessage types, MessageBus, Channel (abstract), UIChannel, busNotify helper (≙ BusAwareSchedulerMixin)
    executor.ts           # AgentExecutor (Bun.spawn, NDJSON line streaming)
    skills.ts             # skill dirs, link/unlink, write/remove skill on disk, frontmatter compose/parse
    scheduler.ts          # TaskScheduler (2s setInterval tick, heartbeats, skill sweep, codex/claude stream parsing, weixin status helper)
    api.ts                # route table ≙ TaskAPIHandler do_GET/POST/PUT/DELETE incl. CORS + CSRF checks
    server.ts             # runServer (Bun.serve), killStaleProcessOnPort, signal handling
    channels/
      agent_utils.ts      # parseAgentCommand, handleAgentCommand, resolveAgent
      dir_utils.ts        # parseDirCommand, handleDirCommand, extractWorkingDirWithClaude, resolveWorkingDir
      telegram.ts         # TelegramChannel via raw Bot API fetch long-polling
      slack.ts            # SlackChannel via @slack/socket-mode + @slack/web-api
      feishu.ts           # FeishuChannel + FeishuStreamWriter via @larksuiteoapi/node-sdk WSClient
      weixin.ts           # WeixinChannel spawning channels/weixin_bridge (bridge converted to TS)
  tests/                  # ported from tests/*.py, one .test.ts per pytest file
taskboard-electron/
  src/main.ts, src/preload.ts, src/renderer.ts
  src/renderer/App.tsx, main.tsx, channelsSettings.ts, dateTime.ts, traceSteps.ts (+ .test.ts)
  scripts/build.ts        # Bun.build for main/preload/renderer (replaces plugin-vite + vite configs)
  scripts/dev.ts          # watch build + spawn electron (dev mode)
  scripts/build-backend.ts# bun build --compile of backend (replaces build-backend.mjs)
  tsconfig.json
```

Deleted at the end: `taskboard.py`, `taskboard_bus.py`, `channels/*.py`, `tests/*.py`, `pyproject.toml`, `uv.lock`, `taskboard.spec`, `vite.*.config.mjs`, `scripts/build-backend.mjs`, `package-lock.json`, `__pycache__/`.

## Pytest → bun test mapping

| Python test file | TS test file (backend/tests/) |
|---|---|
| test_taskdb.py | taskdb.test.ts |
| test_taskboard_bus.py | bus.test.ts |
| test_execute_task.py | execute-task.test.ts |
| test_scheduler_logic.py | scheduler-logic.test.ts |
| test_scheduler_more.py | scheduler-more.test.ts |
| test_codex_streaming_events.py | codex-streaming-events.test.ts |
| test_skill_patterns.py | skill-patterns.test.ts |
| test_api_handler.py / _more.py | api-handler.test.ts / api-handler-more.test.ts |
| test_taskboard_gaps.py / gaps2.py | gaps.test.ts / gaps2.test.ts |
| test_telegram_*.py | telegram-*.test.ts |
| test_slack_*.py | slack-*.test.ts |
| test_feishu_*.py | feishu-*.test.ts |
| test_weixin_*.py | weixin-*.test.ts |
| (frontend) *.test.mjs | same dir, *.test.ts under bun test |

Coverage: pytest gate was `fail_under = 90`. Backend `bunfig.toml` sets `[test] coverage = true, coverageThreshold = 0.9` (line coverage) scoped to `backend/src`.

## Tasks

### Task 1: Scaffold Bun + TS backend workspace
- [ ] `backend/package.json` with deps `cron-parser`, `@slack/web-api`, `@slack/socket-mode`, `@larksuiteoapi/node-sdk`; devDeps `typescript`, `@types/bun` (or `bun-types`).
- [ ] `backend/tsconfig.json` (strict true, module ESNext, moduleResolution bundler, noEmit).
- [ ] `backend/bunfig.toml` test coverage config (threshold enforced once suites land).
- [ ] Scripts: `"check": "tsc --noEmit && bun test"`, `"start": "bun taskboard.ts"`, `"compile": "bun build --compile ..."`.
- [ ] Smoke: `cd backend && bun install && bun x tsc --noEmit` (empty src OK) — PASS.

### Task 2: Core — types, util, db, bus (+ tests)
Spec: `taskboard.py:117-1596` and `taskboard_bus.py` (whole file).
- [ ] Port enums/dataclasses → `src/types.ts`; helpers → `src/util.ts`.
- [ ] Port `TaskDB` → `src/db.ts` on `bun:sqlite` — identical schema/DDL, same method surface (camelCase), `transaction()` via `db.transaction`.
- [ ] Port `taskboard_bus.py` → `src/bus.ts` (queues become arrays + waiters; `getInbound(timeout)` async).
- [ ] Port `tests/test_taskdb.py` → `backend/tests/taskdb.test.ts`; `tests/test_taskboard_bus.py` → `bus.test.ts`.
- [ ] Run `bun test` — PASS; `tsc --noEmit` — clean. Commit.

### Task 3: Executor, skills, scheduler (+ tests)
Spec: `taskboard.py:1597-3798`.
- [ ] `src/executor.ts`: `AgentExecutor.run()` — claude/codex CLI invocation, NDJSON streaming via `Bun.spawn` stdout reader.
- [ ] `src/skills.ts`: skill dirs, sanitize/link/unlink/write/remove, frontmatter compose/parse.
- [ ] `src/scheduler.ts`: `TaskScheduler` — tick loop (2s), due tasks/heartbeats, delayed scheduling, heartbeat decision parsing, skill sweep + distill, codex/claude event parsing (`_parse_and_store_event` et al.), task lifecycle (`submit/cancel/retry`, dependency DAG, `_on_task_completed/_failed`), output listeners.
- [ ] Port the six pytest files listed in the mapping table for this area; design injectable seams where pytest monkeypatches (`_run_agent_command`, `subprocess.Popen` → injectable spawn fn).
- [ ] `bun test` PASS, `tsc` clean. Commit.

### Task 4: HTTP API + server entry (+ tests)
Spec: `taskboard.py:3799-5240`.
- [ ] `src/api.ts`: every route in `do_GET/do_POST/do_PUT/do_DELETE` with identical paths, payload validation (incl. `_validate_heartbeat_payload`), status codes, CORS allowlist + CSRF check.
- [ ] `src/server.ts`: `runServer(port=9712)` on `Bun.serve` bound to 127.0.0.1, stale-process kill, SIGINT/SIGTERM shutdown; `taskboard.ts` entry.
- [ ] Port `test_api_handler.py`, `test_api_handler_more.py` (drive `api.ts` handler with `Request` objects).
- [ ] `bun test` PASS; manual smoke `bun taskboard.ts` + `curl http://127.0.0.1:9712/api/health`. Commit.

### Task 5: Channels (+ tests) — parallel per channel
Spec: `channels/*.py`; bus/db/scheduler APIs from Tasks 2-3.
- [ ] `agent_utils.ts`, `dir_utils.ts` + inline coverage via channel tests.
- [ ] `telegram.ts` (fetch long-poll, command parsing, forwarded-message formatting, MarkdownV2 escaping) + 4 telegram test files.
- [ ] `slack.ts` (socket mode events, mention/DM handling, commands status/cancel/resume, reactions, threads) + 2 slack test files.
- [ ] `feishu.ts` (WSClient lifecycle, stream writer with debounced card patch, trace formatting, image upload) + 6 feishu test files.
- [ ] `weixin.ts` (bridge process management, QR login flow, status) + convert `channels/weixin_bridge/index.mjs` → TS + 2 weixin test files.
- [ ] `bun test` PASS for all. Commit per channel.

### Task 6: Electron app → TypeScript
- [ ] `src/main.js`→`main.ts` (typed; dev spawns `bun backend/taskboard.ts` from project root instead of `uv run taskboard.py`), `preload.js`→`preload.ts`, `renderer.js`→`renderer.ts`.
- [ ] `renderer/App.jsx`→`App.tsx`, `main.jsx`→`main.tsx`, `channelsSettings.mjs`/`dateTime.mjs`/`traceSteps.mjs`→`.ts`, their tests →`.test.ts` (bun test, TZ pinned in bunfig/script).
- [ ] `taskboard-electron/tsconfig.json` (strict; `jsx: react-jsx`; DOM libs).
- [ ] ESLint flat config gains typescript-eslint; Prettier globs updated to ts/tsx.
- [ ] Gate: `bun x tsc --noEmit`, `bun run lint`, `bun run format:check`, `bun test` all PASS. Commit.

### Task 7: Bun toolchain (build/run/compile/package)
- [ ] `scripts/build.ts`: `Bun.build` — main (`target: node`, `external: ['electron']`, outdir `.bun/build`), preload (cjs), renderer (tsx + index.html, outdir `.bun/renderer`).
- [ ] `scripts/dev.ts`: watch-rebuild + launch electron, renderer reload (reuse chokidar).
- [ ] `scripts/build-backend.ts`: `bun build --compile ../backend/taskboard.ts --outfile resources/taskboard`.
- [ ] `forge.config.js`→`forge.config.ts` (or keep .js minimal): drop plugin-vite, point `main` at `.bun/build/main.js`, hook prePackage → `bun scripts/build.ts && bun scripts/build-backend.ts`.
- [ ] Remove vite configs/deps; `bun install` to produce `bun.lock`; delete `package-lock.json`.
- [ ] Gate: `bun run start` opens app against built renderer; `bun scripts/build-backend.ts` produces working binary (`./resources/taskboard` + curl health). Commit.

### Task 8: Makefile, CI, docs, delete Python, final verification
- [ ] Makefile: `check` = `cd backend && bun run check`; `build-backend` = bun compile; install-deps = `bun install` both dirs; remove uv/pyinstaller targets.
- [ ] `.github/workflows/ci.yml`: `oven-sh/setup-bun@v2`; backend job `cd backend && bun install && bun run check`; frontend job bun install/lint/format/test/build.
- [ ] Update `AGENTS.md`, `README.md`, `README.zh.md`, `docs/` command references.
- [ ] Delete all Python sources + uv/pytest/ruff config (list in File Structure section).
- [ ] Final gate: backend `bun run check` (tsc + tests + coverage ≥90%), frontend lint/format/test/build:check, compiled binary smoke test, `git status` shows no stray Python. Commit.

## Self-Review Notes
- Spec coverage: every Python module and test file is assigned to a task; frontend files enumerated; toolchain (build/run/compile) covered by Tasks 1, 7, 8.
- Known risk areas called out: pytest monkeypatching → injectable seams (Task 3/5); Slack/Feishu SDK API differences (Task 5); electron-forge without plugin-vite (Task 7). Each has a verification gate that must pass before moving on.
- Adaptation note: per-step full code listings are intentionally replaced by "Python source = spec + ported tests = acceptance" because the migration's source of truth already exists in-repo; embedding 24k lines of code in the plan would duplicate the spec without adding safety.
