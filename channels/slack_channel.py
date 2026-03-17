"""
AgentForge Slack Channel

Listens for @bot mentions and DMs via Slack Socket Mode (no public IP required).
Send any message to create a task; reply to a completion notification to resume.
Slash commands (/status, /cancel, /resume) are also supported.

Required environment variables:
  SLACK_BOT_TOKEN   — xoxb-... bot token
  SLACK_APP_TOKEN   — xapp-... app-level token (for Socket Mode)
"""

import os
import json
import threading
import traceback
from typing import TYPE_CHECKING, Optional

from taskboard_bus import Channel, MessageBus, OutboundMessage, OutboundMessageType

if TYPE_CHECKING:
    from taskboard import TaskDB, TaskScheduler


def _require_slack():
    try:
        from slack_sdk import WebClient
        from slack_sdk.socket_mode import SocketModeClient
        from slack_sdk.socket_mode.response import SocketModeResponse
        from slack_sdk.socket_mode.request import SocketModeRequest
        return WebClient, SocketModeClient, SocketModeResponse, SocketModeRequest
    except ImportError as e:
        raise ImportError(
            "slack-sdk is required for SlackChannel. "
            "Install it with: uv add slack-sdk"
        ) from e


HELP_TEXT = """\
*AgentForge Bot* 👋
Send me any message and I'll create a task from it.
Reply to a completion/failure notification to resume that task.

*Commands:*
• `/status <id>` — show task details
• `/cancel <id>` — cancel a task
• `/resume <id> <message>` — resume a task with a message
• `/dir <path>` — set default working directory
　　e.g. `/dir ~/workspace/myproject`
• `/agent <name>` — switch coding agent (`claude` / `codex`)
• `/help` — show this message

*Tips:*
• You can also mention a path in your message and it will be used automatically.
　e.g. _在 ~/myapp 里帮我修复登录 bug_
• Reply to any result notification to continue the conversation.
"""


