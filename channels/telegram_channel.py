"""
Telegram channel for AgentForge.

Send any message to create a task. Reply to a completion/failure notification
to resume that task. Slash commands also supported:

  /help                     — show help
  /status <id>              — task details
  /cancel <id>              — cancel a task
  /resume <id> <message>    — resume a task with a message
  /dir <path>               — set default working directory

When a task completes or fails the bot sends a notification to the chat where
the task was created.

Configuration via environment variables:
  TELEGRAM_BOT_TOKEN        — required, bot token from @BotFather
  TELEGRAM_ALLOWED_USERS    — optional, comma-separated Telegram user IDs
                              (numeric).  When set, any other user is rejected.
"""

import asyncio
import os
import threading
from typing import TYPE_CHECKING, Optional

try:
    from telegram import Update
    from telegram.constants import ParseMode
    from telegram.ext import (
        Application,
        CommandHandler,
        ContextTypes,
        MessageHandler,
        filters,
    )

    TELEGRAM_AVAILABLE = True
except ImportError:
    TELEGRAM_AVAILABLE = False

from taskboard_bus import Channel, MessageBus, OutboundMessage, OutboundMessageType

if TYPE_CHECKING:
    from taskboard import TaskDB, TaskScheduler


HELP_TEXT = (
    "👋 *AgentForge Bot*\n\n"
    "Send me any message and I'll create a task from it\\.\n"
    "Reply to a completion/failure notification to resume that task\\.\n\n"
    "*Commands:*\n"
    "/status `<id>` — task details\n"
    "/cancel `<id>` — cancel a task\n"
    "/resume `<id> <message>` — resume a task\n"
    "/dir `<path>` — set default working directory\n"
    "　　　　e\\.g\\. `/dir ~/workspace/myproject`\n"
    "/agent `<name>` — switch coding agent \\(`claude` / `codex`\\)\n"
    "/help — show this message\n\n"
    "*Tips:*\n"
    "• You can also mention a path in your message and it will be used automatically\\.\n"
    "　e\\.g\\. _在 ~/myapp 里帮我修复登录 bug_\n"
    "• Reply to any result notification to continue the conversation\\."
)


