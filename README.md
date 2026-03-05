# AgentForge

A macOS desktop app for orchestrating AI coding agents. Manage, schedule, and monitor [Claude Code](https://docs.anthropic.com/en/docs/claude-code) tasks through a kanban-style task board — or remotely via Telegram, Slack, and Feishu.

## Features

- **Agents that spawn agents** — Built-in Claude Code skill lets any running task create sub-tasks, build DAG pipelines, and collect results — enabling recursive, multi-agent workflows
- **Kanban Task Board** — Column view: Queue, Running, Done
- **DAG Pipelines** — Define task dependencies with automatic cascade execution and failure propagation
- **Flexible Scheduling** — Immediate, delayed, one-time (datetime), and cron-based recurring tasks
- **Live Output Streaming** — Real-time colorized output from Claude Code CLI
- **Chat Channels** — Control AgentForge from Telegram, Slack, or Feishu
- **Persistent Storage** — SQLite-backed task history and configuration
- **Native macOS App** — Electron shell with one-click DMG install

## Architecture

```
┌──────────────────┐     HTTP/JSON      ┌──────────────────┐
│   React Frontend │ ◄────────────────► │  Python Backend   │
│   (Kanban UI)    │   localhost:9712    │  (Scheduler+API)  │
└──────────────────┘                    └───────┬──────────┘
                                                │
                                    ┌───────────┼───────────┐
                                    │           │           │
                                    ▼           ▼           ▼
                              ┌──────────┐ ┌────────┐ ┌──────────┐
                              │  SQLite  │ │Scheduler│ │ Claude   │
                              │  Store   │ │ (cron)  │ │ Code CLI │
                              └──────────┘ └────────┘ └──────────┘
```

The Electron main process spawns a single-file Python HTTP server on startup. The React renderer talks to it over `localhost:9712`. There is no WebSocket — all communication is REST polling.

## Requirements

- macOS 12.0+ (Apple Silicon or Intel)
- Python 3.12+
- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on `PATH`

## Quick Start

### Option 1: Desktop App (Recommended)

1. Download the latest `AgentForge-*.dmg` from the [Releases](../../releases) page.
2. Open the DMG and drag **AgentForge** into `/Applications`.
3. Launch from Launchpad or the Applications folder.

### Option 2: Development Mode

```bash
# Clone the repo
git clone https://github.com/anthropics/agentforge.git
cd agentforge

# Install Python dependencies
uv sync

# Install Electron dependencies
cd taskboard-electron && npm install && cd ..

# Start the backend
uv run taskboard.py

# In another terminal, start the Electron app
cd taskboard-electron && npm start
```

### Option 3: Build from Source

```bash
# Full build pipeline (backend binary + Electron + DMG)
make package-dmg

# Or step by step
make build-backend
make build-electron
make package-dmg
```

The output DMG lands at `taskboard-electron/out/make/AgentForge-1.0.0-arm64.dmg`.

## Claude Code Skill — Recursive Task Delegation

AgentForge ships with a **Claude Code skill** (`skills/agentforge/`). Once installed, any task running inside Claude Code can itself create, query, and manage other AgentForge tasks. This turns a single agent into an orchestrator that decomposes work, fans out sub-tasks, and collects results — recursively.

```
          User
           │
           ▼
     ┌───────────┐       create sub-tasks
     │  Task A    │──────────────────────┐
     │ (Claude)   │                      │
     └─────┬─────┘              ┌────────┴────────┐
           │                    ▼                  ▼
           │              ┌───────────┐     ┌───────────┐
           │              │  Task B   │     │  Task C   │
           │              │ (Claude)  │     │ (Claude)  │
           │              └─────┬─────┘     └───────────┘
           │                    │  create more sub-tasks
           │                    ▼
           │              ┌───────────┐
           │              │  Task D   │
           │              │ (Claude)  │
           │              └───────────┘
           ▼
     collect & summarize
```

### What the skill enables

- **Fan-out / fan-in** — A parent task spawns N independent sub-tasks in parallel, then polls until all complete and synthesizes results.
- **DAG pipelines** — Chain tasks with `--depends-on` so downstream steps auto-start only after upstream ones finish. Failed upstreams cascade-cancel the rest.
- **Result injection** — Pass `--inject-result` so upstream output is automatically prepended to the downstream prompt, giving each step full context.
- **Scheduled workflows** — Combine cron, delayed, and immediate schedules to build time-aware pipelines.

### Install the skill

Copy or symlink the skill directory into your Claude Code skills location:

```bash
# Example: symlink into ~/.claude/skills
ln -s /path/to/agentforge/skills/agentforge ~/.claude/skills/agentforge
```

Once installed, any Claude Code session (including tasks spawned by AgentForge itself) can call the skill to delegate work — enabling **agents that spawn agents**.

### Example: parallel research pipeline

A single prompt can kick off a multi-agent workflow:

```
Research the top 3 competitors of Acme Corp.
For each competitor, create a separate AgentForge task that:
  1. Gathers recent news and financials
  2. Writes a one-page summary
Then create a final task (depends-on the above 3) that
synthesizes everything into a comparative report.
```

AgentForge handles scheduling, dependency tracking, and result passing. The parent task only needs to create the DAG — the platform does the rest.

## Chat Channels

AgentForge supports pluggable chat channels so you can create tasks, check status, and receive completion notifications from your favorite messaging app.

| Channel | Transport | Setup |
|---------|-----------|-------|
| Telegram | Bot API (polling) | Easy |
| Slack | Socket Mode | Moderate |
| Feishu / Lark | Event Subscription | Moderate |

Channels auto-start when the corresponding environment variables are detected.

<details>
<summary><b>Telegram</b></summary>

### 1. Create a Bot

1. Open Telegram and chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the **HTTP API token** (looks like `123456789:ABCdef…`).

### 2. Get Your User ID (optional)

To restrict access, get your numeric user ID from [@userinfobot](https://t.me/userinfobot).

### 3. Configure

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
export TELEGRAM_ALLOWED_USERS="123456789,987654321"   # optional
```

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS` | No | Comma-separated user IDs. Unrestricted if empty. |

### 4. Run

```bash
uv run taskboard.py
```

You should see:

```
[AgentForge] TELEGRAM_BOT_TOKEN detected — starting Telegram channel...
[Telegram] Bot polling started
```

### 5. Commands

| Command | Description |
|---------|-------------|
| `/newtask <title> \| <prompt>` | Create a task |
| `/list` | List tasks |
| `/status <id>` | Task details |
| `/cancel <id>` | Cancel a task |
| `/help` | Show help |

</details>

<details>
<summary><b>Slack</b></summary>

### 1. Create a Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.

### 2. Bot Permissions

Under **OAuth & Permissions → Bot Token Scopes**, add:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `im:read`
- `im:write`
- `channel:history`
- `groups:write`
- `im:history`
- `mpim:write`
- `reactions:write`

### 3. Enable Socket Mode

1. Go to **Socket Mode** → toggle on.
2. Generate an **App-Level Token** with the `connections:write` scope.
3. Copy the token (starts with `xapp-`).

### 4. Subscribe to Events

Under **Event Subscriptions → Subscribe to bot events**, add:

- `app_mention`
- `message.im`
- `message.channels`

### 5. Install & Invite

Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).

```
/invite @AgentForge
```

### 6. Configure

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
export SLACK_ALLOWED_USERS="U012AB3CD,U098ZY7WX"   # optional
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Bot token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Yes | App-level token (`xapp-…`) |
| `SLACK_ALLOWED_USERS` | No | Comma-separated Slack user IDs |

### 7. Run

```bash
uv run taskboard.py
```

### 8. Commands

Send as a DM or @mention in a channel:

| Command | Description |
|---------|-------------|
| `newtask <title> \| <prompt>` | Create a task |
| `list` | List tasks |
| `status <id>` | Task details |
| `cancel <id>` | Cancel a task |
| `help` | Show help |

**Forwarded Messages**: You can forward any message from another chat to the bot. The bot will include the original sender and timestamp in the task context.

</details>

<details>
<summary><b>Feishu / Lark</b></summary>

Feishu uses the AgentForge **settings API** for configuration (not environment variables). It connects via WebSocket long-connection, so no public IP is needed.

### 1. Create a Feishu App

- Go to the [Feishu Open Platform](https://open.feishu.cn/app)
- Create a new app → Enable **Bot** capability
- Permissions: Add `im:message` (send messages), `im:resource` (download images)
- Events: Add `im.message.receive_v1` (receive messages)
- Select **Long Connection** mode (requires running AgentForge first to establish connection)
 - Get **App ID** and **App Secret** from "Credentials & Basic Info"
- Publish the app

### 2. Configure via Settings API

```bash
curl -X POST http://127.0.0.1:9712/api/feishu/settings \
  -H "Content-Type: application/json" \
  -d '{
    "feishu_app_id": "cli_xxxx",
    "feishu_app_secret": "your_app_secret",
    "feishu_default_working_dir": "~/projects",
    "feishu_enabled": "true"
  }'
```

| Setting | Required | Description |
|---------|----------|-------------|
| `feishu_app_id` | Yes | App ID from Feishu Open Platform |
| `feishu_app_secret` | Yes | App Secret |
| `feishu_default_chat_id` | No | Default chat for notifications (`oc_…` or `ou_…`) |
| `feishu_default_working_dir` | No | Working directory for tasks (default `~`) |
| `feishu_enabled` | Yes | Set to `"true"` to activate |

The channel restarts automatically when you POST new settings. You can also configure it from the AgentForge desktop app settings page.

### 3. Usage

Send any message to the bot in a DM or group chat to create a task. Supports text messages, rich-text posts, and images. Reply in a thread to resume a completed task's session.

**Forwarded Messages**: You can forward or quote messages from other chats. The bot will parse forwarded/quoted content and include the original sender name, timestamp, and message text in the task context.

| Command | Description |
|---------|-------------|
| *(any message)* | Create a new task from the message content |
| *(forwarded message)* | Create a task with forwarded content context |
| `/status <id>` | Show task status |
| `/resume <id> <message>` | Resume a task session |

</details>

> [!TIP]
> See [`channels/README.md`](channels/README.md) for full setup details, notification behavior, and how to add custom channels.

## API Reference

All endpoints are served at `http://127.0.0.1:9712/api`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List all tasks |
| GET | `/api/tasks/:id` | Get a single task |
| GET | `/api/tasks/:id/runs` | Get run history |
| GET | `/api/tasks/:id/output` | Get task output |
| GET | `/api/tasks/:id/events` | Stream output events |
| POST | `/api/tasks` | Create a task |
| POST | `/api/tasks/:id/cancel` | Cancel a task |
| POST | `/api/tasks/:id/retry` | Retry a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/health` | Health check |

### Create Task Examples

```bash
# Immediate execution
curl -X POST http://localhost:9712/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Code review",
    "prompt": "Review the code changes in this directory",
    "working_dir": "~/projects/myapp",
    "schedule_type": "immediate"
  }'

# Delayed execution (5 minutes)
curl -X POST http://localhost:9712/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Delayed review",
    "prompt": "Review recent commits",
    "working_dir": "~/projects/myapp",
    "schedule_type": "delayed",
    "delay_seconds": 300
  }'

# Cron schedule (daily at 9 AM)
curl -X POST http://localhost:9712/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Daily digest",
    "prompt": "Summarize TODO comments across the codebase",
    "working_dir": "~/projects/myapp",
    "schedule_type": "cron",
    "cron_expr": "0 9 * * *",
    "max_runs": 30
  }'
```

## Background Service (launchd)

To keep the backend running persistently on macOS:

```xml
<!-- ~/Library/LaunchAgents/com.agentforge.taskboard.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentforge.taskboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/path/to/taskboard.py</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/taskboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/taskboard.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.agentforge.taskboard.plist
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
