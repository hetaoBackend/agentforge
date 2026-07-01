# Requirements Baseline

## Goal
Migrate AgentForge's desktop shell from Electron/electron-forge to Electrobun while keeping the existing Bun TypeScript backend, React renderer, and loopback HTTP API behavior intact.

## Non-goals
- Do not redesign the React application.
- Do not change the REST API contract or backend database schema for the shell migration.
- Do not touch unrelated channel behavior, including the existing uncommitted Telegram polling changes.
- Do not add Node/npm tooling; Bun remains the only project toolchain.

## User-visible Behavior
- `cd taskboard-electron && bun run start` launches an Electrobun desktop app.
- The app still renders the AgentForge task board and talks to `http://127.0.0.1:9712/api`.
- The native directory picker used by task creation/settings still works.
- The backend starts and stops with the desktop app.
- Packaged artifacts are produced by Electrobun rather than electron-forge.

## Acceptance Criteria
- Package scripts no longer use Electron/electron-forge for start/build/package/make.
- The app has a valid `electrobun.config.ts`.
- The Electrobun Bun main process starts `runServer(9712)` in-process and stops it on quit.
- The renderer can install a native directory bridge backed by Electrobun RPC.
- Frontend typecheck, lint, format check, tests, and build check pass from `taskboard-electron/`.
- Backend `make check` passes if backend source is changed.
- Documentation and command references are updated away from Electron where they describe the migrated shell.

## Constraints
- TypeScript only.
- Bun for install, test, build, compile, and packaging.
- Preserve the loopback-only HTTP API model.
- Preserve current frontend payload types and UI behavior.
- Prefer small, testable helpers around shell/runtime differences.

## Assumptions
- "electronbun" means the Electrobun framework published as `electrobun` on npm.
- Electrobun `1.18.1` is the current stable package to target.
- The existing `taskboard-electron/` directory may keep its path during migration to avoid a broad rename in the first pass.
- Keeping `window.electronAPI.selectDirectory()` as a compatibility facade is acceptable while the underlying implementation moves to Electrobun.

## Open Questions
No blocking open questions for the first migration slice.

## Source Request
`这个项目从electron迁移成electronbun`

## Repo Context
- Current desktop app is in `taskboard-electron/`.
- Current Electron shell uses `src/main.ts`, `src/preload.ts`, `scripts/dev.ts`, `scripts/build.ts`, and `forge.config.js`.
- Backend exposes `runServer(port, dbPath)` from `backend/src/server.ts`, which can be started from Electrobun's Bun main process.
- Renderer currently calls `window.electronAPI?.selectDirectory()`.
- Existing uncommitted change: `backend/src/channels/telegram.ts`; unrelated and preserved.
