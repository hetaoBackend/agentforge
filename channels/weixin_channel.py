"""
Weixin channel for AgentForge.

Text-only MVP backed by a Node sidecar bridge that communicates with Python via
newline-delimited JSON over stdio.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional
from urllib.parse import unquote, urlparse

from taskboard_bus import Channel, MessageBus, OutboundMessage, OutboundMessageType


def _find_node_executable() -> Optional[str]:
    """Locate the Node.js binary.

    macOS apps launched from Finder/Dock inherit a minimal PATH that excludes
    Homebrew (`/opt/homebrew/bin`), so ``shutil.which("node")`` misses even when
    node is installed. Fall back to the common install locations.
    """
    found = shutil.which("node")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if os.path.exists(candidate):
            return candidate
    return None


if TYPE_CHECKING:
    from taskboard import TaskDB, TaskScheduler


WEIXIN_UPLOADABLE_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
WEIXIN_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*]\(([^)]+)\)")
WEIXIN_NEW_SESSION_RE = re.compile(r"^/new(?:\s+(.*))?$", re.IGNORECASE | re.DOTALL)


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

        # account_id:peer_id -> current task_id. Weixin has no thread, so this
        # gives each peer a current AgentForge session until /new starts another.
        self._peer_current_task: dict[str, int] = {}
        self._peer_lock = threading.Lock()

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

    def _bridge_script_path(self) -> Path:
        # In the PyInstaller bundle the bridge is shipped under sys._MEIPASS
        # (via --add-data), not beside the frozen source module.
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            return Path(sys._MEIPASS) / "channels" / "weixin_bridge" / "index.mjs"
        return Path(__file__).resolve().parent / "weixin_bridge" / "index.mjs"

    def _default_bridge_cmd(self) -> list[str]:
        # Resolve node to a full path so it's found even under the minimal PATH
        # a packaged macOS app inherits. Falls back to bare "node" when missing;
        # start() then surfaces the FileNotFoundError as an error status.
        return [_find_node_executable() or "node", str(self._bridge_script_path())]

    def start(self) -> None:
        self._running = True
        try:
            env = os.environ.copy()
            env.setdefault(
                "AGENTFORGE_WEIXIN_DATA_DIR", str(Path.home() / ".agentforge" / "weixin")
            )
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
        except FileNotFoundError:
            self._running = False
            self._bridge_proc = None
            msg = (
                "Node.js not found. Install Node.js (https://nodejs.org) to use the Weixin channel."
            )
            print(f"[Weixin] {msg}")
            self._update_status(login_status="error", last_error=msg)
            return
        except Exception as exc:
            self._running = False
            self._bridge_proc = None
            msg = f"Failed to start Weixin bridge: {exc}"
            print(f"[Weixin] {msg}")
            self._update_status(login_status="error", last_error=msg)
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
        task = self.db.get_task(task_id) or {}
        if msg.type == OutboundMessageType.TASK_COMPLETED:
            body = (msg.payload.get("result") or "").strip() or "Done."
            image_paths = self._collect_generated_image_paths(task_id, body, task)
            if image_paths:
                body = self._hide_generated_image_paths(body, len(image_paths), image_paths)
            text = f"✅ Task #{task_id} · {title}\n{body}"
        else:
            body = (msg.payload.get("error") or "Unknown error").strip()
            image_paths = []
            text = f"❌ Task #{task_id} · {title}\n{body}"

        request_id = uuid.uuid4().hex
        with self._pending_lock:
            self._pending_notifications[request_id] = task_id
        command = {
            "type": "send_message",
            "request_id": request_id,
            "account_id": origin.get("account_id", ""),
            "peer_id": origin["peer_id"],
            "context_token": origin.get("context_token", ""),
            "reply_to_message_id": origin.get("message_id", ""),
            "text": text,
        }
        if image_paths:
            command["image_paths"] = image_paths
        self._send_command(command)

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
            print(f"[Weixin] QR payload len={len(qr_value)} prefix={qr_value[:80]!r}")
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
        elif event_type == "logged_out":
            self._update_status(
                configured=False,
                login_status="idle",
                qr_code_url="",
                last_error="",
                user_id="",
            )
            print("[Weixin] Bridge event: logged_out")
        elif event_type == "error":
            self._update_status(
                login_status="error",
                last_error=event.get("message", "unknown_error"),
            )
            print("[Weixin] Bridge event: error")

    def _handle_sent_event(self, event: dict[str, Any]) -> None:
        request_id = event.get("request_id") or ""
        message_id = event.get("message_id") or ""
        quoted_message_id = event.get("quoted_message_id") or ""
        if not request_id or (not message_id and not quoted_message_id):
            return
        with self._pending_lock:
            task_id = self._pending_notifications.get(request_id)
        if task_id is None:
            return
        with self._notification_lock:
            if message_id:
                self._notification_map[message_id] = task_id
            if quoted_message_id:
                self._notification_map[quoted_message_id] = task_id
        if quoted_message_id:
            with self._pending_lock:
                self._pending_notifications.pop(request_id, None)

    def _handle_message_event(self, event: dict[str, Any]) -> None:
        text = (event.get("text") or "").strip()
        image_paths = self._extract_image_paths(event)
        if not text and not image_paths:
            return

        from channels.agent_utils import handle_agent_command, resolve_agent
        from channels.dir_utils import handle_dir_command, resolve_working_dir
        from taskboard import ScheduleType, Task

        reply_to_message_id = event.get("reply_to_message_id") or ""
        reply_to_message_title = event.get("reply_to_message_title") or ""
        reply_to_message_text = event.get("reply_to_message_text") or ""
        peer_id = event.get("peer_id") or event.get("from_user_id") or ""
        account_id = event.get("account_id") or ""
        context_token = event.get("context_token") or ""
        message_id = event.get("message_id") or ""
        peer_key = self._peer_key(account_id, peer_id)

        new_match = WEIXIN_NEW_SESSION_RE.match(text) if text else None
        force_new_session = bool(new_match)
        if force_new_session:
            text = (new_match.group(1) or "").strip()
            self._clear_peer_current_task(peer_key)
            if not text and not image_paths:
                self._reply_to_event(event, "🆕 已开启新的 Weixin session，请发送新的任务内容。")
                return

        dir_reply = handle_dir_command(text, "weixin", self.db)
        if dir_reply is not None:
            self._reply_to_event(event, dir_reply)
            return

        agent_reply = handle_agent_command(text, "weixin", self.db)
        if agent_reply is not None:
            self._reply_to_event(event, agent_reply)
            return

        task_id = None
        if reply_to_message_id:
            with self._notification_lock:
                task_id = self._notification_map.get(reply_to_message_id)

        if task_id is None:
            task_id = self._extract_task_id_from_reply_reference(
                reply_to_message_title,
                reply_to_message_text,
            )

        if task_id is None and not force_new_session:
            task_id = self._get_peer_current_task(peer_key)

        if task_id is not None and not force_new_session:
            task = self.db.get_task(task_id)
            if task and task.get("session_id"):
                updates = self._build_resume_updates(text, image_paths)
                self.db.update_task(task_id, **updates)
                with self._origin_lock:
                    self._task_origin[task_id] = {
                        "account_id": account_id,
                        "peer_id": peer_id,
                        "context_token": context_token,
                        "message_id": message_id,
                    }
                self._set_peer_current_task(peer_key, task_id)
                self._reply_to_event(event, f"▶️ 收到！正在唤醒 Task #{task_id}，请稍候～")
                return
            if reply_to_message_id or reply_to_message_title or reply_to_message_text:
                self._reply_to_event(event, f"❌ Task #{task_id} has no saved session to resume.")
                return

        prompt = text or self._default_image_prompt(image_paths)
        prompt_images = self._build_prompt_images(image_paths)
        task = Task(
            title=f"[Weixin] {prompt[:60]}{'…' if len(prompt) > 60 else ''}",
            prompt=prompt,
            working_dir=resolve_working_dir(prompt, "weixin", self.db),
            schedule_type=ScheduleType.IMMEDIATE,
            tags="weixin",
            image_paths=image_paths,
            prompt_images=prompt_images,
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
        self._set_peer_current_task(peer_key, task_id)
        self._reply_to_event(event, f"Task #{task_id} is running…")

    def _peer_key(self, account_id: str, peer_id: str) -> str:
        return f"{account_id}:{peer_id}"

    def _get_peer_current_task(self, peer_key: str) -> Optional[int]:
        with self._peer_lock:
            return self._peer_current_task.get(peer_key)

    def _set_peer_current_task(self, peer_key: str, task_id: int) -> None:
        if not peer_key:
            return
        with self._peer_lock:
            self._peer_current_task[peer_key] = task_id

    def _clear_peer_current_task(self, peer_key: str) -> None:
        with self._peer_lock:
            self._peer_current_task.pop(peer_key, None)

    def _default_image_prompt(self, image_paths: list[str]) -> str:
        if len(image_paths) == 1:
            return "请分析这张图片。"
        return f"请分析这 {len(image_paths)} 张图片。"

    def _extract_image_paths(self, event: dict[str, Any]) -> list[str]:
        paths: list[str] = []
        raw_paths = event.get("image_paths")
        if isinstance(raw_paths, list):
            paths.extend(str(path) for path in raw_paths if path)
        raw_images = event.get("images")
        if isinstance(raw_images, list):
            for image in raw_images:
                if not isinstance(image, dict):
                    continue
                path = image.get("path") or image.get("local_path")
                if path:
                    paths.append(str(path))
        return self._dedupe_image_paths(paths)

    def _build_resume_updates(self, prompt: str, image_paths: list[str]) -> dict[str, Any]:
        resume_prompt = prompt or self._default_image_prompt(image_paths)
        updates: dict[str, Any] = {
            "status": "pending",
            "prompt": resume_prompt,
            "result": None,
            "error": None,
            "question": None,
        }
        if image_paths:
            updates["image_paths"] = json.dumps(image_paths, ensure_ascii=False)
            updates["prompt_images"] = json.dumps(
                self._build_prompt_images(image_paths),
                ensure_ascii=False,
            )
        return updates

    def _build_prompt_images(self, image_paths: list[str]) -> list[dict[str, str]]:
        prompt_images = []
        for image_path in image_paths:
            try:
                with open(image_path, "rb") as image_file:
                    data = base64.b64encode(image_file.read()).decode("utf-8")
            except OSError as exc:
                print(f"[Weixin] Failed to read inbound image {image_path}: {exc}")
                continue
            prompt_images.append(
                {
                    "name": Path(image_path).name,
                    "media_type": self._image_media_type(image_path),
                    "data": data,
                }
            )
        return prompt_images

    def _image_media_type(self, image_path: str) -> str:
        suffix = Path(image_path).suffix.lower()
        if suffix == ".png":
            return "image/png"
        if suffix in {".jpg", ".jpeg"}:
            return "image/jpeg"
        if suffix == ".gif":
            return "image/gif"
        if suffix == ".webp":
            return "image/webp"
        try:
            with open(image_path, "rb") as image_file:
                header = image_file.read(12)
        except OSError:
            return "image/jpeg"
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if header.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if header.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        if header.startswith(b"RIFF") and b"WEBP" in header:
            return "image/webp"
        return "image/jpeg"

    def _collect_generated_image_paths(
        self,
        task_id: int,
        content: str,
        task: Optional[dict[str, Any]] = None,
    ) -> list[str]:
        paths = self._generated_image_paths_for_task(task_id)
        paths.extend(
            self._generated_image_paths_from_markdown(
                content,
                working_dir=(task or {}).get("working_dir"),
            )
        )
        return self._dedupe_image_paths(paths)

    def _generated_image_paths_for_task(self, task_id: int) -> list[str]:
        try:
            runs = self.db.get_task_runs(task_id, limit=1)
        except Exception as exc:
            print(f"[Weixin] Failed to load runs for generated images: {exc}")
            return []
        if not isinstance(runs, list) or not runs:
            return []

        run_id = runs[0].get("id") if isinstance(runs[0], dict) else None
        if not run_id:
            return []
        try:
            events = self.db.get_run_output_events(run_id, limit=1000)
        except Exception as exc:
            print(f"[Weixin] Failed to load output events for generated images: {exc}")
            return []
        if not isinstance(events, list):
            return []

        paths = []
        for event in events:
            if not isinstance(event, dict) or event.get("event_type") != "generated_image":
                continue
            try:
                payload = json.loads(event.get("content") or "{}")
            except json.JSONDecodeError:
                continue
            path = payload.get("path") if isinstance(payload, dict) else None
            if path:
                paths.append(path)
        return paths

    def _generated_image_paths_from_markdown(
        self,
        content: str,
        working_dir: Optional[str] = None,
    ) -> list[str]:
        paths = []
        for match in WEIXIN_MARKDOWN_IMAGE_RE.finditer(content or ""):
            image_path = self._local_image_path_from_reference(match.group(1), working_dir)
            if image_path:
                paths.append(image_path)
        return paths

    def _local_image_path_from_reference(
        self,
        reference: str,
        working_dir: Optional[str] = None,
    ) -> Optional[str]:
        target = self._markdown_image_reference_target(reference)
        if not target or target.startswith(("http://", "https://", "data:")):
            return None
        if target.startswith("file://"):
            parsed = urlparse(target)
            target = parsed.path
        elif target.startswith("sandbox:"):
            target = target[len("sandbox:") :]
        target = unquote(target).strip()
        if not target:
            return None

        path = Path(target).expanduser()
        if not path.is_absolute() and working_dir:
            path = Path(working_dir).expanduser() / path
        return self._canonical_image_path(str(path))

    def _markdown_image_reference_target(self, reference: str) -> str:
        raw = (reference or "").strip()
        if not raw:
            return ""
        if raw.startswith("<"):
            end = raw.find(">")
            if end >= 0:
                return raw[1:end].strip()
        if raw[0] in ("'", '"'):
            end = raw.find(raw[0], 1)
            if end > 0:
                return raw[1:end].strip()
        titled = re.match(r"(.+?)\s+['\"][^'\"]*['\"]\s*$", raw)
        return (titled.group(1) if titled else raw).strip()

    def _dedupe_image_paths(self, image_paths: list[str]) -> list[str]:
        deduped = []
        seen = set()
        for image_path in image_paths:
            canonical = self._canonical_image_path(image_path)
            if not canonical or canonical in seen:
                continue
            seen.add(canonical)
            deduped.append(canonical)
        return deduped

    def _canonical_image_path(self, image_path: str) -> Optional[str]:
        try:
            path = Path(image_path).expanduser()
            if path.suffix.lower() not in WEIXIN_UPLOADABLE_IMAGE_SUFFIXES:
                return None
            if not path.is_file():
                return None
            return str(path.resolve())
        except OSError:
            return None

    def _hide_generated_image_paths(
        self,
        content: str,
        image_count: int,
        uploaded_paths: Optional[list[str]] = None,
    ) -> str:
        uploaded = {
            canonical
            for path in (uploaded_paths or [])
            if (canonical := self._canonical_image_path(path))
        }
        lines = []
        for line in (content or "").splitlines():
            stripped = line.strip()
            if not stripped:
                lines.append("")
                continue
            if self._line_is_uploaded_image_path(stripped, uploaded):
                continue
            cleaned_line = self._remove_uploaded_markdown_image_refs(line, uploaded)
            visible = cleaned_line.strip()
            if visible and visible not in {"-", "*", "+"}:
                lines.append(cleaned_line.rstrip())
        cleaned = "\n".join(lines).strip()
        if not cleaned or cleaned.startswith("已生成"):
            return f"已生成 {image_count} 张图片。"
        return cleaned

    def _line_is_uploaded_image_path(self, stripped_line: str, uploaded_paths: set[str]) -> bool:
        if not stripped_line.startswith("- "):
            return False
        candidate = stripped_line[2:].strip()
        canonical = self._canonical_image_path(candidate)
        if canonical and canonical in uploaded_paths:
            return True
        return "/.codex/generated_images/" in stripped_line

    def _remove_uploaded_markdown_image_refs(self, line: str, uploaded_paths: set[str]) -> str:
        if not uploaded_paths:
            return line

        def replace(match: re.Match) -> str:
            image_path = self._local_image_path_from_reference(match.group(1))
            canonical = self._canonical_image_path(image_path) if image_path else None
            return "" if canonical in uploaded_paths else match.group(0)

        return WEIXIN_MARKDOWN_IMAGE_RE.sub(replace, line)

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

    def _extract_task_id_from_reply_reference(self, *parts: str) -> Optional[int]:
        for part in parts:
            if not part:
                continue
            match = re.search(r"\bTask\s+#(\d+)\b", part)
            if match:
                return int(match.group(1))
        return None

    def _send_command(self, payload: dict[str, Any]) -> None:
        proc_alive = self._bridge_proc and self._bridge_proc.poll() is None
        stdin_ok = bool(self._bridge_proc and self._bridge_proc.stdin)
        print(
            f"[Weixin] _send_command: type={payload.get('type')} proc_alive={proc_alive} stdin_ok={stdin_ok}"
        )
        if not self._bridge_proc or not self._bridge_proc.stdin:
            print("[Weixin] _send_command: bridge not running, command dropped")
            return
        self._bridge_proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._bridge_proc.stdin.flush()

    def request_login(self) -> None:
        print("[Weixin] request_login: called")
        self._update_status(
            configured=False,
            login_status="idle",
            qr_code_url="",
            last_error="",
            user_id="",
        )
        self._send_command({"type": "login"})

    def request_logout(self) -> None:
        print("[Weixin] request_logout: called")
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
