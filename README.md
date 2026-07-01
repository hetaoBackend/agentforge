# AgentForge

**A local-first macOS command center for running Claude Code and OpenAI Codex CLI as schedulable, observable tasks.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/Platform-macOS%2012%2B-lightgrey?logo=apple)](../../releases)
[![Bun 1.3+](https://img.shields.io/badge/Bun-1.3%2B-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](https://www.typescriptlang.org)

AgentForge turns agent work into a visible local workflow: queue tasks, watch live runs, schedule recurring checks, route tasks from chat, and distill repeated patterns into reusable skills.

**Website:** https://agentforge-landing-weld.vercel.app/

![AgentForge task board preview](assets/readme-preview.svg)

## Why AgentForge

- **Stop babysitting terminals.** Create tasks once, then monitor queue, running, and done states from a kanban board.
- **Run the right agent per job.** Use Claude Code or Codex CLI on each task, with a configurable default.
- **Make agent work repeatable.** Schedule immediate, delayed, one-time, or cron tasks, then reuse successful patterns through the Skill Library.
- **Keep execution local.** The backend listens on `127.0.0.1`, stores state in SQLite, and runs agent CLIs on your Mac.

## Quick Start

### Install The App

1. Download the latest `AgentForge-*.dmg` from [Releases](../../releases).
2. Drag **AgentForge** into `/Applications`.
3. Launch it, choose a working directory, and create your first task.

### Run From Source

```bash
git clone https://github.com/hetaoBackend/agentforge.git
cd agentforge/taskboard-electron

bun install --ignore-scripts
bun run start
```

The Electrobun dev command builds the renderer, starts the Bun backend in the desktop host, and relaunches the app while you work.

### Build A DMG

```bash
cd taskboard-electron
bun run make
```

The packaged app is built by Electrobun. Stable macOS builds write the DMG under `taskboard-electron/build/stable-macos-arm64/`.

## What You Can Do

| Area | What it gives you |
| --- | --- |
| **Tasks** | Kanban queue for pending, scheduled, blocked, running, completed, failed, and cancelled work. |
| **Scheduling** | Immediate, delayed, `scheduled_at`, and cron schedules with max-run limits. |
| **Live output** | Structured stream output from Claude Code or Codex CLI, persisted per run. |
| **Heartbeats** | Recurring checks that can decide whether to trigger, resume, or notify. |
| **Skill Library** | Pattern detection across completed runs, editable `SKILL.md` drafts, and native skill installation. |
| **Chat channels** | Telegram, Slack, Feishu/Lark, and WeChat adapters for creating or tracking tasks from chat. |
| **DAG pipelines** | Task dependencies, failure propagation, and upstream result injection for multi-agent workflows. |

## Requirements

- macOS 12+
- [Bun](https://bun.sh) 1.3+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) or [OpenAI Codex CLI](https://github.com/openai/codex) on `PATH`

## Skill Library

The Skill Library turns repeated work into reusable agent skills.

1. **Detect** recurring recipes and pitfalls across completed task runs.
2. **Distill** useful patterns into standard `SKILL.md` drafts.
3. **Approve** the draft before anything is installed.
4. **Deliver** approved skills to `~/.agentforge/skills`, symlinked into `~/.claude/skills` and `~/.agents/skills`.

The automatic sweep is off by default because it spends tokens. Enable it in Settings, or run a manual scan from the Skills tab.

## Architecture

```text
┌─────────────────────┐        HTTP/JSON        ┌─────────────────────┐
│ Electrobun + React  │  <--------------------> │ Bun TypeScript API  │
│ Task board renderer │      127.0.0.1:9712     │ Scheduler + runner  │
└─────────────────────┘                         └──────────┬──────────┘
                                                            │
                                      ┌─────────────────────┼─────────────────────┐
                                      │                     │                     │
                                  SQLite              TaskScheduler         AgentExecutor
                              ~/.agentforge           cron + delayed       claude / codex
```

- `taskboard-electron/src/electrobun/main.ts` starts and stops the backend with the desktop app.
- `taskboard-electron/src/renderer/App.tsx` renders the task board, heartbeats, settings, and skills.
- `backend/taskboard.ts` serves the REST API through `Bun.serve`.
- `backend/src/db.ts` stores tasks, runs, output events, settings, heartbeats, and skills in SQLite.
- `backend/src/executor.ts` runs Claude Code or Codex CLI and persists streaming output.
- `backend/src/scheduler.ts` polls for due tasks and handles schedules, heartbeats, and skill sweeps.

## API Quick Example

All API routes are served at `http://127.0.0.1:9712/api`.

```bash
curl -X POST http://127.0.0.1:9712/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Review auth changes",
    "prompt": "Review the latest auth module diff for regressions and missing tests.",
    "working_dir": "~/projects/myapp",
    "schedule_type": "immediate",
    "agent": "codex"
  }'
```

Common task endpoints:

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/tasks` | List tasks |
| `POST` | `/api/tasks` | Create a task |
| `GET` | `/api/tasks/:id` | Read one task |
| `POST` | `/api/tasks/:id/cancel` | Cancel a task |
| `POST` | `/api/tasks/:id/retry` | Retry a failed task |
| `GET` | `/api/tasks/:id/events` | Read structured output events |
| `GET` | `/api/health` | Backend health check |

## Chat Channels

Channels are optional. They let teammates create tasks or receive updates from the tools where they already talk.

| Channel | Transport | Notes |
| --- | --- | --- |
| Telegram | Bot API polling | Simple bot token setup. |
| Slack | Socket Mode | Uses bot and app-level tokens. |
| Feishu / Lark | WebSocket long connection | No public IP required. |
| WeChat | Local bridge | Experimental text-only bridge. |

Channel adapters live in `backend/src/channels/` and can be configured from the app settings page or REST endpoints.

## Multi-Agent Pipelines

AgentForge ships with `skills/agentforge/`, a Claude Code skill that lets one task create and manage other AgentForge tasks.

That enables fan-out research, fan-in summaries, dependency gates, upstream result injection, and scheduled sub-workflows.

```text
User
  |
  v
Task A --creates--> Task B
  |                 Task C
  |                   |
  `------depends------v
                   Task D
```

Install the bundled skill:

```bash
ln -s /path/to/agentforge/skills/agentforge ~/.claude/skills/agentforge
```

## Development

Backend:

```bash
cd backend
bun taskboard.ts
```

Desktop app:

```bash
cd taskboard-electron
bun run start
```

Quality gates:

```bash
# Backend CI gate
make check

# Frontend CI gate
cd taskboard-electron
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build:check
```

## Troubleshooting

If `bun install` or `bun run build:check` stalls while downloading Electrobun artifacts, use the npm registry mirror:

```bash
cd taskboard-electron
bun install --registry https://registry.npmmirror.com
```

More setup notes live in [docs/installation-troubleshooting.md](docs/installation-troubleshooting.md).

## Contributing

1. Fork the repository and create a feature branch.
2. Run the app in development mode with `cd taskboard-electron && bun run start`.
3. Keep changes scoped and run the relevant quality gate before opening a PR.

Key files:

- `backend/` - Bun/TypeScript backend, scheduler, executor, API, and channels.
- `taskboard-electron/src/electrobun/main.ts` - Electrobun Bun main process.
- `taskboard-electron/src/renderer/App.tsx` - React renderer.
- `skills/agentforge/` - bundled skill for agent-to-agent delegation.

## License

MIT - see [LICENSE](LICENSE).
