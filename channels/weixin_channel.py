"""
Weixin channel for AgentForge.

Text-only MVP backed by a Node sidecar bridge that communicates with Python via
newline-delimited JSON over stdio.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from taskboard_bus import Channel, MessageBus, OutboundMessage, OutboundMessageType

if TYPE_CHECKING:
    from taskboard import TaskDB, TaskScheduler


class WeixinChannel(Channel):
    """Weixin integration using a Node bridge process."""

    def __init__(
        self,
        bus: MessageBus,
        db: "TaskDB",
        scheduler: "TaskScheduler",
        bridge_cmd: Optional[list[str]] = None,
    ):
        super().__init__("weixin", bus, db)
        self.scheduler = scheduler
        self.bridge_cmd = bridge_cmd or self._default_bridge_cmd()
        self._bridge_proc: Optional[subprocess.Popen] = None
        self._reader_thread: Optional[threading.Thread] = None

        # task_id -> origin metadata used for notifications and resume
        self._task_origin: dict[int, dict[str, str]] = {}
        self._origin_lock = threading.Lock()

        # notification message_id -> task_id for resume-by-reply
        self._notification_map: dict[str, int] = {}
        self._notification_lock = threading.Lock()

        # request_id -> task_id for sent acknowledgements from the bridge
        self._pending_notifications: dict[str, int] = {}
        self._pending_lock = threading.Lock()

        self._status_lock = threading.Lock()
        self._status = {
            "configured": False,
            "login_status": "idle",
            "qr_code_url": "",
            "last_error": "",
            "account_id": "",
            "user_id": "",
        }

        bus.subscribe_outbound(self._on_outbound)

    def _default_bridge_cmd(self) -> list[str]:
        bridge_path = Path(__file__).resolve().parent / "weixin_bridge" / "index.mjs"
        return ["node", str(bridge_path)]

    def start(self) -> None:
        self._running = True
        try:
            env = os.environ.copy()
            env.setdefault("AGENTFORGE_WEIXIN_DATA_DIR", str(Path.home() / ".agentforge" / "weixin"))
            env.setdefault(
                "AGENTFORGE_WEIXIN_BASE_URL",
                self.db.get_setting("weixin_base_url", "https://ilinkai.weixin.qq.com"),
            )
            env.setdefault(
                "AGENTFORGE_WEIXIN_ACCOUNT_ID",
                self.db.get_setting("weixin_account_id", ""),
            )
            self._bridge_proc = subprocess.Popen(
                self.bridge_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            )
        except Exception as exc:
            self._running = False
            print(f"[Weixin] Failed to start bridge: {exc}")
            return

        self._reader_thread = threading.Thread(target=self._read_bridge_events, daemon=True)
        self._reader_thread.start()
        print("[Weixin] Bridge started")

    def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(self._on_outbound)
        if self._bridge_proc and self._bridge_proc.poll() is None:
            try:
                self._bridge_proc.terminate()
                self._bridge_proc.wait(timeout=5)
            except Exception:
                pass
        self._bridge_proc = None

    def send(self, msg: OutboundMessage) -> None:
        if not self._running:
            return
        if msg.type not in (OutboundMessageType.TASK_COMPLETED, OutboundMessageType.TASK_FAILED):
            return

        task_id = msg.task_id
        with self._origin_lock:
            origin = self._task_origin.get(task_id)
        if not origin:
            print(f"[Weixin] No origin for task #{task_id}, skipping outbound notification")
            return

        title = msg.payload.get("title") or f"Task #{task_id}"
        if msg.type == OutboundMessageType.TASK_COMPLETED:
            body = (msg.payload.get("result") or "").strip() or "Done."
            text = f"✅ {title}\n{body}"
        else:
            body = (msg.payload.get("error") or "Unknown error").strip()
            text = f"❌ {title}\n{body}"

        request_id = uuid.uuid4().hex
        with self._pending_lock:
            self._pending_notifications[request_id] = task_id
        self._send_command(
            {
                "type": "send_message",
                "request_id": request_id,
                "account_id": origin.get("account_id", ""),
                "peer_id": origin["peer_id"],
                "context_token": origin.get("context_token", ""),
                "reply_to_message_id": origin.get("message_id", ""),
                "text": text,
            }
        )

        with self._origin_lock:
            self._task_origin.pop(task_id, None)

    def _on_outbound(self, msg: OutboundMessage) -> None:
        self.send(msg)

    def _read_bridge_events(self) -> None:
        if not self._bridge_proc or not self._bridge_proc.stdout:
            return

        for line in self._bridge_proc.stdout:
            if not self._running:
                return
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                print(f"[Weixin] Ignoring non-JSON bridge output: {line}")
                continue
            self._handle_bridge_event(event)

    def _handle_bridge_event(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        if event_type == "message":
            self._handle_message_event(event)
        elif event_type == "sent":
            self._handle_sent_event(event)
        elif event_type == "qr":
            qr_value = event.get("qrcode_url", "") or ""
            print(
                f"[Weixin] QR payload len={len(qr_value)} prefix={qr_value[:80]!r}"
            )
            self._update_status(
                login_status="waiting_for_scan",
                qr_code_url=qr_value,
                account_id=event.get("account_id", ""),
                last_error="",
            )
            print("[Weixin] Bridge event: qr")
        elif event_type == "scaned":
            self._update_status(login_status="scanned", last_error="")
            print("[Weixin] Bridge event: scaned")
        elif event_type == "login_success":
            self._update_status(
                configured=True,
                login_status="connected",
                qr_code_url="",
                account_id=event.get("account_id", ""),
                user_id=event.get("user_id", ""),
                last_error="",
            )
            print("[Weixin] Bridge event: login_success")
        elif event_type == "ready":
            self._update_status(
                configured=True,
                login_status="connected",
                qr_code_url="",
                account_id=event.get("account_id", ""),
                last_error="",
            )
            print("[Weixin] Bridge event: ready")
        elif event_type == "error":
            self._update_status(
                login_status="error",
                last_error=event.get("message", "unknown_error"),
            )
            print("[Weixin] Bridge event: error")

    def _handle_sent_event(self, event: dict[str, Any]) -> None:
        request_id = event.get("request_id") or ""
        message_id = event.get("message_id") or ""
        if not request_id or not message_id:
            return
        with self._pending_lock:
            task_id = self._pending_notifications.pop(request_id, None)
        if task_id is None:
            return
        with self._notification_lock:
            self._notification_map[message_id] = task_id

    def _handle_message_event(self, event: dict[str, Any]) -> None:
        text = (event.get("text") or "").strip()
        if not text:
            return

        from channels.agent_utils import handle_agent_command, resolve_agent
        from channels.dir_utils import handle_dir_command, resolve_working_dir
        from taskboard import ScheduleType, Task

        reply_to_message_id = event.get("reply_to_message_id") or ""
        peer_id = event.get("peer_id") or event.get("from_user_id") or ""
        account_id = event.get("account_id") or ""
        context_token = event.get("context_token") or ""
        message_id = event.get("message_id") or ""

        dir_reply = handle_dir_command(text, "weixin", self.db)
        if dir_reply is not None:
            self._reply_to_event(event, dir_reply)
            return

        agent_reply = handle_agent_command(text, "weixin", self.db)
        if agent_reply is not None:
            self._reply_to_event(event, agent_reply)
            return

        if reply_to_message_id:
            with self._notification_lock:
                task_id = self._notification_map.get(reply_to_message_id)
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
                        self._task_origin[task_id] = {
                            "account_id": account_id,
                            "peer_id": peer_id,
                            "context_token": context_token,
                            "message_id": message_id,
                        }
                    self._reply_to_event(event, "▶️")
                    return
                self._reply_to_event(event, f"❌ Task #{task_id} has no saved session to resume.")
                return

        task = Task(
            title=f"[Weixin] {text[:60]}{'…' if len(text) > 60 else ''}",
            prompt=text,
            working_dir=resolve_working_dir(text, "weixin", self.db),
            schedule_type=ScheduleType.IMMEDIATE,
            tags="weixin",
            agent=resolve_agent("weixin", self.db),
        )
        task_id = self.scheduler.submit_task(task)
        with self._origin_lock:
            self._task_origin[task_id] = {
                "account_id": account_id,
                "peer_id": peer_id,
                "context_token": context_token,
                "message_id": message_id,
            }
        self._reply_to_event(event, f"Task #{task_id} is running…")

    def _reply_to_event(self, event: dict[str, Any], text: str) -> None:
        peer_id = event.get("peer_id") or event.get("from_user_id")
        if not peer_id:
            return
        self._send_command(
            {
                "type": "send_message",
                "account_id": event.get("account_id", ""),
                "peer_id": peer_id,
                "context_token": event.get("context_token", ""),
                "reply_to_message_id": event.get("message_id", ""),
                "text": text,
            }
        )

    def _send_command(self, payload: dict[str, Any]) -> None:
        if not self._bridge_proc or not self._bridge_proc.stdin:
            return
        self._bridge_proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._bridge_proc.stdin.flush()

    def request_login(self) -> None:
        self._update_status(
            configured=False,
            login_status="idle",
            qr_code_url="",
            last_error="",
            user_id="",
        )
        self._send_command({"type": "login"})

    def request_logout(self) -> None:
        self._update_status(
            configured=False,
            login_status="idle",
            qr_code_url="",
            last_error="",
            user_id="",
        )
        self._send_command({"type": "logout"})

    def _update_status(self, **updates: Any) -> None:
        with self._status_lock:
            self._status.update({k: v for k, v in updates.items() if v is not None})

    def get_status_snapshot(self) -> dict[str, Any]:
        with self._status_lock:
            return dict(self._status)
