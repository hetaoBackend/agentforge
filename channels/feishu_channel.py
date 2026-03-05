"""
TaskForge Feishu/Lark Channel

Bidirectional Feishu/Lark bot integration via WebSocket long-connection.
Outbound: sends card notifications when tasks complete or fail.
Inbound:  receives messages and either creates new tasks or resumes sessions.

Requires lark-oapi:  uv add lark-oapi
Configure via settings API:
    feishu_app_id, feishu_app_secret,
    feishu_default_chat_id  (oc_… group chat or ou_… open_id)
    feishu_default_working_dir  (working directory for tasks created from bot)
"""

import json
import threading
import base64
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from taskboard_bus import Channel, MessageBus, OutboundMessage, OutboundMessageType

if TYPE_CHECKING:
    from taskboard import TaskDB, TaskScheduler

# Lazy-load lark SDK
try:
    import lark_oapi as lark
    from lark_oapi.api.im.v1 import (
        CreateMessageRequest,
        CreateMessageRequestBody,
        CreateMessageReactionRequest,
        CreateMessageReactionRequestBody,
        GetMessageResourceRequest,
        ReplyMessageRequest,
        ReplyMessageRequestBody,
        Emoji,
    )
    FEISHU_AVAILABLE = True
except ImportError:
    FEISHU_AVAILABLE = False
    lark = None
    Emoji = None


HELP_TEXT = """\
**AgentForge Bot** 👋
发送任意消息即可创建任务。回复任务完成/失败通知即可继续对话。

**命令列表：**
• `/status <id>` — 查看任务详情
• `/cancel <id>` — 取消任务
• `/resume <id> <message>` — 继续执行任务
• `/dir <path>` — 设置默认工作目录
　　例如：`/dir ~/workspace/myproject`
• `/ccu` — 查看 Claude Code 当前用量（ccu-blocks）
• `/help` — 显示此帮助

**小技巧：**
• 消息中直接提到路径，Bot 会自动识别并使用。
　例如：_在 ~/myapp 里帮我修复登录 bug_
• 回复任意结果通知即可继续对话。
"""