class TelegramChannel(Channel):
    """Telegram bot integration for AgentForge.

    Runs an async Application (python-telegram-bot v21+) inside its own
    event loop on a dedicated daemon thread, so it doesn't interfere with
    the synchronous HTTP server.
    """

    def __init__(
        self,
        bus: MessageBus,
        db: "TaskDB",
        scheduler: "TaskScheduler",
        token: str,
        allowed_users: Optional[list[int]] = None,
    ):
        super().__init__("telegram", bus, db)
        self.scheduler = scheduler
        self._token = token
        self._allowed_users: set[int] = set(allowed_users or [])
        self._app: Optional["Application"] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_ready = threading.Event()
        self._thread: Optional[threading.Thread] = None

        # Maps task_id → (chat_id, reply_message_id, reaction_message_id) for reply-back and reactions
        # reply_message_id: used for reply_to_message_id when posting completion
        # reaction_message_id: used for adding emoji reactions (may differ on resume)
        self._task_origin: dict[int, tuple[int, int, int]] = {}
        self._origin_lock = threading.Lock()

        # Maps notification message_id → task_id for resume-by-reply
        self._notification_map: dict[int, int] = {}
        self._notification_lock = threading.Lock()

        # Subscribe to bus so send() is called on task updates
        bus.subscribe_outbound(self._on_outbound)

    # ── lifecycle ────────────────────────────────────────────────

    def start(self) -> None:
        if not TELEGRAM_AVAILABLE:
            print("[Telegram] python-telegram-bot not installed. Run: uv add python-telegram-bot")
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_bot, daemon=True, name="telegram-bot")
        self._thread.start()
        print("[Telegram] Bot thread started")

    def stop(self) -> None:
        print("[Telegram] Stopping bot…")
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
        if self._loop and self._app:
            asyncio.run_coroutine_threadsafe(self._app.updater.stop(), self._loop)
            asyncio.run_coroutine_threadsafe(self._app.stop(), self._loop)
            asyncio.run_coroutine_threadsafe(self._app.shutdown(), self._loop)
        if self._thread:
            self._thread.join(timeout=10)
        print("[Telegram] Bot stopped")

    # ── Channel ABC: send outbound message ───────────────────────

    def _on_outbound(self, msg: OutboundMessage) -> None:
        """MessageBus outbound subscriber callback."""
        self.send(msg)

    def send(self, msg: OutboundMessage) -> None:
        """Forward a task completion/failure notification to the originating chat."""
        if not self._running:
            return
        if msg.type not in (OutboundMessageType.TASK_COMPLETED, OutboundMessageType.TASK_FAILED):
            return
        if not self._loop_ready.wait(timeout=30):
            print("[Telegram] send() called before event loop ready, dropping message")
            return
        if not self._app or not self._loop:
            return

        task_id = msg.task_id
        with self._origin_lock:
            origin = self._task_origin.get(task_id)

        title = msg.payload.get("title") or f"Task #{task_id}"

        is_completed = msg.type == OutboundMessageType.TASK_COMPLETED
        if is_completed:
            result_text = (msg.payload.get("result") or "").strip()
            if len(result_text) > 10000:
                result_text = result_text[:10000] + "\n…(truncated)"
            body = result_text or "Done."
        else:
            error_text = (msg.payload.get("error") or "Unknown error").strip()
            # Smart truncation: keep beginning (most informative) and signal cut
            if len(error_text) > 800:
                error_text = error_text[:800] + "\n…(truncated — use /status for full details)"
            body = error_text

        orig_message_id = None
        reaction_message_id = None
        if origin:
            chat_id, orig_message_id, reaction_message_id = origin
            # Always include task title and status emoji for clarity
            status_emoji = "✅" if is_completed else "❌"
            text = f"{status_emoji} Task #{task_id}: {title}\n{body}"
            if not is_completed:
                text += f"\n\n/status {task_id}"
        else:
            default_chat_id = self.db.get_setting("telegram_default_chat_id", "")
            if not default_chat_id:
                print(
                    f"[Telegram] No origin and no telegram_default_chat_id configured for task #{task_id}, skipping"
                )
                return
            chat_id = (
                int(default_chat_id)
                if str(default_chat_id).lstrip("-").isdigit()
                else default_chat_id
            )
            status_emoji = "✅" if is_completed else "❌"
            text = f"{status_emoji} Task #{task_id}: {title}\n{body}"
            if not is_completed:
                text += f"\n\n/status {task_id}"
            print(f"[Telegram] Using default chat_id={chat_id} for task #{task_id}")

        async def _send_and_track():
            try:
                react_target = reaction_message_id or orig_message_id
                if react_target:
                    # Add emoji reaction to the message that triggered the task (or resume)
                    emoji = "👍" if msg.type == OutboundMessageType.TASK_COMPLETED else "👎"
                    try:
                        from telegram import ReactionTypeEmoji

                        await self._app.bot.set_message_reaction(
                            chat_id=chat_id,
                            message_id=react_target,
                            reaction=[ReactionTypeEmoji(emoji=emoji)],
                        )
                    except Exception as e:
                        print(f"[Telegram] Failed to set reaction on message {react_target}: {e}")

                sent = await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    reply_to_message_id=orig_message_id,
                )
                if sent:
                    with self._notification_lock:
                        self._notification_map[sent.message_id] = task_id
                    print(
                        f"[Telegram] Notification msg_id={sent.message_id} mapped to task #{task_id}"
                    )
            except Exception as e:
                print(f"[Telegram] Failed to send notification to {chat_id}: {e}")

        asyncio.run_coroutine_threadsafe(_send_and_track(), self._loop)

        # Free origin memory after terminal state
        with self._origin_lock:
            self._task_origin.pop(task_id, None)

    # ── private helpers ──────────────────────────────────────────

    def _run_bot(self) -> None:
        """Entry point for the bot thread — creates and runs the event loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop_ready.set()
        try:
            self._loop.run_until_complete(self._start_app())
        except Exception as e:
            print(f"[Telegram] Bot error: {e}")
        finally:
            self._loop.close()

    async def _start_app(self) -> None:
        self._app = Application.builder().token(self._token).build()

        # Slash commands
        self._app.add_handler(CommandHandler("start", self._cmd_help))
        self._app.add_handler(CommandHandler("help", self._cmd_help))
        self._app.add_handler(CommandHandler("status", self._cmd_status))
        self._app.add_handler(CommandHandler("cancel", self._cmd_cancel))
        self._app.add_handler(CommandHandler("resume", self._cmd_resume))

        # Any non-command text message → create task or resume by reply
        self._app.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_text_message)
        )

        await self._app.initialize()
        await self._app.start()
        await self._app.updater.start_polling(drop_pending_updates=True)
        print("[Telegram] Bot polling started")

        while self._running:
            await asyncio.sleep(1)

        await self._app.updater.stop()
        await self._app.stop()
        await self._app.shutdown()

    async def _send_text(self, chat_id: int, text: str) -> None:
        try:
            await self._app.bot.send_message(chat_id=chat_id, text=text)
        except Exception as e:
            print(f"[Telegram] Failed to send message to {chat_id}: {e}")

    def _is_allowed(self, user_id: int) -> bool:
        if not self._allowed_users:
            return True
        return user_id in self._allowed_users

    # ── unified text message handler ──────────────────────────────

    def _format_forwarded_text(self, text: str, update: "Update") -> str:
        """格式化转发的消息文本，添加发送者和时间信息

        Args:
            text: 消息文本
            update: Telegram Update 对象

        Returns:
            格式化后的文本
        """
        msg = update.message
        is_forwarded = msg.forward_from or msg.forward_date

        if not is_forwarded:
            return text

        parts = ["📨 [转发消息]"]

        # 获取发送者信息
        sender_name = "未知用户"
        if msg.forward_from:
            sender = msg.forward_from
            if sender.username:
                sender_name = f"@{sender.username}"
            else:
                name_parts = [sender.first_name or ""]
                if sender.last_name:
                    name_parts.append(sender.last_name)
                sender_name = " ".join(filter(None, name_parts))
            parts.append(f"转发自: {sender_name}")
        elif msg.forward_from_chat:
            chat = msg.forward_from_chat
            sender_name = chat.title or chat.username or "未知频道"
            if chat.type == "channel":
                parts.append(f"转发自频道: {sender_name}")
            elif chat.type == "group" or chat.type == "supergroup":
                parts.append(f"转发自群组: {sender_name}")
            else:
                parts.append(f"转发自: {sender_name}")
        else:
            parts.append(f"转发自: {sender_name}")

        # 添加时间戳
        if msg.forward_date:
            from datetime import datetime

            ts = datetime.fromtimestamp(msg.forward_date)
            parts.append(f"时间: {ts.strftime('%Y-%m-%d %H:%M')}")

        parts.append("\n--- 转发内容 ---")
        parts.append(text)

        return "\n".join(parts)

    async def _handle_text_message(
        self, update: "Update", context: "ContextTypes.DEFAULT_TYPE"
    ) -> None:
        """Handle any non-command text: resume-by-reply or create task."""
        if not self._is_allowed(update.effective_user.id):
            await update.message.reply_text("⛔ You are not authorised to use this bot.")
            return

        text = (update.message.text or "").strip()
        if not text:
            return

        # ── /dir command: switch working directory ─────────────────
        from channels.dir_utils import handle_dir_command

        dir_reply = handle_dir_command(text, "telegram", self.db)
        if dir_reply is not None:
            await update.message.reply_text(dir_reply)
            return

        # ── /agent command: switch coding agent ──────────────────
        from channels.agent_utils import handle_agent_command

        agent_reply = handle_agent_command(text, "telegram", self.db)
        if agent_reply is not None:
            await update.message.reply_text(agent_reply)
            return

        # ── 检测转发消息 ───────────────────────────────────────
        text = self._format_forwarded_text(text, update)

        chat_id = update.effective_chat.id

        # ── reply to a notification → resume task ─────────────────
        reply = update.message.reply_to_message
        if reply:
            with self._notification_lock:
                task_id = self._notification_map.get(reply.message_id)
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
                        self._task_origin[task_id] = (
                            chat_id,
                            update.message.message_id,
                            update.message.message_id,
                        )

                    # Add "eyes" reaction and send resuming message
                    try:
                        from telegram import ReactionTypeEmoji

                        await self._app.bot.set_message_reaction(
                            chat_id=chat_id,
                            message_id=update.message.message_id,
                            reaction=[ReactionTypeEmoji(emoji="👀")],
                        )
                    except Exception as e:
                        print(f"[Telegram] Failed to set resume reaction: {e}")
                    await update.message.reply_text("▶️")
                    print(f"[Telegram] Auto-resuming task {task_id} from reply")
                    return
                else:
                    await update.message.reply_text(
                        f"❌ Task #{task_id} has no saved session to resume."
                    )
                    return

        # ── default: create a new task ────────────────────────────
        self._create_task(text, chat_id, update)

    def _create_task(self, text: str, chat_id: int, update: "Update") -> None:
        """Create a new task from any message text."""
        from taskboard import ScheduleType, Task

        msg = update.message

        # 检查是否为转发消息，用于添加标题标记
        is_forwarded = msg.forward_from or msg.forward_date
        title_prefix = "📨 " if is_forwarded else ""
        title = text[:60] + ("…" if len(text) > 60 else "")

        from channels.dir_utils import resolve_working_dir

        working_dir = resolve_working_dir(text, "telegram", self.db)

        from channels.agent_utils import resolve_agent

        task = Task(
            title=f"[Telegram] {title_prefix}{title}",
            prompt=text,
            working_dir=working_dir,
            schedule_type=ScheduleType.IMMEDIATE,
            tags="telegram" + (", forwarded" if is_forwarded else ""),
            agent=resolve_agent("telegram", self.db),
        )
        task_id = self.scheduler.submit_task(task)
        print(
            f"[Telegram] Task #{task_id} created from message{' (forwarded)' if is_forwarded else ''}"
        )

        message_id = update.message.message_id
        with self._origin_lock:
            self._task_origin[task_id] = (chat_id, message_id, message_id)

        # Acknowledge with an "eyes" reaction and a brief running hint
        async def _react():
            try:
                from telegram import ReactionTypeEmoji

                await self._app.bot.set_message_reaction(
                    chat_id=chat_id,
                    message_id=message_id,
                    reaction=[ReactionTypeEmoji(emoji="👀")],
                )
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=f"Task #{task_id} is running…",
                    reply_to_message_id=message_id,
                )
            except Exception as e:
                print(f"[Telegram] Failed to set reaction: {e}")

        asyncio.run_coroutine_threadsafe(_react(), self._loop)

    # ── command handlers ──────────────────────────────────────────

    async def _cmd_help(self, update: "Update", context: "ContextTypes.DEFAULT_TYPE") -> None:
        if not self._is_allowed(update.effective_user.id):
            await update.message.reply_text("⛔ You are not authorised to use this bot.")
            return
        await update.message.reply_text(HELP_TEXT, parse_mode=ParseMode.MARKDOWN_V2)

    async def _cmd_status(self, update: "Update", context: "ContextTypes.DEFAULT_TYPE") -> None:
        if not self._is_allowed(update.effective_user.id):
            await update.message.reply_text("⛔ Not authorised.")
            return

        if not context.args or not context.args[0].lstrip("#").isdigit():
            await update.message.reply_text("Usage: /status <task_id>")
            return

        task_id = int(context.args[0].lstrip("#"))
        task = self.db.get_task(task_id)
        if not task:
            await update.message.reply_text(f"❌ Task #{task_id} not found.")
            return

        status_icon = {
            "pending": "🕐",
            "scheduled": "📅",
            "running": "⏳",
            "completed": "✅",
            "failed": "❌",
            "cancelled": "🚫",
        }
        icon = status_icon.get(task["status"], "•")
        lines = [
            f"{icon} Task #{task_id} — {task['status']}",
            f"{task['title']}",
            f"Created: {task.get('created_at', '—')[:16]}",
            f"Last run: {(task.get('last_run_at') or '—')[:16]}",
        ]
        if task.get("error"):
            lines.append(f"\nError: {task['error'][:300]}")
        if task.get("result"):
            lines.append(f"\nResult: {task['result'][:500]}")

        await update.message.reply_text("\n".join(lines))

    async def _cmd_cancel(self, update: "Update", context: "ContextTypes.DEFAULT_TYPE") -> None:
        if not self._is_allowed(update.effective_user.id):
            await update.message.reply_text("⛔ Not authorised.")
            return

        if not context.args or not context.args[0].lstrip("#").isdigit():
            await update.message.reply_text("Usage: /cancel <task_id>")
            return

        task_id = int(context.args[0].lstrip("#"))
        task = self.db.get_task(task_id)
        if not task:
            await update.message.reply_text(f"❌ Task #{task_id} not found.")
            return
        if task["status"] in ("completed", "failed", "cancelled"):
            await update.message.reply_text(f"ℹ️ Task #{task_id} is already {task['status']}.")
            return

        self.db.update_task(task_id, status="cancelled")
        await update.message.reply_text(f"🚫 Task #{task_id} cancelled.")

    async def _cmd_resume(self, update: "Update", context: "ContextTypes.DEFAULT_TYPE") -> None:
        if not self._is_allowed(update.effective_user.id):
            await update.message.reply_text("⛔ Not authorised.")
            return

        if not context.args or not context.args[0].lstrip("#").isdigit():
            await update.message.reply_text("Usage: /resume <task_id> <message>")
            return

        tid = int(context.args[0].lstrip("#"))
        resume_msg = " ".join(context.args[1:]).strip()
        if not resume_msg:
            await update.message.reply_text("Please provide a message to resume with.")
            return

        task = self.db.get_task(tid)
        if not task or not task.get("session_id"):
            await update.message.reply_text(f"❌ Task #{tid} not found or has no saved session.")
            return

        self.db.update_task(
            tid,
            status="pending",
            prompt=resume_msg,
            result=None,
            error=None,
            question=None,
        )
        chat_id = update.effective_chat.id
        with self._origin_lock:
            self._task_origin[tid] = (chat_id, update.message.message_id, update.message.message_id)

        # Add "eyes" reaction to the user's command message
        try:
            from telegram import ReactionTypeEmoji

            await self._app.bot.set_message_reaction(
                chat_id=chat_id,
                message_id=update.message.message_id,
                reaction=[ReactionTypeEmoji(emoji="👀")],
            )
        except Exception as e:
            print(f"[Telegram] Failed to set resume reaction: {e}")

        await update.message.reply_text("▶️")


# ── helpers ──────────────────────────────────────────────────────────────────


def _escape_md(text: str) -> str:
    """Escape special MarkdownV2 characters."""
    special = r"\_*[]()~`>#+-=|{}.!"
    return "".join(f"\\{c}" if c in special else c for c in text)


# ── factory helper ───────────────────────────────────────────────────────────


def create_telegram_channel(
    db, scheduler, bus=None, token: str = "", allowed_users_str: str = ""
) -> Optional["TelegramChannel"]:
    """Create a TelegramChannel from explicit params or environment variables."""
    token = (token or os.environ.get("TELEGRAM_BOT_TOKEN", "")).strip()
    if not token:
        return None

    allowed_raw = (allowed_users_str or os.environ.get("TELEGRAM_ALLOWED_USERS", "")).strip()
    allowed_users: list[int] = []
    if allowed_raw:
        for uid in allowed_raw.split(","):
            uid = uid.strip()
            if uid.isdigit():
                allowed_users.append(int(uid))

    if bus is None:
        from taskboard_bus import MessageBus

        bus = MessageBus()

    return TelegramChannel(
        bus=bus,
        db=db,
        scheduler=scheduler,
        token=token,
        allowed_users=allowed_users,
    )
