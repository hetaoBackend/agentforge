# AgentForge Channels

Channels are pluggable integrations that let you control AgentForge and receive
notifications from external messaging services.

---

## Telegram Channel

Control AgentForge through a Telegram bot: create tasks, list their status, and
receive automatic notifications when tasks complete or fail.

### 1. Create a Bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts.
3. Copy the **HTTP API token** BotFather gives you (looks like `123456789:ABCdef…`).

### 2. Get Your User ID (optional but recommended)

To restrict bot access to specific users, find your numeric Telegram user ID:

1. Start a chat with [@userinfobot](https://t.me/userinfobot) or [@getidsbot](https://t.me/getidsbot).
2. It will reply with your numeric user ID (e.g. `123456789`).

### 3. Configure Environment Variables

| Variable                  | Required | Description |
|---------------------------|----------|-------------|
| `TELEGRAM_BOT_TOKEN`      | ✅ Yes   | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USERS`  | No       | Comma-separated numeric user IDs that may use the bot. If not set, **anyone** who finds the bot can use it. |

Example:

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
export TELEGRAM_ALLOWED_USERS="123456789,987654321"
```

### 4. Install the Dependency

```bash
uv add python-telegram-bot
```

Or install all project dependencies (which now include it):

```bash
uv sync
```

### 5. Start AgentForge

```bash
uv run taskboard.py
```

If `TELEGRAM_BOT_TOKEN` is present in the environment, the Telegram channel
starts automatically. You will see:

```
[AgentForge] TELEGRAM_BOT_TOKEN detected — starting Telegram channel...
[Telegram] Bot thread started
[Telegram] Bot polling started
```

### 6. Available Bot Commands

| Command | Description |
|---------|-------------|
| `/newtask <title> \| <prompt>` | Create and queue a new immediate task |
| `/list` | List all tasks (up to 30) with their current status |
| `/status <task_id>` | Show detailed status of a specific task |
| `/cancel <task_id>` | Cancel a pending or running task |
| `/help` | Show command reference |

**Examples:**

```
/newtask Fix login bug | Investigate and fix the authentication error in src/auth.py

/newtask | Write a summary of all TODO comments across the codebase

/status 42

/cancel 7
```

> If only a prompt is provided (no `|` separator), the first 60 characters are
> used as the task title.

### 7. Notifications

When a task completes or fails, the bot sends a message to every Telegram chat
that has previously interacted with it during the current session.

**Completed:**
```
✅ Task #42 completed

Fix login bug

Authentication issue resolved. Updated JWT validation in auth.py…
```

**Failed:**
```
❌ Task #42 failed

Fix login bug

claude CLI error: timeout after 600s
```

### 8. Default Working Directory

By default tasks created via Telegram run in `~` (your home directory).
To change this, set a value in the AgentForge settings database:

```bash
curl -X POST http://127.0.0.1:9712/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"telegram_default_working_dir": "/path/to/your/project"}'
```

---

## Slack Channel

Control AgentForge through a Slack bot using Socket Mode (no public IP or ngrok required).
Create tasks, check status, and receive automatic thread replies when tasks complete or fail.

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App → From scratch**.
2. Give it a name (e.g. `AgentForge`) and select your workspace.

### 2. Configure Bot Permissions

Under **OAuth & Permissions → Scopes → Bot Token Scopes**, add:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mentions in channels |
| `chat:write` | Send messages |
| `im:history` | Read DMs |
| `im:read` | List DMs |
| `im:write` | Open DM conversations |

### 3. Enable Socket Mode

1. Go to **Socket Mode** in the left sidebar and toggle it on.
2. Under **App-Level Tokens**, click **Generate Token and Scopes**.
3. Name it (e.g. `agentforge-socket`), add the scope `connections:write`, and click **Generate**.
4. Copy the token — it starts with `xapp-`.

### 4. Subscribe to Events

Under **Event Subscriptions**, toggle on **Enable Events**, then under
**Subscribe to bot events** add:

- `app_mention` — to receive @bot mentions in channels
- `message.im` — to receive direct messages

### 5. Install the App

Under **OAuth & Permissions**, click **Install to Workspace** and copy the
**Bot User OAuth Token** (starts with `xoxb-`).

Invite the bot to any channels where you want to mention it:

```
/invite @AgentForge
```

### 6. Configure Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | ✅ Yes | Bot token from OAuth & Permissions (xoxb-…) |
| `SLACK_APP_TOKEN` | ✅ Yes | App-level token for Socket Mode (xapp-…) |
| `SLACK_ALLOWED_USERS` | No | Comma-separated Slack user IDs allowed to use the bot. If not set, **anyone** in your workspace can use it. |

Example:

```bash
export SLACK_BOT_TOKEN="xoxb-123456789-abcdefghijk"
export SLACK_APP_TOKEN="xapp-1-A1B2C3D4E5-xyz..."
export SLACK_ALLOWED_USERS="U012AB3CD,U098ZY7WX"
```

To find a user ID: click the user's profile → ⋮ menu → **Copy member ID**.

### 7. Install the Dependency

```bash
uv sync   # slack-sdk is already in pyproject.toml
```

### 8. Start AgentForge

```bash
uv run taskboard.py
```

If both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set, the Slack channel starts automatically:

```
[AgentForge] SLACK_BOT_TOKEN + SLACK_APP_TOKEN detected — starting Slack channel...
[Slack] Authenticated as user_id=U0123456789
[Slack] Socket Mode connected
```

### 9. Available Commands

Send these in a DM to the bot, or @mention the bot in a channel:

| Command | Description |
|---------|-------------|
| `newtask <title> \| <prompt>` | Create and queue a new immediate task |
| `list` | List all tasks (up to 20) with status |
| `status <task_id>` | Show detailed status of a specific task |
| `cancel <task_id>` | Cancel a pending or running task |
| `help` | Show command reference |

**Examples (DM or @mention):**

```
newtask Fix login bug | Investigate and fix the auth error in src/auth.py

@AgentForge list

@AgentForge status 42

cancel 7
```

### 10. Notifications

When you create a task with `newtask`, AgentForge remembers which Slack channel
and thread the request came from. When the task completes or fails it posts a
reply **in that same thread**:

**Completed:**
```
✅ Task #42 Fix login bug completed.
Result: Authentication issue resolved. Updated JWT validation in auth.py…
```

**Failed:**
```
❌ Task #42 Fix login bug failed.
Error: `claude CLI exit code 1`
```

---

## Adding New Channels

Create a new file under `channels/` that imports and subclasses `Channel` from
`taskboard_bus.py`:

```python
from taskboard_bus import Channel

class MyChannel(Channel):
    def start(self) -> None:
        ...

    def stop(self) -> None:
        ...

    def notify_task(self, task_id: int) -> None:
        # Called whenever a task status changes
        ...
```

Then instantiate it in `run_server()` inside `taskboard.py`, append it to
`scheduler._channels`, and call `channel.start()`.