class FeishuChannel(Channel):
    """Feishu/Lark channel integration using WebSocket long-connection."""

    def __init__(self, bus: MessageBus, db: "TaskDB", scheduler: "TaskScheduler"):
        super().__init__("feishu", bus, db)
        self.scheduler = scheduler
        self._client = None
        self._ws_client = None
        self._ws_thread: Optional[threading.Thread] = None

        # task_id -> (reply_to_chat_id, root_message_id, reaction_message_id) for thread-style replies
        # root_message_id: used for replying in thread
        # reaction_message_id: used for adding emoji reactions (may differ on resume)
        self._task_origin: dict[int, tuple[str, str, str]] = {}
        self._origin_lock = threading.Lock()

        # notification message_id -> task_id for resume-by-reply
        self._notification_map: dict[str, int] = {}
        self._notification_lock = threading.Lock()

        # root_message_id -> task_id for thread-based session resume
        self._root_msg_map: dict[str, int] = {}
        self._root_msg_lock = threading.Lock()

        # Subscribe to outbound bus messages for task notifications
        bus.subscribe_outbound(self._on_outbound)

    # ── lifecycle ────────────────────────────────────────────────

    def start(self) -> None:
        if not FEISHU_AVAILABLE:
            print("[Feishu] lark-oapi not installed. Run: uv add lark-oapi")
            return

        app_id = self.db.get_setting("feishu_app_id")
        app_secret = self.db.get_setting("feishu_app_secret")
        print(f"[Feishu] Starting with app_id: {app_id[:8]}... (masked)")

        if not app_id or not app_secret:
            print("[Feishu] Not configured — set feishu_app_id / feishu_app_secret in settings")
            return

        try:
            print("[Feishu] Building Lark client...")
            self._client = (
                lark.Client.builder()
                .app_id(app_id)
                .app_secret(app_secret)
                .log_level(lark.LogLevel.DEBUG)
                .build()
            )
            print("[Feishu] Lark client built successfully")

            print("[Feishu] Registering event handler...")
            event_handler = (
                lark.EventDispatcherHandler.builder("", "")
                .register_p2_im_message_receive_v1(self._on_message_sync)
                .register_p2_im_chat_member_bot_added_v1(self._on_bot_added)
                .build()
            )
            print("[Feishu] Event handler registered")

            print("[Feishu] Creating WebSocket client...")
            self._ws_client = lark.ws.Client(
                app_id,
                app_secret,
                event_handler=event_handler,
                log_level=lark.LogLevel.DEBUG,
            )
            print("[Feishu] WebSocket client created")

            self._running = True
            self._ws_thread = threading.Thread(target=self._run_ws, daemon=True)
            self._ws_thread.start()
            print("[Feishu] WebSocket bot thread started (no public IP required)")
            print("[Feishu] Initialization complete")
        except Exception as e:
            print(f"[Feishu] ERROR during initialization: {e}")
            import traceback
            traceback.print_exc()

    def stop(self) -> None:
        print("[Feishu] Stopping WebSocket bot...")
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
        self._client = None
        if self._ws_client:
            try:
                print("[Feishu] Calling ws_client.stop()...")
                self._ws_client.stop()
                print("[Feishu] ws_client.stop() completed")
            except Exception as e:
                print(f"[Feishu] Error stopping ws_client: {e}")
        self._ws_client = None
        print("[Feishu] Bot stopped")

    def _run_ws(self):
        print("[Feishu] WebSocket thread starting...")
        try:
            print("[Feishu] Calling ws_client.start()...")
            self._ws_client.start()
            print("[Feishu] ws_client.start() returned (connection ended)")
        except Exception as e:
            print(f"[Feishu] WebSocket error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            print("[Feishu] WebSocket thread exiting")

    # ── Channel ABC: send outbound message ───────────────────────

    def send(self, msg: OutboundMessage) -> None:
        """Send task completion/failure notification to Feishu, threaded under the original message."""
        if msg.type not in (OutboundMessageType.TASK_COMPLETED, OutboundMessageType.TASK_FAILED):
            return

        task_id = msg.task_id
        if not self._client:
            print(f"[Feishu] Client not initialized, skipping notification for task {task_id}")
            return

        task = self.db.get_task(task_id)
        if not task:
            print(f"[Feishu] Task {task_id} not found in database")
            return

        is_completed = (msg.type == OutboundMessageType.TASK_COMPLETED)
        print(f"[Feishu] Sending notification for task {task_id} ({'completed' if is_completed else 'failed'})")

        if is_completed:
            result_text = (msg.payload.get("result") or task.get("result") or "").strip()
            if len(result_text) > 10000:
                result_text = result_text[:10000] + "\n…(truncated)"
            content = result_text or "Done."
        else:
            error_text = (msg.payload.get("error") or task.get("error") or "Unknown error").strip()[:800]
            content = error_text

        # Try to reply in thread if we have an origin message
        with self._origin_lock:
            origin = self._task_origin.get(task_id)

        sent_id = None
        if origin:
            reply_to_chat, root_msg_id, reaction_msg_id = origin
            # Add emoji reaction to the message that triggered the task (or resume)
            emoji = "DONE" if is_completed else "Cry"
            self._add_reaction(reaction_msg_id, emoji)
            sent_id = self._reply_message(root_msg_id, content)

        # Fallback: send to default chat if no origin or reply failed
        if not sent_id:
            chat_id = self.db.get_setting("feishu_default_chat_id")
            if chat_id:
                sent_id = self._send_message(chat_id, content)

        if sent_id:
            print(f"[Feishu] Notification sent successfully, message_id: {sent_id}")
            with self._notification_lock:
                self._notification_map[sent_id] = task_id
            print(f"[Feishu] Notification message_id={sent_id} mapped to task #{task_id}")
        else:
            print(f"[Feishu] Failed to send notification for task {task_id}")

        # Free origin memory after terminal state
        with self._origin_lock:
            self._task_origin.pop(task_id, None)

    def _on_outbound(self, msg: OutboundMessage) -> None:
        """MessageBus outbound subscriber callback."""
        self.send(msg)

    # ── outbound: low-level send ──────────────────────────────────

    def _send_message(self, chat_id: str, content: str) -> Optional[str]:
        """Send a markdown card to chat_id. Returns the sent message_id or None."""
        print(f"[Feishu] _send_message called, chat_id: {chat_id}, content length: {len(content)}")
        if not self._client:
            print("[Feishu] Client not initialized in _send_message")
            return None
        try:
            receive_id_type = "chat_id" if chat_id.startswith("oc_") else "open_id"
            print(f"[Feishu] receive_id_type: {receive_id_type}")
            card = {
                "config": {"wide_screen_mode": True},
                "elements": [{"tag": "markdown", "content": content}],
            }
            print(f"[Feishu] Building CreateMessageRequest...")
            request = (
                CreateMessageRequest.builder()
                .receive_id_type(receive_id_type)
                .request_body(
                    CreateMessageRequestBody.builder()
                    .receive_id(chat_id)
                    .msg_type("interactive")
                    .content(json.dumps(card, ensure_ascii=False))
                    .build()
                )
                .build()
            )
            print(f"[Feishu] Calling im.v1.message.create()...")
            response = self._client.im.v1.message.create(request)
            print(f"[Feishu] Response received: success={response.success()}, code={response.code}, msg={response.msg}")
            if response.success():
                message_id = response.data.message_id
                print(f"[Feishu] Message sent successfully, message_id: {message_id}")
                return message_id
            else:
                print(f"[Feishu] Send failed: {response.code} {response.msg}")
                return None
        except Exception as e:
            print(f"[Feishu] Error sending message: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _reply_message(self, parent_message_id: str, content: str) -> Optional[str]:
        """Reply to a specific message (thread-style). Returns the sent message_id or None."""
        print(f"[Feishu] _reply_message called, parent_message_id: {parent_message_id}, content length: {len(content)}")
        if not self._client:
            print("[Feishu] Client not initialized in _reply_message")
            return None
        try:
            card = {
                "config": {"wide_screen_mode": True},
                "elements": [{"tag": "markdown", "content": content}],
            }
            request = (
                ReplyMessageRequest.builder()
                .message_id(parent_message_id)
                .request_body(
                    ReplyMessageRequestBody.builder()
                    .msg_type("interactive")
                    .content(json.dumps(card, ensure_ascii=False))
                    .reply_in_thread(True)
                    .build()
                )
                .build()
            )
            print(f"[Feishu] Calling im.v1.message.reply()...")
            response = self._client.im.v1.message.reply(request)
            print(f"[Feishu] Reply response: success={response.success()}, code={response.code}, msg={response.msg}")
            if response.success():
                message_id = response.data.message_id
                print(f"[Feishu] Reply sent successfully, message_id: {message_id}")
                return message_id
            else:
                print(f"[Feishu] Reply failed: {response.code} {response.msg}")
                return None
        except Exception as e:
            print(f"[Feishu] Error replying to message: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _add_reaction(self, message_id: str, emoji_type: str = "THUMBSUP"):
        """Add an emoji reaction in a background thread (non-blocking)."""
        if not self._client or not FEISHU_AVAILABLE:
            return

        def _do():
            try:
                req = (
                    CreateMessageReactionRequest.builder()
                    .message_id(message_id)
                    .request_body(
                        CreateMessageReactionRequestBody.builder()
                        .reaction_type(Emoji.builder().emoji_type(emoji_type).build())
                        .build()
                    )
                    .build()
                )
                self._client.im.v1.message_reaction.create(req)
            except Exception as e:
                print(f"[Feishu] Failed to add reaction to {message_id}: {e}")

        threading.Thread(target=_do, daemon=True).start()

    # ── usage stats ────────────────────────────────────────────────

    def _get_usage_stats(self) -> str:
        """Compute current 5-hour block usage via claude-monitor library."""
        try:
            from datetime import datetime, timezone
            from claude_monitor.data.analysis import analyze_usage
            from claude_monitor.core.plans import Plans
            from claude_monitor.utils.time_utils import TimezoneHandler

            data = analyze_usage(hours_back=192, quick_start=False, use_cache=False)
            if not data or not data.get("blocks"):
                return "📊 未找到 Claude Code 用量记录"

            blocks = data["blocks"]
            real_blocks = [b for b in blocks if not b.get("isGap")]
            if not real_blocks:
                return "📊 未找到 Claude Code 用量记录"

            # Prefer the active block; fall back to the most recent one
            block = next(
                (b for b in real_blocks if b.get("isActive")),
                real_blocks[-1],
            )

            now = datetime.now(timezone.utc)
            tz = TimezoneHandler()
            end_time = tz.parse_timestamp(block["endTime"])
            start_time = tz.parse_timestamp(block["startTime"])
            remaining = end_time - now

            total_tokens = block["totalTokens"]  # input + output, excludes cache
            total_cost = block["costUSD"]
            sent_msgs = block["sentMessagesCount"]

            # Use static plan limits (matches `claude-monitor --plan pro`)
            plan = (self.db.get_setting("claude_plan") or "pro").lower().strip()
            token_limit = Plans.get_token_limit(plan, blocks)
            cost_limit = Plans.get_cost_limit(plan)
            msg_limit = Plans.get_message_limit(plan)

            token_pct = min(total_tokens / token_limit * 100, 100) if token_limit > 0 else 0
            cost_pct = min(total_cost / cost_limit * 100, 100) if cost_limit > 0 else 0
            msg_pct = min(sent_msgs / msg_limit * 100, 100) if msg_limit > 0 else 0

            def _bar(pct: float, width: int = 20) -> str:
                filled = int(pct / (100 / width))
                return "█" * filled + "░" * (width - filled)

            # Burn rate from block data
            duration_min = block.get("durationMinutes", 1) or 1
            tok_per_min = total_tokens / duration_min
            cost_per_hr = (total_cost / duration_min) * 60

            # Format times in local timezone
            local_tz = datetime.now().astimezone().tzinfo
            bs_local = start_time.astimezone(local_tz)
            be_local = end_time.astimezone(local_tz)
            remain_h = int(max(remaining.total_seconds(), 0) // 3600)
            remain_m = int((max(remaining.total_seconds(), 0) % 3600) // 60)

            active_label = " (活跃)" if block.get("isActive") else " (已结束)"
            lines = [
                "**📊 Claude Code 用量**\n",
                f"Block: {bs_local:%m/%d %H:%M} → {be_local:%H:%M} (剩余 {remain_h}h{remain_m}m){active_label}\n",
                f"💰 Cost:  **[{_bar(cost_pct)}] {cost_pct:.1f}%**",
                f"   ${total_cost:.2f} / ${cost_limit:.0f}",
                f"📊 Token: **[{_bar(token_pct)}] {token_pct:.1f}%**",
                f"   {total_tokens:,} / {token_limit:,}",
                f"📨 Msgs:  **[{_bar(msg_pct)}] {msg_pct:.1f}%**",
                f"   {sent_msgs} / {msg_limit}\n",
                f"🔥 Burn: {tok_per_min:,.0f} tok/min | ${cost_per_hr:.2f}/hr",
                f"\nPlan: {plan}",
            ]
            return "\n".join(lines)

        except Exception as e:
            return f"❌ 获取用量统计失败：{e}"

    # ── forwarded message support ───────────────────────────────────

    def _extract_forwarded_content(self, message) -> Optional[dict]:
        """解析飞书转发/引用消息内容

        Returns:
            dict 包含转发信息的字典，或 None
            {
                "type": "forward" | "quote",
                "sender_name": str,
                "sender_id": str | None,
                "timestamp": int | None,
                "text": str,
                "images": list[dict]
            }
        """
        msg_type = message.message_type

        # 检查 forward 类型（如果飞书 API 支持）
        if msg_type == "forward":
            try:
                content = json.loads(message.content)
                return {
                    "type": "forward",
                    "sender_name": content.get("sender_name", "Unknown"),
                    "sender_id": content.get("sender_id"),
                    "timestamp": content.get("create_time"),
                    "text": content.get("text", ""),
                    "images": content.get("images", [])
                }
            except json.JSONDecodeError:
                pass

        # 检查 post 类型中的引用/转发标记
        elif msg_type == "post":
            try:
                post_body = json.loads(message.content)

                # 检查是否有 quote 标记（引用回复）
                for lang_key in ["content", "zh_cn", "en_us"]:
                    if lang_key in post_body:
                        lang_body = post_body[lang_key]
                        break
                else:
                    lang_body = next(iter(post_body.values()), {})

                # 如果 lang_body 是列表（简化的 content 格式），直接遍历
                # 否则从 lang_body 中获取 content
                paragraphs = lang_body if isinstance(lang_body, list) else lang_body.get("content", [])

                # 遍历内容查找引用 block
                for para in paragraphs:
                    for elem in para:
                        # 引用消息（quote 类型）
                        if elem.get("tag") == "quote":
                            quote_text = elem.get("text", "")
                            quote_user = elem.get("user", {})
                            sender_name = quote_user.get("name", "未知用户")

                            return {
                                "type": "quote",
                                "sender_name": sender_name,
                                "sender_id": quote_user.get("open_id"),
                                "text": quote_text,
                                "timestamp": elem.get("create_time")
                            }

                        # 嵌套消息（可能是转发）
                        if elem.get("tag") == "nested_message":
                            nested = elem.get("nested_message", {})
                            return {
                                "type": "forward",
                                "sender_name": nested.get("sender_name", "未知用户"),
                                "sender_id": nested.get("sender_id"),
                                "timestamp": nested.get("create_time"),
                                "text": nested.get("text", ""),
                                "images": nested.get("images", [])
                            }

            except (json.JSONDecodeError, AttributeError):
                pass

        return None

    def _format_forwarded_prompt(self, original_content: str, forwarded: dict) -> str:
        """将转发内容格式化到 prompt 中

        Args:
            original_content: 用户发送的原始消息文本
            forwarded: 从 _extract_forwarded_content 返回的转发信息

        Returns:
            格式化后的完整 prompt
        """
        if not forwarded:
            return original_content

        parts = []

        # 添加时间和发送者信息
        parts.append("📨 [转发消息]")

        sender_name = forwarded.get("sender_name", "未知用户")
        parts.append(f"转发自: {sender_name}")

        if forwarded.get("timestamp"):
            from datetime import datetime
            ts = datetime.fromtimestamp(forwarded["timestamp"])
            parts.append(f"时间: {ts.strftime('%Y-%m-%d %H:%M')}")

        parts.append("\n--- 转发内容 ---")
        parts.append(forwarded.get("text", ""))

        # 如果有图片信息，添加说明
        images = forwarded.get("images", [])
        if images:
            parts.append(f"\n[包含 {len(images)} 张图片]")

        # 如果有用户附加消息，添加到转发内容之后
        if original_content.strip():
            parts.append("\n--- 用户附加消息 ---")
            parts.append(original_content)

        return "\n".join(parts)

    def _download_image(self, message_id: str, image_key: str) -> Optional[str]:
        """Download an image from Feishu and save it to a temporary location.
        Returns the local file path or None if download fails."""
        if not self._client or not FEISHU_AVAILABLE:
            print("[Feishu] Client not available for image download")
            return None

        try:
            print(f"[Feishu] Downloading image {image_key} from message {message_id}")
            # Create downloads directory
            downloads_dir = Path.home() / ".agentforge" / "feishu_images"
            downloads_dir.mkdir(parents=True, exist_ok=True)

            # Request the image resource
            request = (
                GetMessageResourceRequest.builder()
                .message_id(message_id)
                .file_key(image_key)
                .type("image")
                .build()
            )

            response = self._client.im.v1.message_resource.get(request)

            if not response.success():
                print(f"[Feishu] Failed to download image: {response.code} {response.msg}")
                return None

            # Get image content
            image_data = response.raw.content

            # Detect actual image format from magic bytes
            if image_data.startswith(b'\xff\xd8\xff'):
                extension = "jpg"
            elif image_data.startswith(b'\x89PNG\r\n\x1a\n'):
                extension = "png"
            elif image_data.startswith(b'GIF87a') or image_data.startswith(b'GIF89a'):
                extension = "gif"
            elif image_data.startswith(b'RIFF') and b'WEBP' in image_data[:12]:
                extension = "webp"
            else:
                # Default to jpg if unknown
                extension = "jpg"

            # Save with correct extension
            file_path = downloads_dir / f"{image_key}.{extension}"

            with open(file_path, "wb") as f:
                f.write(image_data)

            print(f"[Feishu] Image saved to {file_path} (detected format: {extension})")
            return str(file_path)

        except Exception as e:
            print(f"[Feishu] Error downloading image {image_key}: {e}")
            import traceback
            traceback.print_exc()
            return None

    # ── inbound: receive messages via WebSocket ───────────────────

    def _on_bot_added(self, data) -> None:
        """Called when the bot is added to a chat (including P2P when a user follows the bot)."""
        print(f"[Feishu] _on_bot_added called")
        try:
            event = data.event
            chat_id = getattr(event, "chat_id", None)
            if not chat_id:
                print("[Feishu] _on_bot_added: no chat_id in event")
                return
            print(f"[Feishu] Bot added to chat_id={chat_id}, sending HELP_TEXT")
            self._send_message(chat_id, HELP_TEXT)
        except Exception as e:
            print(f"[Feishu] _on_bot_added error: {e}")
            import traceback
            traceback.print_exc()

    def _on_message_sync(self, data) -> None:
        """Called from the WebSocket thread; runs handler synchronously."""
        print(f"[Feishu] _on_message_sync called, data type: {type(data)}")
        try:
            self._handle_inbound(data)
            print(f"[Feishu] Message handled successfully")
        except Exception as e:
            print(f"[Feishu] Inbound handler error: {e}")
            import traceback
            traceback.print_exc()

    def _handle_inbound(self, data) -> None:
        """Parse incoming Feishu message and act on it."""
        print(f"[Feishu] _handle_inbound processing message...")
        event = data.event
        message = event.message
        sender = event.sender

        if sender.sender_type == "bot":
            print(f"[Feishu] Ignoring message from bot (self)")
            return  # ignore self-messages

        msg_type = message.message_type
        print(f"[Feishu] Message type: {msg_type}")
        image_paths = []  # Initialize for all message types
        if msg_type == "text":
            try:
                content = json.loads(message.content).get("text", "").strip()
            except (json.JSONDecodeError, AttributeError):
                content = (message.content or "").strip()
        elif msg_type == "post":
            # Rich text message (may contain text + images)
            try:
                post_body = json.loads(message.content)
                print(f"[Feishu] Parsed post_body keys: {post_body.keys()}")

                # Check if this is direct format (has "content" key directly)
                if "content" in post_body:
                    lang_body = post_body
                else:
                    # Try language-specific keys
                    lang_body = (
                        post_body.get("zh_cn") or
                        post_body.get("en_us") or
                        next(iter(post_body.values()), {})
                    )

                title_part = lang_body.get("title", "").strip()
                text_parts = []
                image_paths = []  # Store actual downloaded image paths
                for para in lang_body.get("content", []):
                    for elem in para:
                        if elem.get("tag") == "text":
                            text_parts.append(elem.get("text", ""))
                        elif elem.get("tag") == "img":
                            # Download the image
                            image_key = elem.get("image_key", "")
                            if image_key:
                                print(f"[Feishu] Found image: {image_key}, attempting download...")
                                image_path = self._download_image(message.message_id, image_key)
                                if image_path:
                                    image_paths.append(image_path)
                                    print(f"[Feishu] Successfully downloaded image to {image_path}")
                                else:
                                    print(f"[Feishu] Failed to download image {image_key}")

                body_text = "".join(text_parts).strip()
                print(f"[Feishu] Extracted text_parts: {text_parts}, body_text: {body_text}")
                print(f"[Feishu] Downloaded image paths: {image_paths}")

                content = "\n".join(filter(None, [title_part, body_text])).strip()

                # If no text was extracted but there are images, provide a default prompt
                if not content and image_paths:
                    content = "请分析这些图片的内容"

                print(f"[Feishu] Final content: {content[:200]}")
            except (json.JSONDecodeError, AttributeError, StopIteration) as e:
                print(f"[Feishu] Failed to parse post message: {e}")
                import traceback
                traceback.print_exc()
                # Don't use raw content as fallback - it's the JSON structure
                content = ""
                image_paths = []
        elif msg_type == "image":
            # Single image message: {"image_key": "img_xxxx"}
            try:
                img_content = json.loads(message.content)
                image_key = img_content.get("image_key", "")
                if image_key:
                    print(f"[Feishu] Found single image message, image_key: {image_key}")
                    image_path = self._download_image(message.message_id, image_key)
                    if image_path:
                        image_paths.append(image_path)
                        print(f"[Feishu] Downloaded single image to {image_path}")
                    else:
                        print(f"[Feishu] Failed to download single image {image_key}")
                content = "请分析这张图片的内容"
            except (json.JSONDecodeError, AttributeError) as e:
                print(f"[Feishu] Failed to parse image message: {e}")
                content = "请分析这张图片的内容"
        else:
            print(f"[Feishu] Ignoring non-text/post/image message (type={msg_type})")
            return

        print(f"[Feishu] Message content: {content[:100]}...")

        # ── 检测转发/引用消息 ───────────────────────────────────
        forwarded = self._extract_forwarded_content(message)
        if forwarded:
            print(f"[Feishu] Detected forwarded/quoted message from {forwarded.get('sender_name', 'unknown')}")
            content = self._format_forwarded_prompt(content, forwarded)
            # 处理转发中包含的图片（如果有）
            for img_info in forwarded.get("images", []):
                img_key = img_info.get("image_key")
                if img_key:
                    img_path = self._download_image(message.message_id, img_key)
                    if img_path:
                        image_paths.append(img_path)

        if not content:
            print(f"[Feishu] Empty content after processing, ignoring")
            return

        # Acknowledge with a "get" reaction
        print(f"[Feishu] Adding reaction to message...")
        self._add_reaction(message.message_id, "OK")

        sender_id = sender.sender_id.open_id if sender.sender_id else "unknown"
        chat_type = message.chat_type  # "p2p" or "group"
        chat_id = message.chat_id
        reply_to = chat_id if chat_type == "group" else sender_id
        print(f"[Feishu] sender_id: {sender_id}, chat_type: {chat_type}, reply_to: {reply_to}")

        # ── command: /help ───────────────────────────────────────
        if content.strip() in ("/help", "/start"):
            self._send_message(reply_to, HELP_TEXT)
            return

        # ── command: /dir <path> — switch working directory ──────
        if content.startswith("/dir ") or content.startswith("/cd "):
            from channels.dir_utils import handle_dir_command
            reply = handle_dir_command(content, "feishu", self.db)
            if reply:
                self._send_message(reply_to, reply)
            return

        # ── command: /ccu [blocks] — usage stats ────────────────
        if content.strip().lower().startswith("/ccu"):
            stats = self._get_usage_stats()
            self._send_message(reply_to, stats)
            return

        # ── command: /resume <task_id> <message> ────────────────
        if content.startswith("/resume "):
            print(f"[Feishu] Processing /resume command")
            parts = content[8:].strip().split(" ", 1)
            if len(parts) >= 2 and parts[0].isdigit():
                tid = int(parts[0])
                resume_msg = parts[1].strip()
                task = self.db.get_task(tid)
                if task and task.get("session_id"):
                    self.db.update_task(
                        tid,
                        status="pending",
                        prompt=resume_msg,
                        result=None,
                        error=None,
                        question=None,
                    )
                    with self._origin_lock:
                        self._task_origin[tid] = (reply_to, message.message_id, message.message_id)
                    self._reply_message(
                        message.message_id,
                        f"▶️ 收到！正在唤醒 Task #{tid}，请稍候～",
                    )
                    print(f"[Feishu] Task {tid} resumed")
                else:
                    self._send_message(
                        reply_to,
                        f"❌ Task #{tid} not found or has no saved session.",
                    )
                    print(f"[Feishu] Task {tid} not found or no session_id")
            else:
                self._send_message(reply_to, "Usage: `/resume <task_id> <message>`")
                print(f"[Feishu] Invalid /resume syntax")
            return

        # ── command: /status <task_id> ───────────────────────────
        if content.startswith("/status "):
            print(f"[Feishu] Processing /status command")
            parts = content[8:].strip().split()
            if parts and parts[0].isdigit():
                tid = int(parts[0])
                task = self.db.get_task(tid)
                if task:
                    s = task["status"]
                    icon = {"completed": "✅", "failed": "❌", "running": "⏳",
                            "pending": "🕐", "cancelled": "🚫"}.get(s, "❓")
                    self._send_message(
                        reply_to,
                        f"{icon} **Task #{tid}** — {s}\n\n**{task['title']}**",
                    )
                    print(f"[Feishu] Status sent for task {tid}")
                else:
                    self._send_message(reply_to, f"❌ Task #{tid} not found.")
                    print(f"[Feishu] Task {tid} not found")
            return

        # ── filter system notifications ───────────────────────────
        if any(keyword in content.lower() for keyword in [
            "notification", "任务完成", "任务失败", "任务状态",
            "任务已", "task completed", "task failed", "task status"
        ]):
            print(f"[Feishu] Ignoring system notification")
            return

        # ── detect reply in thread → resume task session ─────────
        # Check parent_id (direct reply) and root_id (any message in thread)
        parent_id = getattr(message, 'parent_id', None) or None
        root_id = getattr(message, 'root_id', None) or None
        is_thread_msg = bool(parent_id or root_id)

        if is_thread_msg:
            print(f"[Feishu] Thread message detected: parent_id={parent_id}, root_id={root_id}")
            # Try to find task_id: first by notification_map (parent_id), then by root_msg_map (root_id)
            task_id = None
            with self._notification_lock:
                if parent_id:
                    task_id = self._notification_map.get(parent_id)
                if not task_id and root_id:
                    task_id = self._notification_map.get(root_id)
            if not task_id:
                with self._root_msg_lock:
                    if root_id:
                        task_id = self._root_msg_map.get(root_id)
                    if not task_id and parent_id:
                        task_id = self._root_msg_map.get(parent_id)

            # Determine which message to reply to in the thread
            thread_root = root_id or parent_id

            if task_id:
                print(f"[Feishu] Found matching task {task_id} for thread message")
                task = self.db.get_task(task_id)
                if task and task.get("session_id"):
                    self.db.update_task(
                        task_id,
                        status="pending",
                        prompt=content,
                        result=None,
                        error=None,
                        question=None,
                    )
                    with self._origin_lock:
                        self._task_origin[task_id] = (reply_to, thread_root, message.message_id)
                    self._reply_message(
                        thread_root,
                        f"▶️ 收到！正在唤醒 Task #{task_id}，请稍候～",
                    )
                    print(f"[Feishu] Auto-resuming task {task_id} from thread reply")
                    return
                else:
                    self._reply_message(
                        thread_root,
                        f"❌ Task #{task_id} not found or has no saved session.",
                    )
                    print(f"[Feishu] Task {task_id} cannot be resumed")
                    return
            else:
                print(f"[Feishu] Thread message but no matching task found, creating new task")
        else:
            print(f"[Feishu] Message is not a reply (no parent_id or root_id)")

        # ── default: create a new task from message text ─────────
        print(f"[Feishu] Creating new task from message")
        print(f"[Feishu] image_paths to attach: {image_paths}")
        from channels.dir_utils import resolve_working_dir
        working_dir = resolve_working_dir(content, "feishu", self.db)
        title = content[:60] + ("…" if len(content) > 60 else "")

        # Convert image_paths to prompt_images for frontend display
        prompt_images = []
        if image_paths:
            for img_path in image_paths:
                try:
                    with open(img_path, "rb") as f:
                        img_data = base64.b64encode(f.read()).decode("utf-8")

                    # Detect media type from file extension
                    ext = Path(img_path).suffix.lower()
                    media_type_map = {
                        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                        ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"
                    }
                    media_type = media_type_map.get(ext, "image/jpeg")

                    prompt_images.append({
                        "name": Path(img_path).name,
                        "media_type": media_type,
                        "data": img_data
                    })
                    print(f"[Feishu] Converted {img_path} to prompt_images ({media_type}, {len(img_data)} bytes)")
                except Exception as e:
                    print(f"[Feishu] Failed to convert image {img_path} to base64: {e}")

        from taskboard import Task, ScheduleType
        new_task = Task(
            title=f"[Feishu] {title}",
            prompt=content,
            working_dir=working_dir,
            schedule_type=ScheduleType.IMMEDIATE,
            tags="feishu",
            image_paths=image_paths,
            prompt_images=prompt_images,
        )
        print(f"[Feishu] Task object created with {len(image_paths)} image_paths and {len(prompt_images)} prompt_images")
        task_id = self.scheduler.submit_task(new_task)
        print(f"[Feishu] Task {task_id} submitted, verifying in DB...")
        created_task = self.db.get_task(task_id)
        print(f"[Feishu] Task {task_id} in DB has image_paths: {created_task.get('image_paths')}, prompt_images: {len(created_task.get('prompt_images', []))} items")
        img_info = f" (with {len(image_paths)} image{'s' if len(image_paths) != 1 else ''})" if image_paths else ""

        # Reply with a brief running hint and track origin for completion notification
        self._reply_message(message.message_id, f"Task #{task_id} is running…")
        with self._origin_lock:
            self._task_origin[task_id] = (reply_to, message.message_id, message.message_id)
        with self._root_msg_lock:
            self._root_msg_map[message.message_id] = task_id
        print(f"[Feishu] Task {task_id} origin tracked: reply_to={reply_to}, root_msg={message.message_id}")
        print(f"[Feishu] New task {task_id} created and queued with {len(image_paths)} images")