class SlackChannel(Channel):
    """Slack channel integration using Socket Mode."""

    def __init__(self, bus: MessageBus, db: "TaskDB", scheduler: "TaskScheduler",
                 bot_token: str = "", app_token: str = ""):
        super().__init__("slack", bus, db)
        self.scheduler = scheduler

        self.bot_token = bot_token or os.environ.get("SLACK_BOT_TOKEN", "")
        self.app_token = app_token or os.environ.get("SLACK_APP_TOKEN", "")

        self._web_client = None
        self._socket_client = None
        self._bot_user_id: Optional[str] = None

        # Maps task_id → (channel_id, thread_ts, reaction_ts) for reply-back on completion
        # thread_ts: used for posting reply messages in the correct thread
        # reaction_ts: used for adding emoji reactions (may differ from thread_ts on resume)
        self._task_origin: dict[int, tuple[str, Optional[str], Optional[str]]] = {}
        self._origin_lock = threading.Lock()

        # DM channel cache for P2P fallback
        self._dm_channel_cache: dict[str, str] = {}  # user_id → DM channel_id

        # Maps notification thread_ts → task_id for resume-by-reply
        self._notification_map: dict[str, int] = {}
        self._notification_lock = threading.Lock()

        # Maps thread root ts → task_id for thread-based session resume
        self._thread_ts_map: dict[str, int] = {}
        self._thread_ts_lock = threading.Lock()

        # Subscribe to outbound bus messages for task notifications
        bus.subscribe_outbound(self._on_outbound)

        print(f"[Slack] Initialized. bot_token={'set' if self.bot_token else 'MISSING'}, "
              f"app_token={'set' if self.app_token else 'MISSING'}")

    # ── lifecycle ────────────────────────────────────────────────

    def start(self) -> None:
        if not self.bot_token or not self.app_token:
            print("[Slack] Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN — channel disabled")
            return

        print("[Slack] Starting... importing slack_sdk")
        WebClient, SocketModeClient, SocketModeResponse, SocketModeRequest = _require_slack()
        print("[Slack] slack_sdk imported successfully")

        self._web_client = WebClient(token=self.bot_token)
        print("[Slack] WebClient created, calling auth_test()...")

        # Resolve bot's own user ID so we can ignore self-messages
        try:
            resp = self._web_client.auth_test()
            self._bot_user_id = resp["user_id"]
            print(f"[Slack] auth_test OK — bot_user_id={self._bot_user_id}, team={resp.get('team', '?')}, user={resp.get('user', '?')}")
        except Exception as e:
            print(f"[Slack] auth_test FAILED: {e}")
            traceback.print_exc()
            return

        print("[Slack] Creating SocketModeClient...")
        self._socket_client = SocketModeClient(
            app_token=self.app_token,
            web_client=self._web_client,
        )

        # Register event handler
        self._socket_client.socket_mode_request_listeners.append(self._handle_socket_request)
        print("[Slack] Registered socket_mode_request_listeners")

        self._running = True
        print("[Slack] Calling socket_client.connect()...")
        self._socket_client.connect()
        print("[Slack] Socket Mode connected — listening for events")

    def stop(self) -> None:
        print("[Slack] Stopping...")
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
        if self._socket_client:
            try:
                self._socket_client.disconnect()
            except Exception:
                pass
        print("[Slack] Stopped")

    # ── socket mode handler ──────────────────────────────────────

    def _handle_socket_request(self, client, req) -> None:
        from slack_sdk.socket_mode.response import SocketModeResponse

        print(f"[Slack] <<< Socket request received: type={req.type}, envelope_id={req.envelope_id[:12]}...")

        # Acknowledge immediately (Slack requires < 3s ack)
        client.send_socket_mode_response(SocketModeResponse(envelope_id=req.envelope_id))
        print(f"[Slack]     ACK sent for envelope {req.envelope_id[:12]}")

        if req.type != "events_api":
            print(f"[Slack]     Ignoring non-events_api request type: {req.type}")
            return

        payload = req.payload
        event = payload.get("event", {})
        event_type = event.get("type", "")

        print(f"[Slack]     Event type={event_type}, "
              f"user={event.get('user', '?')}, "
              f"channel={event.get('channel', '?')}, "
              f"channel_type={event.get('channel_type', '?')}, "
              f"bot_id={event.get('bot_id', 'none')}, "
              f"subtype={event.get('subtype', 'none')}, "
              f"text={repr((event.get('text', '') or '')[:80])}")

        # Handle message events
        try:
            if event_type == "message":
                self._handle_message_event(event)
            elif event_type == "app_mention":
                self._handle_mention_event(event)
            elif event_type == "app_home_opened":
                self._handle_app_home_opened(event)
            else:
                print(f"[Slack]     Unhandled event type: {event_type}")
        except Exception as e:
            print(f"[Slack] ERROR handling {event_type} event: {e}")
            traceback.print_exc()

    def _handle_message_event(self, event: dict) -> None:
        """Handle DM messages (channel_type == 'im')."""
        # Only process DMs, not channel messages (those come via app_mention)
        if event.get("channel_type") != "im":
            print(f"[Slack]     message event skipped: channel_type={event.get('channel_type')!r} (not 'im')")
            return
        # Ignore bot messages and message edits
        if event.get("bot_id") or event.get("subtype"):
            print(f"[Slack]     message event skipped: bot_id={event.get('bot_id')}, subtype={event.get('subtype')}")
            return

        user_id = event.get("user", "")
        if user_id == self._bot_user_id:
            print(f"[Slack]     message event skipped: message from self (bot)")
            return

        text = event.get("text", "").strip()
        channel_id = event.get("channel", "")
        thread_ts = event.get("thread_ts")
        msg_ts = event.get("ts")

        print(f"[Slack]     DM from user={user_id}, channel={channel_id}, text={repr(text[:80])}")
        self._handle_user_message(text, channel_id, thread_ts, msg_ts)

    def _handle_mention_event(self, event: dict) -> None:
        """Handle @bot mentions in channels."""
        if event.get("bot_id") or event.get("subtype"):
            print(f"[Slack]     mention event skipped: bot_id={event.get('bot_id')}, subtype={event.get('subtype')}")
            return

        user_id = event.get("user", "")
        if user_id == self._bot_user_id:
            print(f"[Slack]     mention event skipped: mention from self (bot)")
            return

        # Strip the mention prefix (<@BOTID> ...) from the text
        text = event.get("text", "").strip()
        if self._bot_user_id:
            mention_prefix = f"<@{self._bot_user_id}>"
            if text.startswith(mention_prefix):
                text = text[len(mention_prefix):].strip()

        channel_id = event.get("channel", "")
        thread_ts = event.get("thread_ts")
        msg_ts = event.get("ts")

        print(f"[Slack]     Mention from user={user_id}, channel={channel_id}, text={repr(text[:80])}")
        self._handle_user_message(text, channel_id, thread_ts, msg_ts)

    def _handle_app_home_opened(self, event: dict) -> None:
        """Handle app_home_opened event — send HELP_TEXT DM on first open."""
        user_id = event.get("user", "")
        if not user_id or user_id == self._bot_user_id:
            return
        # Only send on the first open (tab == "home", not "messages")
        tab = event.get("tab", "")
        if tab != "home":
            return
        print(f"[Slack]     app_home_opened by user={user_id}, sending HELP_TEXT via DM")
        dm_ch = self._open_dm_channel(user_id)
        if dm_ch:
            self._reply(dm_ch, None, HELP_TEXT)
        else:
            print(f"[Slack]     Failed to open DM channel with user {user_id}")

    # ── unified message handler ───────────────────────────────────

    def _handle_user_message(self, text: str, channel_id: str,
                             thread_ts: Optional[str], msg_ts: str) -> None:
        """Handle any user message: commands, resume-by-reply, or create task."""
        if not text:
            self._reply(channel_id, msg_ts, HELP_TEXT)
            return

        # ── slash commands ────────────────────────────────────────
        if text.startswith("/"):
            parts = text.split(None, 1)
            cmd = parts[0].lower()
            args = parts[1].strip() if len(parts) > 1 else ""

            if cmd == "/status":
                self._cmd_status(args, channel_id, msg_ts)
            elif cmd == "/cancel":
                self._cmd_cancel(args, channel_id, msg_ts)
            elif cmd == "/resume":
                self._cmd_resume(args, channel_id, msg_ts)
            elif cmd in ("/dir", "/cd"):
                from channels.dir_utils import handle_dir_command
                reply = handle_dir_command(text, "slack", self.db)
                self._reply(channel_id, msg_ts, reply or HELP_TEXT)
            elif cmd == "/agent":
                from channels.agent_utils import handle_agent_command
                reply = handle_agent_command(text, "slack", self.db)
                self._reply(channel_id, msg_ts, reply or HELP_TEXT)
            elif cmd == "/help":
                self._reply(channel_id, msg_ts, HELP_TEXT)
            else:
                self._reply(channel_id, msg_ts, HELP_TEXT)
            return

        if text.lower() == "help":
            self._reply(channel_id, msg_ts, HELP_TEXT)
            return

        # ── reply to a notification thread → resume task ──────────
        if thread_ts:
            # Look up task_id: first from notification_map, then from thread_ts_map
            with self._notification_lock:
                task_id = self._notification_map.get(thread_ts)
            if not task_id:
                with self._thread_ts_lock:
                    task_id = self._thread_ts_map.get(thread_ts)
            if task_id:
                task = self.db.get_task(task_id)
                if task and task.get("session_id"):
                    self.db.update_task(
                        task_id,
                        status="pending",
                        prompt=text,
                        result=None,
                        error=None,
                        question=None,
                    )
                    with self._origin_lock:
                        self._task_origin[task_id] = (channel_id, thread_ts, msg_ts)
                    self._add_reaction(channel_id, msg_ts, "eyes")
                    self._reply(
                        channel_id, thread_ts,
                        ":arrow_forward:"
                    )
                    print(f"[Slack] Auto-resuming task {task_id} from thread reply")
                    return
                else:
                    self._reply(
                        channel_id, thread_ts,
                        f":x: Task *#{task_id}* has no saved session to resume."
                    )
                    return

        # ── default: create a new task from message text ──────────
        self._create_task(text, channel_id, msg_ts)

    # ── task creation ─────────────────────────────────────────────

    def _create_task(self, text: str, channel_id: str, thread_ts: str) -> None:
        """Create a new task from any message."""
        from taskboard import Task, ScheduleType

        title = text[:60] + ("…" if len(text) > 60 else "")
        from channels.dir_utils import resolve_working_dir
        from channels.agent_utils import resolve_agent
        task = Task(
            title=f"[Slack] {title}",
            prompt=text,
            working_dir=resolve_working_dir(text, "slack", self.db),
            schedule_type=ScheduleType.IMMEDIATE,
            tags="slack",
            agent=resolve_agent("slack", self.db),
        )
        task_id = self.scheduler.submit_task(task)
        print(f"[Slack] Task #{task_id} created from message")

        with self._origin_lock:
            self._task_origin[task_id] = (channel_id, thread_ts, thread_ts)
            print(f"[Slack] Origin set for task #{task_id}: channel={channel_id}, thread_ts={thread_ts}, "
                  f"self_id={id(self)}, origin_dict_id={id(self._task_origin)}")

        # Track thread root ts → task_id so replies in the thread can resume
        with self._thread_ts_lock:
            self._thread_ts_map[thread_ts] = task_id

        # Acknowledge with an eyes reaction and a brief running hint
        self._add_reaction(channel_id, thread_ts, "eyes")
        self._reply(channel_id, thread_ts, f"Task #{task_id} is running…")

    # ── commands ──────────────────────────────────────────────────

    def _cmd_status(self, args: str, channel_id: str, thread_ts: str) -> None:
        task_id = self._parse_task_id(args)
        if task_id is None:
            self._reply(channel_id, thread_ts, ":warning: Usage: `/status <task_id>`")
            return

        task = self.db.get_task(task_id)
        if not task:
            self._reply(channel_id, thread_ts, f":x: Task #{task_id} not found.")
            return

        status_emoji = {
            "pending": ":hourglass:",
            "scheduled": ":calendar:",
            "running": ":runner:",
            "completed": ":white_check_mark:",
            "failed": ":x:",
            "cancelled": ":no_entry_sign:",
        }
        emoji = status_emoji.get(task["status"], ":grey_question:")
        lines = [
            f"{emoji} *Task #{task['id']}* — *{task['title']}*",
            f"Status: `{task['status']}`",
            f"Created: {task.get('created_at', '—')}",
            f"Last run: {task.get('last_run_at') or '—'}",
        ]
        if task.get("error"):
            lines.append(f"Error: `{task['error'][:300]}`")
        if task.get("result"):
            lines.append(f"Result: {task['result'][:500]}")

        self._reply(channel_id, thread_ts, "\n".join(lines))

    def _cmd_cancel(self, args: str, channel_id: str, thread_ts: str) -> None:
        task_id = self._parse_task_id(args)
        if task_id is None:
            self._reply(channel_id, thread_ts, ":warning: Usage: `/cancel <task_id>`")
            return

        task = self.db.get_task(task_id)
        if not task:
            self._reply(channel_id, thread_ts, f":x: Task #{task_id} not found.")
            return

        if task["status"] in ("completed", "failed", "cancelled"):
            self._reply(
                channel_id, thread_ts,
                f":information_source: Task #{task_id} is already `{task['status']}`."
            )
            return

        self.db.update_task(task_id, status="cancelled")
        self._reply(channel_id, thread_ts, f":no_entry_sign: Task #{task_id} cancelled.")

    def _cmd_resume(self, args: str, channel_id: str, thread_ts: str) -> None:
        parts = args.strip().split(" ", 1)
        if not parts or not parts[0].lstrip("#").isdigit():
            self._reply(channel_id, thread_ts, ":warning: Usage: `/resume <task_id> <message>`")
            return

        tid = int(parts[0].lstrip("#"))
        resume_msg = parts[1].strip() if len(parts) > 1 else ""
        if not resume_msg:
            self._reply(channel_id, thread_ts, ":warning: Please provide a message to resume with.")
            return

        task = self.db.get_task(tid)
        if not task or not task.get("session_id"):
            self._reply(channel_id, thread_ts, f":x: Task #{tid} not found or has no saved session.")
            return

        self.db.update_task(
            tid,
            status="pending",
            prompt=resume_msg,
            result=None,
            error=None,
            question=None,
        )
        with self._origin_lock:
            self._task_origin[tid] = (channel_id, thread_ts, thread_ts)
        self._add_reaction(channel_id, thread_ts, "eyes")
        self._reply(channel_id, thread_ts, ":arrow_forward:")

    # ── Channel ABC: send outbound message ───────────────────────

    def send(self, msg: OutboundMessage) -> None:
        """Forward task completion/failure to the originating Slack thread."""
        if msg.type not in (OutboundMessageType.TASK_COMPLETED, OutboundMessageType.TASK_FAILED):
            return

        task_id = msg.task_id
        with self._origin_lock:
            origin = self._task_origin.get(task_id)
            print(f"[Slack] send() task_id={task_id} (type={type(task_id).__name__}), "
                  f"origin={origin}, keys={list(self._task_origin.keys())}, "
                  f"self_id={id(self)}, origin_dict_id={id(self._task_origin)}")

        # Build notification text
        if msg.type == OutboundMessageType.TASK_COMPLETED:
            result_text = (msg.payload.get("result") or "").strip()[:10000]
            title = msg.payload.get("title") or f"Task #{task_id}"
            text = result_text or "Done."
        else:
            error_text = (msg.payload.get("error") or "Unknown error").strip()[:800]
            title = msg.payload.get("title") or f"Task #{task_id}"
            text = error_text

        if origin:
            channel_id, thread_ts, reaction_ts = origin
            # Add emoji reaction to the message that triggered the task (or resume)
            react_target = reaction_ts or thread_ts
            if msg.type == OutboundMessageType.TASK_COMPLETED:
                self._add_reaction(channel_id, react_target, "white_check_mark")
            else:
                self._add_reaction(channel_id, react_target, "x")
        else:
            # Fallback: P2P DM to configured user, or default channel
            dm_user = self.db.get_setting("slack_default_user")
            default_channel = self.db.get_setting("slack_default_channel")
            if dm_user:
                dm_ch = self._open_dm_channel(dm_user)
                if dm_ch:
                    channel_id = dm_ch
                    thread_ts = None
                    status_emoji = ":white_check_mark:" if msg.type == OutboundMessageType.TASK_COMPLETED else ":x:"
                    text = f"{status_emoji} *{title}*\n{text}"
                    print(f"[Slack] Falling back to P2P DM with user {dm_user}")
                else:
                    print(f"[Slack] Failed to open DM with user {dm_user}, skipping")
                    return
            elif default_channel:
                channel_id = default_channel
                thread_ts = None
                status_emoji = ":white_check_mark:" if msg.type == OutboundMessageType.TASK_COMPLETED else ":x:"
                text = f"{status_emoji} *{title}*\n{text}"
            else:
                print(f"[Slack] No origin, no known user, no slack_default_channel for task #{task_id}, skipping")
                return

        print(f"[Slack] Sending outbound notification for task #{task_id}: {msg.type.name}")

        def _send_and_track():
            sent_ts = self._reply_return_ts(channel_id, thread_ts, text)
            if sent_ts:
                with self._notification_lock:
                    self._notification_map[sent_ts] = task_id
                print(f"[Slack] Notification ts={sent_ts} mapped to task #{task_id}")

        threading.Thread(target=_send_and_track, daemon=True).start()

        # Free origin memory after terminal state
        with self._origin_lock:
            self._task_origin.pop(task_id, None)

    def _on_outbound(self, msg: OutboundMessage) -> None:
        """MessageBus outbound subscriber callback."""
        self.send(msg)

    # ── helpers ──────────────────────────────────────────────────

    def _open_dm_channel(self, user_id: str) -> Optional[str]:
        """Open (or retrieve cached) DM channel with a user."""
        if user_id in self._dm_channel_cache:
            return self._dm_channel_cache[user_id]
        if not self._web_client:
            return None
        try:
            resp = self._web_client.conversations_open(users=[user_id])
            ch_id = resp["channel"]["id"]
            self._dm_channel_cache[user_id] = ch_id
            print(f"[Slack] Opened DM channel {ch_id} with user {user_id}")
            return ch_id
        except Exception as e:
            print(f"[Slack] conversations.open failed for user {user_id}: {e}")
            return None

    def _add_reaction(self, channel_id: str, timestamp: str, emoji: str) -> None:
        """Add an emoji reaction to a message (non-blocking)."""
        if not self._web_client:
            return

        def _do():
            try:
                self._web_client.reactions_add(
                    channel=channel_id,
                    timestamp=timestamp,
                    name=emoji,
                )
            except Exception as e:
                if "already_reacted" in str(e):
                    pass  # Reaction already exists, ignore
                else:
                    print(f"[Slack] Failed to add reaction {emoji}: {e}")

        threading.Thread(target=_do, daemon=True).start()

    def _reply(self, channel_id: str, thread_ts: Optional[str], text: str) -> None:
        if not self._web_client:
            print(f"[Slack] _reply skipped: no web_client")
            return
        try:
            print(f"[Slack] >>> Sending message to channel={channel_id}, thread={thread_ts}, len={len(text)}")
            self._web_client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=text,
                mrkdwn=True,
            )
            print(f"[Slack] >>> Message sent OK")
        except Exception as e:
            print(f"[Slack] >>> chat_postMessage FAILED: {e}")
            traceback.print_exc()

    def _reply_return_ts(self, channel_id: str, thread_ts: Optional[str], text: str) -> Optional[str]:
        """Send a message and return its ts (for tracking notification threads)."""
        if not self._web_client:
            return None
        try:
            resp = self._web_client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts,
                text=text,
                mrkdwn=True,
            )
            return resp.get("ts")
        except Exception as e:
            print(f"[Slack] >>> chat_postMessage FAILED: {e}")
            traceback.print_exc()
            return None

    @staticmethod
    def _parse_task_id(s: str) -> Optional[int]:
        try:
            return int(s.strip().lstrip("#"))
        except (ValueError, AttributeError):
            return None
