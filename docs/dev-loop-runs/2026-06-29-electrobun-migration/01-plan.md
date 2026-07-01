# Electrobun Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron desktop shell with an Electrobun shell while preserving AgentForge's Bun backend, React renderer, and REST API behavior.

**Architecture:** Electrobun's Bun main process becomes the desktop host and starts `backend/src/server.ts` in-process. The React renderer is bundled as an Electrobun view and keeps using the existing HTTP API. Native UI affordances such as directory selection are exposed through Electrobun RPC, initially behind the existing `window.electronAPI` compatibility facade.

**Tech Stack:** Bun, TypeScript, React 19, Electrobun 1.18.1, bun:test, ESLint, Prettier.

---

## Files and Responsibilities
- `taskboard-electron/electrobun.config.ts`: Electrobun app metadata, entrypoints, copied view assets/resources, packaging options.
- `taskboard-electron/src/electrobun/main.ts`: Electrobun Bun main process; starts/stops backend and creates the desktop window.
- `taskboard-electron/src/electrobun/paths.ts`: Testable packaged/dev resource path helpers.
- `taskboard-electron/src/electrobun/paths.test.ts`: Tests for dev and packaged path decisions.
- `taskboard-electron/src/renderer/nativeBridge.ts`: Testable compatibility facade for native APIs needed by the renderer.
- `taskboard-electron/src/renderer/nativeBridge.test.ts`: Tests for the directory selection facade.
- `taskboard-electron/src/renderer/electrobunBridge.ts`: Electrobun view-side RPC installation.
- `taskboard-electron/src/renderer/main.tsx`: Installs the Electrobun bridge before rendering.
- `taskboard-electron/src/electrobun/index.html`: Electrobun view HTML that references the built view entrypoint and copied CSS/assets.
- `taskboard-electron/package.json`: Replace Electron scripts/dependencies with Electrobun.
- `Makefile`, `README.md`, `README.zh.md`, `AGENTS.md`: Update command/docs references after the shell is migrated.
- `backend/src/skills.ts`: If needed, make skill-creator resource resolution accept an environment override for Electrobun packaging.

## Task Order

### Task 1: Native Bridge Compatibility Tests
- [ ] Write `nativeBridge.test.ts` covering directory result normalization and installing `window.electronAPI.selectDirectory`.
- [ ] Run `cd taskboard-electron && bun test src/renderer/nativeBridge.test.ts`; expected failure because the module does not exist yet.
- [ ] Implement `nativeBridge.ts`.
- [ ] Re-run the focused test and keep it passing.

### Task 2: Electrobun Path Helper Tests
- [ ] Write `paths.test.ts` covering dev root, packaged resource root, bridge resource path, and skill-creator env paths.
- [ ] Run `cd taskboard-electron && bun test src/electrobun/paths.test.ts`; expected failure because the module does not exist yet.
- [ ] Implement `paths.ts`.
- [ ] Re-run the focused test and keep it passing.

### Task 3: Electrobun Main Process and View Bridge
- [ ] Add `src/electrobun/main.ts` that starts `runServer(9712)`, creates a `BrowserWindow`, wires `selectDirectory` to `Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })`, and stops the backend on `before-quit`.
- [ ] Add `src/renderer/electrobunBridge.ts` that creates an Electrobun view RPC client and installs the compatibility facade.
- [ ] Import the bridge from `src/renderer/main.tsx`.
- [ ] Add `src/electrobun/index.html` for the Electrobun view.

### Task 4: Electrobun Config and Package Scripts
- [ ] Add `electrobun.config.ts` with app metadata, `build.bun.entrypoint`, one `main` view entrypoint, copied HTML/CSS/assets/resources, macOS icon config, and watch settings.
- [ ] Replace Electron/electron-forge scripts in `package.json` with `electrobun dev --watch`, `electrobun build`, and stable package scripts.
- [ ] Add `electrobun` dependency and remove Electron/electron-forge-only dependencies after build compatibility is verified.

### Task 5: Packaging Resource Follow-through
- [ ] Ensure the Weixin bridge is available to Electrobun packaging, either as a copied source entrypoint run by the bundled Bun runtime or a compiled sidecar built by a prebuild hook.
- [ ] Ensure the vendored `vendor/skill-creator` path resolves in Electrobun dev and packaged layouts.
- [ ] Add or update tests for any backend path helper changed.

### Task 6: Documentation and CI Command Updates
- [ ] Update README/README.zh/AGENTS/Makefile command references from Electron/electron-forge to Electrobun.
- [ ] Keep CI-quality command descriptions aligned with package scripts.
- [ ] Remove stale Electron troubleshooting docs or clearly mark them obsolete.

## Verification Strategy
- Focused red/green tests:
  - `cd taskboard-electron && bun test src/renderer/nativeBridge.test.ts`
  - `cd taskboard-electron && bun test src/electrobun/paths.test.ts`
- Frontend full gate:
  - `cd taskboard-electron && bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build:check`
- Backend gate if backend source changes:
  - `make check`
- Runtime smoke when feasible:
  - `cd taskboard-electron && bun run start`
  - Verify backend health: `curl http://127.0.0.1:9712/api/health`

## Risks and Assumptions
- Electrobun packages resources differently from Electron; path resolution must be explicit and tested.
- Keeping the renderer compatibility facade limits UI churn during the shell migration.
- Electrobun native file dialogs return arrays; the renderer expects a single directory or `null`.
- Weixin bridge and skill-creator resources are the main packaging risk because they were previously Forge `extraResource`s.

## Acceptance Mapping
- Requirements `Package scripts no longer use Electron`: Task 4 and Task 6.
- Requirements `valid electrobun.config.ts`: Task 4.
- Requirements `backend starts/stops with app`: Task 3.
- Requirements `directory picker works`: Task 1 and Task 3.
- Requirements `quality gates pass`: Verification Strategy and acceptance report.
