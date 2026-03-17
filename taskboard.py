"""
AgentForge - macOS App
A kanban-style task board for orchestrating AI coding agents with cron scheduling and delayed execution.
"""

import sqlite3
import subprocess
import json
import threading
import time
import os
import signal
import sys
import shutil
import secrets
import logging
from contextlib import contextmanager
from datetime import datetime, timedelta
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Callable
from pathlib import Path
from croniter import croniter

log_level = os.environ.get("AGENTFORGE_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, log_level, logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("agentforge")
from taskboard_bus import (
    MessageBus,
    BusAwareSchedulerMixin,
    OutboundMessageType,
    UIChannel,
)

try:
    from channels.feishu_channel import FeishuChannel
    FEISHU_CHANNEL_AVAILABLE = True
except ImportError:
    FEISHU_CHANNEL_AVAILABLE = False
    FeishuChannel = None

try:
    from channels.telegram_channel import create_telegram_channel
    TELEGRAM_CHANNEL_AVAILABLE = True
except ImportError:
    TELEGRAM_CHANNEL_AVAILABLE = False
    create_telegram_channel = None

try:
    from channels.slack_channel import SlackChannel
    SLACK_CHANNEL_AVAILABLE = True
except ImportError:
    SLACK_CHANNEL_AVAILABLE = False
    SlackChannel = None


# ──────────────────────────── Helpers ────────────────────────────

def _get_env() -> dict:
    """Return os.environ augmented with common macOS tool install paths.
    Electron (and other GUI launchers) inherit a stripped PATH that often
    misses npm globals, Homebrew, and ~/.local/bin.
    """
    env = os.environ.copy()
    home = os.path.expanduser("~")
    extra = [
        f"{home}/.local/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",       # Apple-silicon Homebrew
        "/usr/local/opt/node/bin",
        f"{home}/.npm/bin",
        f"{home}/.nvm/current/bin",
        "/usr/bin",
        "/bin",
    ]
    current = env.get("PATH", "")
    env["PATH"] = ":".join(p for p in extra if p not in current) + (f":{current}" if current else "")
    return env


# ──────────────────────────── Models ────────────────────────────

class TaskStatus(str, Enum):
    PENDING = "pending"
    SCHEDULED = "scheduled"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    BLOCKED = "blocked"          # has unmet upstream dependencies


class ScheduleType(str, Enum):
    IMMEDIATE = "immediate"
    DELAYED = "delayed"      # run after N seconds
    SCHEDULED_AT = "scheduled_at"  # run at a specific datetime
    CRON = "cron"            # recurring cron expression


@dataclass
class Task:
    id: Optional[int] = None
    title: str = ""
    prompt: str = ""
    working_dir: str = "."
    status: TaskStatus = TaskStatus.PENDING
    schedule_type: ScheduleType = ScheduleType.IMMEDIATE
    cron_expr: Optional[str] = None          # e.g. "*/30 * * * *"
    delay_seconds: Optional[int] = None      # e.g. 300
    next_run_at: Optional[str] = None        # ISO timestamp
    last_run_at: Optional[str] = None
    result: Optional[str] = None
    error: Optional[str] = None
    run_count: int = 0
    max_runs: Optional[int] = None           # None = unlimited for cron
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    tags: str = ""                           # comma-separated
    agent: str = "claude"
    question: Optional[str] = None           # question the agent asked
    answer: Optional[str] = None             # user's answer
    session_id: Optional[str] = None         # claude session id for --resume
    prompt_images: list = field(default_factory=list)  # [{media_type, data, name}]
    image_paths: list = field(default_factory=list)    # list of local image file paths
    dag_id: Optional[str] = None             # optional DAG workflow group label
    feishu_root_msg_id: Optional[str] = None  # Feishu root message_id that created this task


# ──────────────────────────── Database ────────────────────────────

class TaskDB:
    def __init__(self, db_path: str = "~/.agentforge/tasks.db"):
        self.db_path = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()  # RLock allows transaction() to nest with per-method locking
        self._init_db()

    def _init_db(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                prompt TEXT NOT NULL,
                working_dir TEXT DEFAULT '.',
                status TEXT DEFAULT 'pending',
                schedule_type TEXT DEFAULT 'immediate',
                cron_expr TEXT,
                delay_seconds INTEGER,
                next_run_at TEXT,
                last_run_at TEXT,
                result TEXT,
                error TEXT,
                run_count INTEGER DEFAULT 0,
                max_runs INTEGER,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                tags TEXT DEFAULT '',
                agent TEXT DEFAULT 'claude',
                question TEXT,
                answer TEXT
            )
        """)
        # Migration: add agent column if it doesn't exist (for existing DBs)
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT 'claude'")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add question/answer columns
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN question TEXT")
            self.conn.execute("ALTER TABLE tasks ADD COLUMN answer TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Columns already exist
        # Migration: add session_id column
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN session_id TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add prompt_images column
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN prompt_images TEXT DEFAULT '[]'")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add image_paths column
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN image_paths TEXT DEFAULT '[]'")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add notify_slack_channel column
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN notify_slack_channel TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add notify_telegram_chat_id column
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN notify_telegram_chat_id TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS task_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                started_at TEXT DEFAULT (datetime('now')),
                finished_at TEXT,
                status TEXT,
                result TEXT,
                error TEXT,
                raw_output TEXT,
                FOREIGN KEY (task_id) REFERENCES tasks(id)
            )
        """)
        # Migration: add raw_output column to task_runs
        try:
            self.conn.execute("ALTER TABLE task_runs ADD COLUMN raw_output TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists

        # Create task_output_events table for structured output recording
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS task_output_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                run_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (task_id) REFERENCES tasks(id),
                FOREIGN KEY (run_id) REFERENCES task_runs(id)
            )
        """)

        # Create indexes for performance
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_task_output_events_task_id
            ON task_output_events(task_id)
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_task_output_events_run_id
            ON task_output_events(run_id)
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_task_output_events_timestamp
            ON task_output_events(timestamp)
        """)

        # DAG dependency table
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS task_dependencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL,
                depends_on_task_id INTEGER NOT NULL,
                inject_result INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (task_id) REFERENCES tasks(id),
                FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id),
                UNIQUE(task_id, depends_on_task_id)
            )
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_task_deps_task_id
            ON task_dependencies(task_id)
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on
            ON task_dependencies(depends_on_task_id)
        """)

        # Migration: add dag_id column to tasks
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN dag_id TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists
        # Migration: add feishu_root_msg_id column for post-restart resume
        try:
            self.conn.execute("ALTER TABLE tasks ADD COLUMN feishu_root_msg_id TEXT")
            self.conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists

        self.conn.commit()

        # On startup, reset any tasks left in 'running' state — they were
        # interrupted by a process kill (e.g. hot reload) and will never
        # self-transition to completed/failed without this reset.
        now = datetime.now().isoformat()
        self.conn.execute("""
            UPDATE tasks
            SET status = 'failed',
                error  = 'Interrupted: process was restarted while task was running',
                updated_at = ?
            WHERE status = 'running'
        """, (now,))
        # Also close out any open task_runs rows that have no finished_at
        self.conn.execute("""
            UPDATE task_runs
            SET status = 'failed',
                finished_at = ?,
                error = 'Interrupted: process was restarted while task was running'
            WHERE finished_at IS NULL
        """, (now,))
        self.conn.commit()

    @contextmanager
    def transaction(self):
        """Acquire the DB lock and run statements in an explicit transaction.

        On success the transaction is committed; on any exception it is rolled
        back and the exception re-raised.  Callers must NOT call commit() or
        rollback() themselves inside this block.
        """
        with self.lock:
            self.conn.execute("BEGIN")
            try:
                yield self.conn
                self.conn.execute("COMMIT")
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def add_task(self, task: Task) -> int:
        with self.lock:
            now = datetime.now().isoformat()
            logger.debug(f"add_task called with image_paths: {task.image_paths}")
            image_paths_json = json.dumps(task.image_paths, ensure_ascii=False)
            logger.debug(f"image_paths JSON: {image_paths_json}")
            cur = self.conn.execute("""
                INSERT INTO tasks (title, prompt, working_dir, status, schedule_type,
                    cron_expr, delay_seconds, next_run_at, max_runs, created_at, updated_at, tags, agent, prompt_images, image_paths, dag_id, feishu_root_msg_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (task.title, task.prompt, task.working_dir, task.status.value,
                  task.schedule_type.value, task.cron_expr, task.delay_seconds,
                  task.next_run_at, task.max_runs, now, now, task.tags, task.agent,
                  json.dumps(task.prompt_images, ensure_ascii=False),
                  image_paths_json, task.dag_id, task.feishu_root_msg_id))
            self.conn.commit()
            task_id = cur.lastrowid
            logger.debug(f"Task {task_id} inserted with image_paths")
            return task_id

    def get_task_by_feishu_root_msg(self, root_msg_id: str) -> Optional[dict]:
        """Look up the most recent task created from a given Feishu root message ID."""
        with self.lock:
            row = self.conn.execute(
                "SELECT * FROM tasks WHERE feishu_root_msg_id = ? ORDER BY id DESC LIMIT 1",
                (root_msg_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_setting(self, key: str, default: str = None) -> Optional[str]:
        with self.lock:
            row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str):
        with self.lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, value))
            self.conn.commit()

    ALLOWED_TASK_COLUMNS = frozenset({
        "title", "prompt", "working_dir", "status", "schedule_type",
        "cron_expr", "delay_seconds", "next_run_at", "last_run_at",
        "result", "error", "run_count", "max_runs",
        "updated_at", "tags", "agent", "question", "answer",
        "session_id", "prompt_images", "image_paths", "dag_id",
    })

    def update_task(self, task_id: int, **kwargs):
        invalid = set(kwargs) - self.ALLOWED_TASK_COLUMNS
        if invalid:
            raise ValueError(f"Invalid task column(s): {invalid}")
        with self.lock:
            kwargs["updated_at"] = datetime.now().isoformat()
            sets = ", ".join(f"{k} = ?" for k in kwargs)
            vals = list(kwargs.values()) + [task_id]
            self.conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", vals)
            self.conn.commit()

    def _deserialize_task(self, row) -> dict:
        d = dict(row)
        # Deserialize prompt_images
        raw = d.get("prompt_images")
        if isinstance(raw, str):
            try:
                d["prompt_images"] = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                d["prompt_images"] = []
        elif d.get("prompt_images") is None:
            d["prompt_images"] = []
        # Deserialize image_paths
        raw_paths = d.get("image_paths")
        if isinstance(raw_paths, str):
            try:
                d["image_paths"] = json.loads(raw_paths)
            except (json.JSONDecodeError, ValueError):
                d["image_paths"] = []
        elif d.get("image_paths") is None:
            d["image_paths"] = []
        return d

    def get_task(self, task_id: int) -> Optional[dict]:
        with self.lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            return self._deserialize_task(row) if row else None

    def get_all_tasks(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
            return [self._deserialize_task(r) for r in rows]

    def get_due_tasks(self) -> list[dict]:
        now = datetime.now().isoformat()
        with self.lock:
            rows = self.conn.execute("""
                SELECT * FROM tasks
                WHERE status IN ('pending', 'scheduled')
                  AND (next_run_at IS NULL OR next_run_at <= ?)
            """, (now,)).fetchall()
            return [self._deserialize_task(r) for r in rows]

    def add_run(self, task_id: int) -> int:
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO task_runs (task_id, status) VALUES (?, 'running')",
                (task_id,))
            self.conn.commit()
            return cur.lastrowid

    def finish_run(self, run_id: int, status: str, result: str = None, error: str = None, raw_output: str = None):
        with self.lock:
            self.conn.execute("""
                UPDATE task_runs SET finished_at = datetime('now'),
                    status = ?, result = ?, error = ?, raw_output = ?
                WHERE id = ?
            """, (status, result, error, raw_output, run_id))
            self.conn.commit()

    def finish_run_and_update_task(self, run_id: int, run_status: str, task_id: int, task_updates: dict,
                                   run_result: str = None, run_error: str = None, raw_output: str = None):
        """Atomically finish a run record and update the parent task in one transaction."""
        task_updates = dict(task_updates)
        task_updates["updated_at"] = datetime.now().isoformat()
        sets = ", ".join(f"{k} = ?" for k in task_updates)
        vals = list(task_updates.values()) + [task_id]
        with self.transaction():
            self.conn.execute("""
                UPDATE task_runs SET finished_at = datetime('now'),
                    status = ?, result = ?, error = ?, raw_output = ?
                WHERE id = ?
            """, (run_status, run_result, run_error, raw_output, run_id))
            self.conn.execute(f"UPDATE tasks SET {sets} WHERE id = ?", vals)

    def get_task_runs(self, task_id: int, limit: int = 20) -> list[dict]:
        with self.lock:
            rows = self.conn.execute("""
                SELECT * FROM task_runs WHERE task_id = ?
                ORDER BY started_at DESC LIMIT ?
            """, (task_id, limit)).fetchall()
            return [dict(r) for r in rows]

    def add_output_event(self, task_id: int, run_id: int, event_type: str, content: str):
        """Add a new output event to the database."""
        with self.lock:
            self.conn.execute("""
                INSERT INTO task_output_events (task_id, run_id, event_type, content)
                VALUES (?, ?, ?, ?)
            """, (task_id, run_id, event_type, content))
            self.conn.commit()

    def get_output_events(self, task_id: int, limit: int = 1000, offset: int = 0) -> list[dict]:
        """Get output events for a task, ordered by timestamp."""
        with self.lock:
            rows = self.conn.execute("""
                SELECT * FROM task_output_events
                WHERE task_id = ?
                ORDER BY timestamp DESC
                LIMIT ? OFFSET ?
            """, (task_id, limit, offset)).fetchall()
            return [dict(r) for r in rows]

    def get_run_output_events(self, run_id: int, limit: int = 1000) -> list[dict]:
        """Get output events for a specific run."""
        with self.lock:
            rows = self.conn.execute("""
                SELECT * FROM task_output_events
                WHERE run_id = ?
                ORDER BY timestamp ASC
                LIMIT ?
            """, (run_id, limit)).fetchall()
            return [dict(r) for r in rows]

    def add_dependency(self, task_id: int, depends_on_task_id: int, inject_result: bool = False):
        with self.lock:
            self.conn.execute("""
                INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, inject_result)
                VALUES (?, ?, ?)
            """, (task_id, depends_on_task_id, 1 if inject_result else 0))
            self.conn.commit()

    def add_dependencies_batch(self, task_id: int, dep_list: list):
        """Insert multiple dependency rows for task_id in a single transaction.

        dep_list: list of dicts with keys task_id (upstream) and inject_result.
        Rolls back all inserts if any one fails.
        """
        with self.transaction():
            for dep in dep_list:
                self.conn.execute("""
                    INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, inject_result)
                    VALUES (?, ?, ?)
                """, (task_id, dep["task_id"], 1 if dep["inject_result"] else 0))

    def remove_dependency(self, task_id: int, depends_on_task_id: int):
        with self.lock:
            self.conn.execute("""
                DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?
            """, (task_id, depends_on_task_id))
            self.conn.commit()

    def clear_dependencies(self, task_id: int):
        """Remove all upstream dependencies for a task."""
        with self.lock:
            self.conn.execute(
                "DELETE FROM task_dependencies WHERE task_id = ?", (task_id,))
            self.conn.commit()

    def get_dependencies(self, task_id: int) -> list[dict]:
        """Return upstream tasks that task_id depends on."""
        with self.lock:
            rows = self.conn.execute("""
                SELECT td.*, t.title as depends_on_title, t.status as depends_on_status
                FROM task_dependencies td
                JOIN tasks t ON t.id = td.depends_on_task_id
                WHERE td.task_id = ?
            """, (task_id,)).fetchall()
            return [dict(r) for r in rows]

    def get_dependents(self, task_id: int) -> list[dict]:
        """Return downstream tasks that depend on task_id."""
        with self.lock:
            rows = self.conn.execute("""
                SELECT td.*, t.title as task_title, t.status as task_status
                FROM task_dependencies td
                JOIN tasks t ON t.id = td.task_id
                WHERE td.depends_on_task_id = ?
            """, (task_id,)).fetchall()
            return [dict(r) for r in rows]

    def get_dag_tasks(self, dag_id: str) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM tasks WHERE dag_id = ? ORDER BY created_at ASC", (dag_id,)
            ).fetchall()
            return [self._deserialize_task(r) for r in rows]

    def delete_task(self, task_id: int):
        with self.transaction():
            self.conn.execute("DELETE FROM task_output_events WHERE task_id = ?", (task_id,))
            self.conn.execute("DELETE FROM task_runs WHERE task_id = ?", (task_id,))
            self.conn.execute("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?", (task_id, task_id))
            self.conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))


# ──────────────────────────── Agent Executor ────────────────────────────

class AgentExecutor:
    """Executes prompts via configurable AI agent CLIs."""

    @staticmethod
    def run(prompt: str, working_dir: str = ".", timeout: int = 600, image_paths: list[str] = None) -> tuple[bool, str]:
        """
        Run a prompt through Claude Code CLI.
        Returns (success: bool, output: str)

        Args:
            prompt: The text prompt to send
            working_dir: Working directory for the command
            timeout: Command timeout in seconds
            image_paths: Optional list of image file paths to include
        """
        try:
            cmd = ["claude", "-p", prompt]

            # Add image paths if provided
            if image_paths:
                for img_path in image_paths:
                    cmd.extend(["-i", img_path])

            cmd.extend(["--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"])

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=os.path.expanduser(working_dir),
                timeout=timeout,
                env=_get_env(),
            )
            if result.returncode == 0:
                output = result.stdout
                for line in reversed(result.stdout.splitlines()):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            if event.get("type") == "result":
                                output = event.get("result", result.stdout)
                                break
                        except json.JSONDecodeError:
                            pass
                return True, output
            else:
                return False, result.stderr or result.stdout
        except FileNotFoundError:
            return False, "claude CLI not found. Is it installed?"
        except subprocess.TimeoutExpired:
            return False, f"claude CLI timed out after {timeout}s"
        except OSError as e:
            return False, str(e)



# ──────────────────────────── Scheduler ────────────────────────────

class TaskScheduler(BusAwareSchedulerMixin):
    """Background scheduler that checks and runs due tasks."""

    def __init__(self, db: TaskDB, on_task_update: Optional[Callable] = None,
                 bus: Optional[MessageBus] = None):
        self.db = db
        self.executor = AgentExecutor()
        self.on_task_update = on_task_update
        self.bus = bus  # MessageBus integration (optional)
        self._channels: list = []  # generic Channel instances (e.g. TelegramChannel)
        self._running = False
        self._shutting_down = False
        self._thread: Optional[threading.Thread] = None
        self._active_tasks: dict[int, threading.Thread] = {}
        self._live_output: dict[int, str] = {}  # task_id -> accumulated stdout
        self._active_pgids: dict[int, int] = {}  # task_id -> process group id

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("Scheduler started")

    def stop(self):
        self._shutting_down = True
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)
        # Wait up to 5 seconds for running tasks to finish
        deadline = time.time() + 5
        running = {tid: t for tid, t in self._active_tasks.items() if t.is_alive()}
        if running:
            logger.info(f"Waiting for {len(running)} running task(s) to finish...")
            for tid, t in running.items():
                remaining = max(0, deadline - time.time())
                t.join(timeout=remaining)
        # Gracefully terminate any processes still alive, then force-kill if needed
        for tid, pgid in list(self._active_pgids.items()):
            try:
                os.killpg(pgid, signal.SIGTERM)
                logger.info(f"Sent SIGTERM to task {tid} (pgid {pgid})")
            except OSError:
                continue
            # Wait up to 5 seconds for the process group to exit
            deadline = time.time() + 5
            while time.time() < deadline:
                try:
                    os.killpg(pgid, 0)  # check if still alive
                except OSError:
                    break  # process group is gone
                time.sleep(0.1)
            else:
                # Still alive — escalate to SIGKILL
                logger.warning(f"Force-killing task {tid} (pgid {pgid}) after SIGTERM timeout")
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError as e:
                    logger.error(f"killpg({pgid}) SIGKILL failed: {e}")
        logger.info("Scheduler stopped")

    def _loop(self):
        while self._running:
            try:
                self._tick()
            except Exception as e:
                logger.error(f"Scheduler error: {e}")
            time.sleep(2)  # check every 2 seconds

    def _tick(self):
        if self._shutting_down:
            return
        due_tasks = self.db.get_due_tasks()
        for task in due_tasks:
            tid = task["id"]
            if tid in self._active_tasks and self._active_tasks[tid].is_alive():
                continue  # already running
            # Check if it's time
            if task["schedule_type"] == "immediate" and task["status"] == "pending":
                self._spawn_task(task)
            elif task["schedule_type"] == "delayed" and task["status"] == "pending":
                self._schedule_delayed(task)
            elif task["schedule_type"] == "delayed" and task["status"] == "scheduled":
                nra = task.get("next_run_at")
                if nra and datetime.fromisoformat(nra) <= datetime.now():
                    self._spawn_task(task)
            elif task["schedule_type"] == "scheduled_at" and task["status"] == "scheduled":
                nra = task.get("next_run_at")
                if nra and datetime.fromisoformat(nra) <= datetime.now():
                    self._spawn_task(task)
            elif task["schedule_type"] == "cron" and task["status"] == "scheduled":
                nra = task.get("next_run_at")
                if nra and datetime.fromisoformat(nra) <= datetime.now():
                    self._spawn_task(task)

    def _schedule_delayed(self, task: dict):
        delay = task.get("delay_seconds", 0) or 0
        run_at = datetime.now() + timedelta(seconds=delay)
        self.db.update_task(task["id"],
                            status="scheduled",
                            next_run_at=run_at.isoformat())
        self._notify(task["id"])

    def _spawn_task(self, task: dict):
        # Register the thread in _active_tasks *before* updating the DB so
        # that if the thread crashes immediately after the DB write, the task
        # is still visible in _active_tasks and won't be re-picked by _tick().
        t = threading.Thread(target=self._execute_task, args=(task,), daemon=True)
        self._active_tasks[task["id"]] = t
        self.db.update_task(task["id"], status="running")
        t.start()

    def _parse_codex_event(self, event: dict) -> tuple:
        """Normalize a Codex JSONL event into (event_type, content) for storage.

        Returns (None, None) to skip events that carry no displayable content.
        """
        etype = event.get("type", "")
        if etype == "item.completed":
            item = event.get("item", {})
            itype = item.get("type", "")
            if itype == "agent_message":
                return "assistant", item.get("text", "")
            elif itype == "reasoning":
                text = item.get("text", "")
                return ("assistant", f"[thinking] {text}") if text else (None, None)
            elif itype == "command_execution":
                cmd = item.get("command", "")
                out = item.get("aggregated_output", "")
                content = f"$ {cmd}\n{out}".strip() if cmd else json.dumps(event, ensure_ascii=False)
                return etype, content
            else:
                return etype, json.dumps(event, ensure_ascii=False)
        elif etype == "turn.failed":
            err = event.get("error", {})
            msg = err.get("message", "") if isinstance(err, dict) else str(err)
            return "error", msg
        elif etype == "error":
            return "error", event.get("message", "")
        elif etype == "turn.completed":
            # turn.completed only carries usage stats; final text comes from agent_message items
            return None, None
        elif etype in ("thread.started", "turn.started", "item.started", "item.updated"):
            return None, None
        else:
            return etype, json.dumps(event, ensure_ascii=False)

    def _parse_and_store_event(self, task_id: int, run_id: int, line: str, agent: str = "claude"):
        """Parse a line from the output stream and store it as an event."""
        if not line.strip():
            return

        try:
            event = json.loads(line)

            if agent == "codex":
                event_type, content = self._parse_codex_event(event)
                if event_type and content:
                    self.db.add_output_event(task_id, run_id, event_type, content)
                return

            # Claude stream-json
            event_type = event.get("type", "unknown")
            if event_type in ("user", "assistant"):
                text_content, image_events = self._extract_message_content(event)
                if text_content:
                    self.db.add_output_event(task_id, run_id, event_type, text_content)
                for img_json in image_events:
                    self.db.add_output_event(task_id, run_id, "image_content", img_json)
            else:
                content = ""
                if event_type == "result":
                    content = event.get("result", "")
                elif event_type == "error":
                    content = event.get("error", "")
                else:
                    # For other event types, store the full JSON
                    content = json.dumps(event, ensure_ascii=False)

                if content:
                    self.db.add_output_event(task_id, run_id, event_type, content)
        except json.JSONDecodeError:
            # If it's not valid JSON, store as raw text
            if line.strip() and len(line.strip()) > 10:  # Only store meaningful non-JSON lines
                self.db.add_output_event(task_id, run_id, "text", line.strip())

    def _extract_message_content(self, event: dict) -> tuple:
        """Extract text and image content from user/assistant messages.

        Returns (text: str, image_events: list[str]) where each image_event is a
        JSON string with {"media_type": ..., "data": ...} for image_content events.
        """
        message = event.get("message", {})
        content = message.get("content", [])
        text_parts = []
        image_events = []

        for item in content:
            if isinstance(item, str):
                text_parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    text_parts.append(item.get("text", ""))
                elif item.get("type") == "image":
                    source = item.get("source", {})
                    if source.get("type") == "base64":
                        img_json = json.dumps({
                            "media_type": source.get("media_type", "image/jpeg"),
                            "data": source.get("data", ""),
                        }, ensure_ascii=False)
                        image_events.append(img_json)
                    # Non-base64 image sources (url, etc.) are ignored silently

        return "".join(text_parts), image_events

    def _extract_error_summary(self, raw_stderr: str, raw_stdout: str) -> str:
        """Extract a clean, human-readable error summary from raw CLI output.

        The full raw output is already stored in run.raw_output; this produces
        a concise message for task.error and notification channels.
        """
        # If stderr is short and not JSON, it's likely a plain error message
        if raw_stderr and len(raw_stderr) < 2000:
            first_line = raw_stderr.strip().split('\n')[0].strip()
            if first_line and not first_line.startswith('{'):
                return raw_stderr.strip()[:1000]

        # Try to parse stdout as stream-json to find error events
        error_messages = []
        last_assistant_text = ""
        source = raw_stdout if raw_stdout else raw_stderr
        for line in source.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                event_type = event.get("type", "")
                if event_type == "error":
                    err = event.get("error", "")
                    if err:
                        error_messages.append(err)
                elif event_type == "result":
                    if event.get("subtype") == "error_during_execution":
                        err = event.get("error", event.get("result", ""))
                        if err:
                            error_messages.append(str(err))
                elif event_type == "assistant":
                    msg = event.get("message", {})
                    content = msg.get("content", [])
                    text_parts = [
                        (c if isinstance(c, str) else c.get("text", ""))
                        for c in content
                        if isinstance(c, str) or (isinstance(c, dict) and c.get("type") == "text")
                    ]
                    if text_parts:
                        last_assistant_text = "".join(text_parts)
            except json.JSONDecodeError:
                pass

        if error_messages:
            return "\n".join(error_messages)[:1000]

        if last_assistant_text:
            return last_assistant_text[:1000]

        # Fall back to raw stderr or first 500 chars of stdout
        return (raw_stderr or raw_stdout or "Unknown error").strip()[:500]

    def _execute_task(self, task: dict):
        tid = task["id"]
        self._live_output[tid] = ""
        # Status already set to "running" by _spawn_task() before thread start.
        self._notify(tid)

        run_id = self.db.add_run(tid)

        # Build command — inject upstream results if configured
        prompt = self._build_injected_prompt(task)
        prompt_images = task.get("prompt_images") or []
        image_paths = task.get("image_paths") or []  # List of local image file paths

        # Convert image_paths to prompt_images format (base64 encoded)
        if image_paths and not prompt_images:  # Only if not already using prompt_images
            import base64

            _ALLOWED_IMAGE_ROOTS = [
                os.path.expanduser("~"),
                "/tmp",
            ]

            def _is_safe_image_path(path: str) -> bool:
                """Return True only if path resolves inside an allowed directory."""
                try:
                    resolved = os.path.realpath(os.path.abspath(path))
                except Exception:
                    return False
                for root in _ALLOWED_IMAGE_ROOTS:
                    try:
                        resolved_root = os.path.realpath(root)
                        if resolved.startswith(resolved_root + os.sep) or resolved == resolved_root:
                            return True
                    except Exception:
                        continue
                return False

            for img_path in image_paths:
                if not _is_safe_image_path(img_path):
                    logger.warning(f"Task {tid}: Rejected image path outside allowed directories: {img_path}")
                    continue
                try:
                    with open(img_path, "rb") as f:
                        img_data = base64.b64encode(f.read()).decode("utf-8")

                    # Detect media type from file extension
                    img_path_lower = img_path.lower()
                    if img_path_lower.endswith(".png"):
                        media_type = "image/png"
                    elif img_path_lower.endswith((".jpg", ".jpeg")):
                        media_type = "image/jpeg"
                    elif img_path_lower.endswith(".gif"):
                        media_type = "image/gif"
                    elif img_path_lower.endswith(".webp"):
                        media_type = "image/webp"
                    else:
                        # Try to detect from magic bytes
                        with open(img_path, "rb") as f:
                            header = f.read(12)
                        if header.startswith(b'\xff\xd8\xff'):
                            media_type = "image/jpeg"
                        elif header.startswith(b'\x89PNG\r\n\x1a\n'):
                            media_type = "image/png"
                        elif header.startswith(b'GIF87a') or header.startswith(b'GIF89a'):
                            media_type = "image/gif"
                        elif header.startswith(b'RIFF') and b'WEBP' in header:
                            media_type = "image/webp"
                        else:
                            media_type = "image/jpeg"  # default fallback

                    prompt_images.append({
                        "media_type": media_type,
                        "data": img_data,
                        "name": os.path.basename(img_path)
                    })
                    logger.debug(f"Task {tid}: Loaded image {img_path} as {media_type} ({len(img_data)} bytes base64)")
                except Exception as e:
                    logger.error(f"Task {tid}: Failed to load image {img_path}: {e}")

        agent = task.get("agent", "claude")
        use_stdin = bool(prompt_images) and agent == "claude"

        if agent == "codex":
            working_dir_expanded = os.path.expanduser(task["working_dir"])
            if task.get("session_id"):
                cmd = [
                    "codex", "exec", "resume",
                    "--json",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--skip-git-repo-check",
                    task["session_id"],
                    prompt,
                ]
            else:
                cmd = [
                    "codex", "exec",
                    "--json",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--skip-git-repo-check",
                    "--cd", working_dir_expanded,
                    prompt,
                ]
            for img_path in image_paths or []:
                cmd.extend(["--image", img_path])
        elif use_stdin:
            # Claude multimodal input: pass via stdin with --input-format stream-json
            cmd = ["claude", "-p", "--input-format", "stream-json",
                   "--output-format", "stream-json", "--verbose",
                   "--permission-mode", "bypassPermissions"]
        else:
            cmd = ["claude", "-p", prompt, "--output-format", "stream-json",
                   "--verbose", "--permission-mode", "bypassPermissions"]
        if agent == "claude" and task.get("session_id"):
            cmd.extend(["--resume", task["session_id"]])
        raw_stdout = ""
        raw_stderr = ""
        try:
            timeout_secs = int(self.db.get_setting("timeout", "600"))
            start_time = time.time()
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE if use_stdin else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=os.path.expanduser(task["working_dir"]),
                env=_get_env(),
                start_new_session=True,  # Create a new process group so all sub-agents are tracked
            )
            if use_stdin:
                # Build multimodal message content
                content = [{"type": "text", "text": prompt}]
                for img in prompt_images:
                    content.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.get("media_type", "image/jpeg"),
                            "data": img.get("data", ""),
                        }
                    })
                stdin_msg = json.dumps({
                    "type": "user",
                    "message": {"role": "user", "content": content}
                })
                proc.stdin.write(stdin_msg + "\n")
                proc.stdin.close()
            pgid = os.getpgid(proc.pid)
            self._active_pgids[tid] = pgid

            # Read stderr in a background thread so it never blocks stdout reading
            stderr_chunks = []
            def _read_stderr():
                for line in proc.stderr:
                    stderr_chunks.append(line)
            stderr_thread = threading.Thread(target=_read_stderr, daemon=True)
            stderr_thread.start()

            # Timer that kills the entire process group if it exceeds the configured timeout
            timed_out = [False]
            def _kill():
                timed_out[0] = True
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError as e:
                    logger.error(f"Task {tid}: killpg({pgid}) failed: {e}, falling back to kill({proc.pid})")
                    try:
                        os.kill(proc.pid, signal.SIGKILL)
                    except OSError as e2:
                        logger.error(f"Task {tid}: kill({proc.pid}) also failed: {e2}")
            timer = threading.Timer(timeout_secs, _kill)
            timer.start()

            chunks = []
            try:
                for line in proc.stdout:
                    chunks.append(line)
                    self._live_output[tid] = "".join(chunks)
                    # Parse and store each line as an event
                    self._parse_and_store_event(tid, run_id, line, agent)
                proc.wait()
            finally:
                timer.cancel()
            stderr_thread.join(timeout=2)

            # Wait for any sub-agents still running in the process group.
            # Claude Code may spawn background Task agents that outlive the main process.
            if not timed_out[0] and proc.returncode == 0:
                elapsed = time.time() - start_time
                remaining = max(0, timeout_secs - elapsed)
                subagent_deadline = time.time() + remaining
                waiting_logged = False
                while time.time() < subagent_deadline:
                    try:
                        os.killpg(pgid, 0)  # raises ProcessLookupError when group is gone
                    except ProcessLookupError:
                        break
                    if not waiting_logged:
                        waiting_logged = True
                        logger.info(f"Task {tid}: main process exited, waiting for sub-agents...")
                    self._live_output[tid] = "".join(chunks) + "\n[⏳ Waiting for sub-agents to complete...]"
                    time.sleep(1)
                else:
                    # Sub-agents exceeded remaining timeout — kill the group
                    timed_out[0] = True
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except OSError as e:
                        logger.error(f"Task {tid}: killpg({pgid}) on sub-agent timeout failed: {e}")

            self._active_pgids.pop(tid, None)

            raw_stdout = "".join(chunks)
            raw_stderr = "".join(stderr_chunks)

            if timed_out[0]:
                success, output = False, f"Task timed out after {timeout_secs}s"
            elif proc.returncode == 0:
                if agent == "codex":
                    # Codex JSONL: final output is the last agent_message item text
                    out = ""
                    for line in raw_stdout.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            if (event.get("type") == "item.completed"
                                    and event.get("item", {}).get("type") == "agent_message"):
                                out = event["item"].get("text", "")
                        except json.JSONDecodeError:
                            pass
                    success, output = True, out or raw_stdout
                else:
                    # Claude stream-json: find the last result event and last assistant text
                    out = ""
                    last_assistant_text = ""
                    for line in raw_stdout.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            event = json.loads(line)
                            if event.get("type") == "assistant":
                                msg = event.get("message", {})
                                content = msg.get("content", [])
                                text_parts = []
                                for c in content:
                                    if isinstance(c, str):
                                        text_parts.append(c)
                                    elif isinstance(c, dict) and c.get("type") == "text":
                                        text_parts.append(c.get("text", ""))
                                if text_parts:
                                    last_assistant_text = "".join(text_parts)
                            elif event.get("type") == "result":
                                result_text = event.get("result")
                                if result_text:
                                    out = result_text
                        except json.JSONDecodeError:
                            pass
                    # If result event had no result field (e.g. error_during_execution
                    # with 0 output tokens), fall back to last assistant message text
                    if not out:
                        out = last_assistant_text
                    success, output = True, out
            else:
                success, output = False, raw_stderr or raw_stdout
        except FileNotFoundError:
            cli_name = "codex" if task.get("agent") == "codex" else "claude"
            install_hint = "Install with: npm install -g @openai/codex" if cli_name == "codex" else "Is it installed?"
            success, output = False, f"{cli_name} CLI not found. {install_hint}"
            self._active_pgids.pop(tid, None)
        except (OSError, subprocess.SubprocessError) as e:
            logger.error(f"Task {tid} subprocess error: {e}")
            success, output = False, str(e)
            self._active_pgids.pop(tid, None)

        self._live_output.pop(tid, None)

        # Extract session_id from output (format differs by agent)
        extracted_session_id = None
        if agent == "codex":
            # Codex emits session_id in the thread.started event at the beginning
            for line in raw_stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    if event.get("type") == "thread.started" and event.get("thread_id"):
                        extracted_session_id = event["thread_id"]
                        break
                except json.JSONDecodeError:
                    pass
        else:
            # Claude emits session_id in the result event at the end
            for line in reversed(raw_stdout.splitlines()):
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    if event.get("type") == "result" and event.get("session_id"):
                        extracted_session_id = event["session_id"]
                        break
                except json.JSONDecodeError:
                    pass

        # Truncate raw_output for storage (max 500KB)
        raw_output_stored = raw_stdout[:500000] if raw_stdout else None

        new_count = (task.get("run_count") or 0) + 1
        if success:
            updates = {
                "result": output[:50000],  # truncate for storage
                "last_run_at": datetime.now().isoformat(),
                "run_count": new_count,
            }
            if extracted_session_id:
                updates["session_id"] = extracted_session_id
            # Handle cron rescheduling
            cron_will_reschedule = False
            if task["schedule_type"] == "cron" and task.get("cron_expr"):
                max_runs = task.get("max_runs")
                if max_runs and new_count >= max_runs:
                    updates["status"] = "completed"
                else:
                    nxt = croniter(task["cron_expr"], datetime.now()).get_next(datetime)
                    updates["status"] = "scheduled"
                    updates["next_run_at"] = nxt.isoformat()
                    cron_will_reschedule = True
            else:
                updates["status"] = "completed"
            self.db.finish_run_and_update_task(run_id, "completed", tid, updates,
                                               run_result=output, raw_output=raw_output_stored)
            # For cron tasks that get rescheduled, notify channels with TASK_COMPLETED
            # before the status flips to "scheduled", so channels actually fire.
            if cron_will_reschedule:
                self._bus_notify(tid, override_type=OutboundMessageType.TASK_COMPLETED)
        else:
            # Extract a clean, human-readable error summary for task.error and
            # notification channels. The full raw output is preserved in run_error.
            error_summary = self._extract_error_summary(raw_stderr, raw_stdout) if (
                raw_stderr or raw_stdout
            ) else (output or "Unknown error")
            self.db.finish_run_and_update_task(
                run_id, "failed", tid,
                {
                    "status": "failed",
                    "error": error_summary,
                    "last_run_at": datetime.now().isoformat(),
                    "run_count": new_count,
                },
                run_error=output, raw_output=raw_output_stored,
            )

        self._notify(tid)
        self._active_tasks.pop(tid, None)

        # DAG: trigger downstream cascade after task finishes
        if success:
            self._on_task_completed(tid)
        else:
            self._on_task_failed(tid)

    def _notify(self, task_id: int):
        if self.on_task_update:
            self.on_task_update(task_id)
        for ch in self._channels:
            threading.Thread(
                target=ch.notify_task,
                args=(task_id,),
                daemon=True,
            ).start()
        # Publish to MessageBus (non-blocking; subscribers notified synchronously)
        self._bus_notify(task_id)

    def submit_task(self, task: Task, depends_on: list = None) -> int:
        """Add and schedule a new task.

        depends_on: list of dicts [{task_id, inject_result}] or list of ints.
        If any upstream task is not yet completed, the task starts as BLOCKED.
        """
        now = datetime.now()

        # Resolve depends_on to normalized list
        dep_list = []
        if depends_on:
            for dep in depends_on:
                if isinstance(dep, int):
                    dep_list.append({"task_id": dep, "inject_result": False})
                elif isinstance(dep, dict):
                    dep_list.append({
                        "task_id": dep["task_id"],
                        "inject_result": bool(dep.get("inject_result", False)),
                    })

        # Determine initial status: BLOCKED if any upstream not completed
        has_unmet = False
        if dep_list:
            for dep in dep_list:
                upstream = self.db.get_task(dep["task_id"])
                if not upstream or upstream["status"] != "completed":
                    has_unmet = True
                    break

        if has_unmet:
            task.status = TaskStatus.BLOCKED
        elif task.schedule_type == ScheduleType.IMMEDIATE:
            task.status = TaskStatus.PENDING
        elif task.schedule_type == ScheduleType.DELAYED:
            task.status = TaskStatus.PENDING
        elif task.schedule_type == ScheduleType.SCHEDULED_AT:
            task.status = TaskStatus.SCHEDULED
            if not task.next_run_at:
                raise ValueError("scheduled_at requires next_run_at to be set")
        elif task.schedule_type == ScheduleType.CRON:
            task.status = TaskStatus.SCHEDULED
            if task.cron_expr:
                nxt = croniter(task.cron_expr, now).get_next(datetime)
                task.next_run_at = nxt.isoformat()

        task_id = self.db.add_task(task)

        # Store dependency rows atomically — if any insert fails the whole
        # batch is rolled back so we never leave a task with partial deps.
        if dep_list:
            self.db.add_dependencies_batch(task_id, dep_list)

        return task_id

    # ──────────────────────── DAG helpers ────────────────────────

    def _build_injected_prompt(self, task: dict) -> str:
        """Prepend upstream results to the prompt for deps with inject_result=True."""
        deps = self.db.get_dependencies(task["id"])
        injections = []
        for dep in deps:
            if dep.get("inject_result"):
                upstream = self.db.get_task(dep["depends_on_task_id"])
                if upstream and upstream.get("result"):
                    injections.append(
                        f"=== Result from upstream task #{upstream['id']} ({upstream['title']}) ===\n"
                        f"{upstream['result']}\n"
                        f"=== End of upstream result ==="
                    )
        if injections:
            return "\n\n".join(injections) + "\n\n---\n\n" + task["prompt"]
        return task["prompt"]

    def _on_task_completed(self, task_id: int):
        """Check whether any blocked downstream tasks can now be unblocked."""
        dependents = self.db.get_dependents(task_id)
        for dep in dependents:
            downstream_id = dep["task_id"]
            if dep["task_status"] != "blocked":
                continue
            # Check all upstream deps of this downstream task
            all_deps = self.db.get_dependencies(downstream_id)
            if all(d["depends_on_status"] == "completed" for d in all_deps):
                # All upstream done — unblock
                downstream = self.db.get_task(downstream_id)
                if not downstream:
                    continue
                # Determine next status based on schedule_type
                stype = downstream.get("schedule_type", "immediate")
                if stype == "immediate":
                    new_status = "pending"
                elif stype == "delayed":
                    new_status = "pending"
                elif stype == "scheduled_at":
                    new_status = "scheduled"
                elif stype == "cron":
                    new_status = "scheduled"
                else:
                    new_status = "pending"
                self.db.update_task(downstream_id, status=new_status)
                logger.info(f"DAG: Task {downstream_id} unblocked (all upstream done)")
                self._notify(downstream_id)

    def _on_task_failed(self, task_id: int):
        """Cascade-cancel all blocked downstream tasks recursively."""
        to_cancel = []
        visited = set()
        queue = [task_id]
        while queue:
            current = queue.pop()
            for dep in self.db.get_dependents(current):
                downstream_id = dep["task_id"]
                if downstream_id in visited:
                    continue
                visited.add(downstream_id)
                task_status = dep["task_status"]
                if task_status in ("blocked", "pending", "scheduled"):
                    to_cancel.append((downstream_id, task_id))
                    queue.append(downstream_id)
        for downstream_id, origin_id in to_cancel:
            self.db.update_task(
                downstream_id,
                status="cancelled",
                error=f"Cancelled: upstream task #{origin_id} failed",
            )
            logger.info(f"DAG: Task {downstream_id} cascade-cancelled (upstream #{origin_id} failed)")
            self._notify(downstream_id)

    # ─────────────────────────────────────────────────────────────

    def cancel_task(self, task_id: int):
        pgid = self._active_pgids.get(task_id)
        if pgid:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
        self.db.update_task(task_id, status="cancelled")
        self._notify(task_id)

    def retry_task(self, task_id: int):
        self.db.update_task(task_id, status="pending", error=None)
        self._notify(task_id)


# ──────────────────────────── HTTP API Server ────────────────────────────

from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json

# Single CSRF token for the lifetime of this server process.
# The frontend fetches it once via GET /api/csrf-token and includes it as
# the X-CSRF-Token header on all state-changing requests.
_CSRF_TOKEN = secrets.token_hex(32)

# Origins allowed to call this API.  The Electron renderer uses file:// in
# production (Origin header is "null") and http://localhost:<port> in dev
# (Vite).  We also accept any http://localhost:* origin for tooling.
_ALLOWED_ORIGINS = {"null", "http://localhost"}


class TaskAPIHandler(BaseHTTPRequestHandler):
    """Simple REST API for the frontend to communicate with."""

    scheduler: TaskScheduler = None
    db: TaskDB = None
    feishu_channel = None
    telegram_channel = None
    slack_channel = None

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if origin and not self._is_allowed_origin(origin):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(200)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/tasks":
            tasks = self.db.get_all_tasks()
            # Attach dependency metadata to each task
            for t in tasks:
                t["dependencies"] = self.db.get_dependencies(t["id"])
                t["dependents"] = [d["task_id"] for d in self.db.get_dependents(t["id"])]
            self._json_response(tasks)

        elif path.startswith("/api/tasks/") and path.endswith("/runs"):
            tid = int(path.split("/")[3])
            runs = self.db.get_task_runs(tid)
            self._json_response(runs)

        elif path.startswith("/api/tasks/") and path.endswith("/output"):
            tid = int(path.split("/")[3])
            live = self.scheduler._live_output.get(tid, "")
            self._json_response({"output": live, "is_running": tid in self.scheduler._live_output})

        elif path.startswith("/api/tasks/") and path.endswith("/events"):
            tid = int(path.split("/")[3])
            # Parse query parameters for pagination
            query = parse_qs(urlparse(self.path).query)
            limit = int(query.get("limit", ["1000"])[0])
            offset = int(query.get("offset", ["0"])[0])
            events = self.db.get_output_events(tid, limit=limit, offset=offset)
            self._json_response({"events": events, "total": len(events)})

        elif path.startswith("/api/tasks/") and path.endswith("/messages"):
            tid = int(path.split("/")[3])
            runs = self.db.get_task_runs(tid, limit=50)
            messages = []
            for run in reversed(runs):  # oldest first
                raw = run.get("raw_output") or ""
                run_messages = []
                for line in raw.splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                        etype = event.get("type")
                        if etype == "user":
                            msg = event.get("message", {})
                            content = msg.get("content", [])
                            text = ""
                            for c in content:
                                if isinstance(c, dict) and c.get("type") == "text":
                                    text += c.get("text", "")
                                elif isinstance(c, str):
                                    text += c
                            if text.strip():
                                run_messages.append({"role": "user", "text": text, "run_id": run["id"]})
                        elif etype == "assistant":
                            msg = event.get("message", {})
                            content = msg.get("content", [])
                            text = ""
                            for c in content:
                                if isinstance(c, dict) and c.get("type") == "text":
                                    text += c.get("text", "")
                            if text.strip():
                                run_messages.append({"role": "assistant", "text": text, "run_id": run["id"]})
                    except json.JSONDecodeError:
                        pass
                messages.extend(run_messages)
            self._json_response(messages)

        elif path.startswith("/api/tasks/") and path.endswith("/dependencies"):
            tid = int(path.split("/")[3])
            self._json_response(self.db.get_dependencies(tid))

        elif path.startswith("/api/tasks/") and path.endswith("/dependents"):
            tid = int(path.split("/")[3])
            self._json_response(self.db.get_dependents(tid))

        elif path.startswith("/api/dag/"):
            dag_id = path[len("/api/dag/"):]
            tasks = self.db.get_dag_tasks(dag_id)
            for t in tasks:
                t["dependencies"] = self.db.get_dependencies(t["id"])
                t["dependents"] = [d["task_id"] for d in self.db.get_dependents(t["id"])]
            self._json_response(tasks)

        elif path.startswith("/api/tasks/"):
            tid = int(path.split("/")[3])
            task = self.db.get_task(tid)
            if task:
                task["dependencies"] = self.db.get_dependencies(tid)
                task["dependents"] = [d["task_id"] for d in self.db.get_dependents(tid)]
                self._json_response(task)
            else:
                self._json_response({"error": "not found"}, 404)

        elif path == "/api/csrf-token":
            self._json_response({"csrf_token": _CSRF_TOKEN})

        elif path == "/api/health":
            self._json_response({"status": "ok", "tasks": len(self.db.get_all_tasks())})

        elif path == "/api/settings":
            self._json_response({
                "default_agent": self.db.get_setting("default_agent", "claude"),
                "timeout": int(self.db.get_setting("timeout", "600")),
            })

        elif path == "/api/feishu/settings":
            self._json_response({
                "feishu_app_id": self.db.get_setting("feishu_app_id", ""),
                "feishu_app_secret": self.db.get_setting("feishu_app_secret", ""),
                "feishu_default_chat_id": self.db.get_setting("feishu_default_chat_id", ""),
                "feishu_default_working_dir": self.db.get_setting("feishu_default_working_dir", "~"),
                "feishu_enabled": self.db.get_setting("feishu_enabled", "false"),
            })

        elif path == "/api/channels/status":
            import os as _os
            # Tokens can come from settings DB or env vars
            tg_token = self.db.get_setting("telegram_bot_token", "") or _os.environ.get("TELEGRAM_BOT_TOKEN", "")
            sl_bot = self.db.get_setting("slack_bot_token", "") or _os.environ.get("SLACK_BOT_TOKEN", "")
            sl_app = self.db.get_setting("slack_app_token", "") or _os.environ.get("SLACK_APP_TOKEN", "")
            self._json_response({
                "telegram": {
                    "enabled": self.db.get_setting("telegram_enabled", "false") == "true",
                    "configured": bool(tg_token),
                    "running": bool(self.telegram_channel and getattr(self.telegram_channel, "_running", False)),
                    "default_working_dir": self.db.get_setting("telegram_default_working_dir", "~"),
                    "default_chat_id": self.db.get_setting("telegram_default_chat_id", ""),
                    "allowed_users": self.db.get_setting("telegram_allowed_users", ""),
                },
                "slack": {
                    "enabled": self.db.get_setting("slack_enabled", "false") == "true",
                    "configured": bool(sl_bot and sl_app),
                    "running": bool(self.slack_channel and getattr(self.slack_channel, "_running", False)),
                    "default_working_dir": self.db.get_setting("slack_default_working_dir", "~"),
                    "default_channel": self.db.get_setting("slack_default_channel", ""),
                    "default_user": self.db.get_setting("slack_default_user", ""),
                },
                "feishu": {
                    "configured": self.db.get_setting("feishu_enabled", "false") == "true",
                    "running": bool(self.feishu_channel and getattr(self.feishu_channel, "_running", False)),
                },
            })

        else:
            self._json_response({"error": "not found"}, 404)

    def do_POST(self):
        if not self._check_csrf():
            self._json_response({"error": "CSRF token missing or invalid"}, 403)
            return
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/api/tasks":
            # ── Input validation ──────────────────────────────────────
            prompt = body.get("prompt", "")
            if not prompt or not prompt.strip():
                self._json_response({"error": "prompt cannot be empty", "field": "prompt"}, 400)
                return

            working_dir = body.get("working_dir", ".")
            if working_dir and working_dir != ".":
                expanded = os.path.expanduser(working_dir)
                if not os.path.isdir(expanded):
                    self._json_response(
                        {"error": f"working_dir does not exist or is not a directory: {working_dir}", "field": "working_dir"},
                        400,
                    )
                    return

            schedule_type = body.get("schedule_type", "immediate")
            cron_expr = body.get("cron_expr")
            if schedule_type == "cron":
                if not cron_expr or not cron_expr.strip():
                    self._json_response({"error": "cron_expr is required for cron schedule", "field": "cron_expr"}, 400)
                    return
                if not croniter.is_valid(cron_expr):
                    self._json_response({"error": f"invalid cron expression: {cron_expr}", "field": "cron_expr"}, 400)
                    return
            # ─────────────────────────────────────────────────────────

            prompt_images = body.get("prompt_images", [])
            if isinstance(prompt_images, str):
                try:
                    prompt_images = json.loads(prompt_images)
                except (json.JSONDecodeError, ValueError):
                    prompt_images = []

            # Parse image_paths
            image_paths = body.get("image_paths", [])
            if isinstance(image_paths, str):
                try:
                    image_paths = json.loads(image_paths)
                except (json.JSONDecodeError, ValueError):
                    image_paths = []
            if not isinstance(image_paths, list):
                image_paths = []

            # Parse depends_on: accept list of ints or list of {task_id, inject_result}
            depends_on_raw = body.get("depends_on", [])
            depends_on = []
            if isinstance(depends_on_raw, list):
                for item in depends_on_raw:
                    if isinstance(item, int):
                        depends_on.append({"task_id": item, "inject_result": False})
                    elif isinstance(item, dict) and "task_id" in item:
                        depends_on.append({
                            "task_id": int(item["task_id"]),
                            "inject_result": bool(item.get("inject_result", False)),
                        })
            # Shorthand: global inject_result flag applies to all deps if not per-dep
            if body.get("inject_result") and depends_on:
                for d in depends_on:
                    d["inject_result"] = True

            task = Task(
                title=body.get("title", "Untitled"),
                prompt=body["prompt"],
                working_dir=body.get("working_dir", "."),
                schedule_type=ScheduleType(body.get("schedule_type", "immediate")),
                cron_expr=body.get("cron_expr"),
                delay_seconds=body.get("delay_seconds"),
                next_run_at=body.get("next_run_at"),  # Allow setting next_run_at directly
                max_runs=body.get("max_runs"),
                tags=body.get("tags", ""),
                agent=body.get("agent") or self.db.get_setting("default_agent", "claude"),
                prompt_images=prompt_images,
                image_paths=image_paths,
                dag_id=body.get("dag_id"),
            )
            task_id = self.scheduler.submit_task(task, depends_on=depends_on)
            self._json_response({"id": task_id, "status": "created"}, 201)

        elif path == "/api/settings":
            for key, value in body.items():
                self.db.set_setting(key, str(value))
            self._json_response({"status": "updated"})

        elif path == "/api/feishu/settings":
            logger.info("POST /api/feishu/settings - updating Feishu settings")
            allowed = {"feishu_app_id", "feishu_app_secret", "feishu_default_chat_id",
                       "feishu_default_working_dir", "feishu_enabled"}
            for key, value in body.items():
                if key in allowed:
                    # Mask sensitive values in logs
                    display_value = value[:8] + "..." if key in ("feishu_app_id", "feishu_app_secret") else value
                    logger.debug(f"  Setting {key} = {display_value}")
                    self.db.set_setting(key, str(value))
            # Restart the Feishu channel with new credentials
            logger.info("Restarting Feishu channel with new settings...")
            if self.__class__.feishu_channel:
                logger.info("Stopping existing channel...")
                self.__class__.feishu_channel.stop()
                self.__class__.feishu_channel = None
            if FEISHU_CHANNEL_AVAILABLE and body.get("feishu_enabled", "").lower() == "true":
                channel = FeishuChannel(
                    bus=self.__class__.bus, db=self.db,
                    scheduler=self.__class__.scheduler,
                )
                logger.info("Starting new Feishu channel (enabled)...")
                channel.start()
                self.__class__.feishu_channel = channel
            else:
                logger.info("Feishu channel disabled, not creating")
            logger.info("Feishu settings updated successfully")
            self._json_response({"status": "updated"})

        elif path == "/api/channels/settings":
            logger.info("POST /api/channels/settings - updating channel settings")
            allowed = {
                "telegram_bot_token", "telegram_allowed_users",
                "telegram_default_working_dir", "telegram_enabled", "telegram_default_chat_id",
                "slack_bot_token", "slack_app_token",
                "slack_default_working_dir", "slack_default_channel", "slack_default_user", "slack_enabled",
            }
            for key, value in body.items():
                if key in allowed:
                    # Mask sensitive values in logs
                    display_value = value[:8] + "..." if "token" in key or "secret" in key else value
                    logger.debug(f"  Setting {key} = {display_value}")
                    self.db.set_setting(key, str(value))

            # ── Restart Telegram channel ──
            tg_enabled = (body.get("telegram_enabled") or self.db.get_setting("telegram_enabled", "false")) == "true"
            if self.__class__.telegram_channel:
                logger.info("Stopping existing Telegram channel...")
                self.__class__.telegram_channel.stop()
                self.__class__.telegram_channel = None
            if tg_enabled and TELEGRAM_CHANNEL_AVAILABLE:
                tg_token = self.db.get_setting("telegram_bot_token", "") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
                tg_allowed = self.db.get_setting("telegram_allowed_users", "") or os.environ.get("TELEGRAM_ALLOWED_USERS", "")
                if tg_token:
                    logger.info("Starting Telegram channel with new settings...")
                    ch = create_telegram_channel(
                        self.db, self.__class__.scheduler, bus=self.__class__.bus,
                        token=tg_token, allowed_users_str=tg_allowed,
                    )
                    if ch:
                        ch.start()
                        self.__class__.telegram_channel = ch
                        logger.info("Telegram channel started")
                    else:
                        logger.error("Failed to create Telegram channel")
                else:
                    logger.warning("Telegram enabled but no bot token set")
            else:
                logger.info("Telegram channel disabled")

            # ── Restart Slack channel ──
            sl_enabled = (body.get("slack_enabled") or self.db.get_setting("slack_enabled", "false")) == "true"
            if self.__class__.slack_channel:
                logger.info("Stopping existing Slack channel...")
                self.__class__.slack_channel.stop()
                self.__class__.slack_channel = None
            if sl_enabled and SLACK_CHANNEL_AVAILABLE:
                sl_bot = self.db.get_setting("slack_bot_token", "") or os.environ.get("SLACK_BOT_TOKEN", "")
                sl_app = self.db.get_setting("slack_app_token", "") or os.environ.get("SLACK_APP_TOKEN", "")
                if sl_bot and sl_app:
                    logger.info("Starting Slack channel with new settings...")
                    ch = SlackChannel(
                        bus=self.__class__.bus, db=self.db,
                        scheduler=self.__class__.scheduler,
                        bot_token=sl_bot, app_token=sl_app,
                    )
                    ch.start()
                    self.__class__.slack_channel = ch
                    logger.info("Slack channel started")
                else:
                    logger.warning("Slack enabled but missing tokens")
            else:
                logger.info("Slack channel disabled")

            logger.info("Channel settings updated successfully")
            self._json_response({"status": "updated"})

        elif path == "/api/dag":
            # Batch-create a full DAG in one call.
            # Body: {dag_id, tasks: [{ref, title, prompt, working_dir, schedule_type, depends_on_refs, inject_result, ...}]}
            dag_id = body.get("dag_id", f"dag-{int(datetime.now().timestamp())}")
            task_defs = body.get("tasks", [])
            if not task_defs:
                self._json_response({"error": "tasks list is required"}, 400)
                return

            ref_to_id: dict[str, int] = {}
            results = {}
            for tdef in task_defs:
                ref = tdef.get("ref", str(len(ref_to_id)))
                depends_on_refs = tdef.get("depends_on_refs", [])
                # Resolve refs → task_ids (upstream must already be created)
                depends_on = []
                for r in depends_on_refs:
                    if r not in ref_to_id:
                        self._json_response({"error": f"ref '{r}' not found — declare tasks in topological order"}, 400)
                        return
                    depends_on.append({
                        "task_id": ref_to_id[r],
                        "inject_result": bool(tdef.get("inject_result", False)),
                    })

                prompt_images = tdef.get("prompt_images", [])
                if isinstance(prompt_images, str):
                    try:
                        prompt_images = json.loads(prompt_images)
                    except (json.JSONDecodeError, ValueError):
                        prompt_images = []

                t = Task(
                    title=tdef.get("title", tdef.get("prompt", "")[:60]),
                    prompt=tdef.get("prompt", ""),
                    working_dir=tdef.get("working_dir", "."),
                    schedule_type=ScheduleType(tdef.get("schedule_type", "immediate")),
                    cron_expr=tdef.get("cron_expr"),
                    delay_seconds=tdef.get("delay_seconds"),
                    next_run_at=tdef.get("next_run_at"),
                    max_runs=tdef.get("max_runs"),
                    tags=tdef.get("tags", ""),
                    agent=tdef.get("agent") or self.db.get_setting("default_agent", "claude"),
                    prompt_images=prompt_images,
                    dag_id=dag_id,
                )
                task_id = self.scheduler.submit_task(t, depends_on=depends_on)
                ref_to_id[ref] = task_id
                results[ref] = task_id

            self._json_response({"dag_id": dag_id, "task_ids": results}, 201)

        elif path.startswith("/api/tasks/") and path.endswith("/dependencies"):
            # POST /api/tasks/:id/dependencies — add a dependency to an existing task
            tid = int(path.split("/")[3])
            dep_task_id = body.get("depends_on_task_id")
            if not dep_task_id:
                self._json_response({"error": "depends_on_task_id required"}, 400)
                return
            task = self.db.get_task(tid)
            upstream = self.db.get_task(int(dep_task_id))
            if not task or not upstream:
                self._json_response({"error": "task not found"}, 404)
                return
            inject_result = bool(body.get("inject_result", False))
            should_block = upstream["status"] != "completed" and task["status"] in ("pending", "scheduled")
            # Insert dependency and (if needed) update task status atomically.
            with self.db.transaction():
                self.db.conn.execute("""
                    INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, inject_result)
                    VALUES (?, ?, ?)
                """, (tid, int(dep_task_id), 1 if inject_result else 0))
                if should_block:
                    self.db.conn.execute(
                        "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                        ("blocked", datetime.now().isoformat(), tid),
                    )
            if should_block:
                self._notify(tid)
            self._json_response({"status": "added"})

        elif path.startswith("/api/tasks/") and path.endswith("/cancel"):
            tid = int(path.split("/")[3])
            self.scheduler.cancel_task(tid)
            self._json_response({"status": "cancelled"})

        elif path.startswith("/api/tasks/") and path.endswith("/retry"):
            tid = int(path.split("/")[3])
            self.scheduler.retry_task(tid)
            self._json_response({"status": "retrying"})

        elif path.startswith("/api/tasks/") and path.endswith("/respond"):
            tid = int(path.split("/")[3])
            answer = body.get("answer", "")
            task = self.db.get_task(tid)
            if task:
                self.db.update_task(tid,
                                    status="pending",
                                    prompt=answer,
                                    answer=answer,
                                    question=None,
                                    error=None)
                self._json_response({"status": "responding"})
            else:
                self._json_response({"error": "not found"}, 404)

        elif path.startswith("/api/tasks/") and path.endswith("/resume"):
            tid = int(path.split("/")[3])
            message = body.get("message", "").strip()
            task = self.db.get_task(tid)
            if not task:
                self._json_response({"error": "not found"}, 404)
            elif not message:
                self._json_response({"error": "message required"}, 400)
            elif not task.get("session_id"):
                self._json_response({"error": "no session_id — cannot resume"}, 400)
            else:
                self.db.update_task(tid,
                                    status="pending",
                                    prompt=message,
                                    result=None,
                                    error=None,
                                    question=None)
                self._json_response({"status": "resuming"})

        else:
            self._json_response({"error": "not found"}, 404)

    def do_PUT(self):
        if not self._check_csrf():
            self._json_response({"error": "CSRF token missing or invalid"}, 403)
            return
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/api/settings":
            for key, value in body.items():
                self.db.set_setting(key, str(value))
            self._json_response({"status": "updated"})

        elif path.startswith("/api/tasks/") and path.count("/") == 3:
            # PUT /api/tasks/{id} — edit a pending/scheduled/blocked task
            try:
                tid = int(path.split("/")[3])
            except (ValueError, IndexError):
                self._json_response({"error": "invalid task id"}, 400)
                return

            task = self.db.get_task(tid)
            if not task:
                self._json_response({"error": "not found"}, 404)
                return

            if task["status"] not in ("pending", "scheduled", "blocked"):
                self._json_response(
                    {"error": f"Cannot edit task with status '{task['status']}'. Only pending, scheduled, or blocked tasks can be edited."},
                    409,
                )
                return

            # ── Validate prompt ──
            prompt = body.get("prompt", task["prompt"])
            if not prompt or not prompt.strip():
                self._json_response({"error": "prompt cannot be empty", "field": "prompt"}, 400)
                return

            # ── Validate working_dir ──
            working_dir = body.get("working_dir", task["working_dir"])
            if working_dir and working_dir != ".":
                expanded = os.path.expanduser(working_dir)
                if not os.path.isdir(expanded):
                    self._json_response(
                        {"error": f"working_dir does not exist: {working_dir}", "field": "working_dir"},
                        400,
                    )
                    return

            # ── Validate schedule_type / cron_expr ──
            schedule_type = body.get("schedule_type", task["schedule_type"])
            cron_expr = body.get("cron_expr", task.get("cron_expr"))
            if schedule_type == "cron":
                if not cron_expr or not cron_expr.strip():
                    self._json_response({"error": "cron_expr required for cron schedule", "field": "cron_expr"}, 400)
                    return
                if not croniter.is_valid(cron_expr):
                    self._json_response({"error": f"invalid cron expression: {cron_expr}", "field": "cron_expr"}, 400)
                    return

            # ── Build updates from editable fields ──
            EDITABLE_FIELDS = {
                "title", "prompt", "working_dir", "schedule_type",
                "cron_expr", "delay_seconds", "max_runs", "tags",
                "agent", "dag_id",
            }
            updates = {}
            for field in EDITABLE_FIELDS:
                if field in body:
                    updates[field] = body[field]

            # Handle prompt_images
            if "prompt_images" in body:
                pi = body["prompt_images"]
                if isinstance(pi, str):
                    try:
                        pi = json.loads(pi)
                    except (json.JSONDecodeError, ValueError):
                        pi = []
                updates["prompt_images"] = json.dumps(pi, ensure_ascii=False)

            # Handle image_paths
            if "image_paths" in body:
                ip = body["image_paths"]
                if isinstance(ip, str):
                    try:
                        ip = json.loads(ip)
                    except (json.JSONDecodeError, ValueError):
                        ip = []
                if not isinstance(ip, list):
                    ip = []
                updates["image_paths"] = json.dumps(ip, ensure_ascii=False)

            # ── Recalculate status and next_run_at based on schedule_type ──
            new_stype = updates.get("schedule_type", task["schedule_type"])
            if new_stype == "immediate":
                updates["status"] = "pending"
                updates["next_run_at"] = None
                updates["cron_expr"] = None
                updates["delay_seconds"] = None
            elif new_stype == "delayed":
                updates["status"] = "pending"
                updates["next_run_at"] = None  # scheduler will calculate
                updates["cron_expr"] = None
            elif new_stype == "scheduled_at":
                nra = body.get("next_run_at", task.get("next_run_at"))
                if not nra:
                    self._json_response({"error": "next_run_at required for scheduled_at", "field": "next_run_at"}, 400)
                    return
                updates["next_run_at"] = nra
                updates["status"] = "scheduled"
                updates["cron_expr"] = None
                updates["delay_seconds"] = None
            elif new_stype == "cron":
                new_cron = updates.get("cron_expr", task.get("cron_expr"))
                nxt = croniter(new_cron, datetime.now()).get_next(datetime)
                updates["next_run_at"] = nxt.isoformat()
                updates["status"] = "scheduled"
                updates["delay_seconds"] = None

            # ── Handle dependency updates ──
            if "depends_on" in body:
                self.db.clear_dependencies(tid)
                dep_list = []
                depends_on_raw = body["depends_on"]
                if isinstance(depends_on_raw, list):
                    for item in depends_on_raw:
                        if isinstance(item, int):
                            dep_list.append({"task_id": item, "inject_result": False})
                        elif isinstance(item, dict) and "task_id" in item:
                            dep_list.append({
                                "task_id": int(item["task_id"]),
                                "inject_result": bool(item.get("inject_result", False)),
                            })
                if dep_list:
                    self.db.add_dependencies_batch(tid, dep_list)
                    # Check if any deps are unmet → set blocked
                    for dep in dep_list:
                        upstream = self.db.get_task(dep["task_id"])
                        if not upstream or upstream["status"] != "completed":
                            updates["status"] = "blocked"
                            break

            if updates:
                self.db.update_task(tid, **updates)

            updated_task = self.db.get_task(tid)
            # Include dependencies in response
            updated_task["dependencies"] = self.db.get_dependencies(tid)
            self._json_response(updated_task)

        else:
            self._json_response({"error": "not found"}, 404)

    def do_DELETE(self):
        if not self._check_csrf():
            self._json_response({"error": "CSRF token missing or invalid"}, 403)
            return
        parsed = urlparse(self.path)
        parts = parsed.path.split("/")
        # DELETE /api/tasks/:id/dependencies/:dep_id
        if len(parts) == 6 and parts[2] == "tasks" and parts[4] == "dependencies":
            tid = int(parts[3])
            dep_id = int(parts[5])
            self.db.remove_dependency(tid, dep_id)
            self._json_response({"status": "removed"})
        elif parsed.path.startswith("/api/tasks/"):
            tid = int(parsed.path.split("/")[3])
            self.db.delete_task(tid)
            self._json_response({"status": "deleted"})
        else:
            self._json_response({"error": "not found"}, 404)

    MAX_BODY_SIZE = 10 * 1024 * 1024  # 10 MB

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length > self.MAX_BODY_SIZE:
            self.send_response(413)
            self.end_headers()
            raise ValueError(f"Request body too large: {length} bytes")
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    def _json_response(self, data, status=200):
        try:
            self.send_response(status)
            self._cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data, default=str).encode())
        except BrokenPipeError:
            pass

    def _cors_headers(self):
        origin = self.headers.get("Origin", "")
        # Allow the exact origin when it matches; fall back to no header so
        # the browser blocks it — never reflect an arbitrary untrusted origin.
        if self._is_allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token")

    @staticmethod
    def _is_allowed_origin(origin: str) -> bool:
        """Return True for file:// (Electron production) and localhost origins."""
        if origin == "null":           # Electron / file://
            return True
        if not origin:
            return True                # same-origin request with no Origin header
        # Accept http://localhost or http://localhost:<any port>
        if origin == "http://localhost" or origin.startswith("http://localhost:"):
            return True
        return False

    def _check_csrf(self) -> bool:
        """Validate the CSRF token on state-changing requests.

        Returns True if the request is allowed, False if it should be rejected.
        Requests without an Origin header (e.g. curl from localhost, the skill
        API client) skip the CSRF check so programmatic access still works.
        """
        origin = self.headers.get("Origin", "")
        # Only enforce CSRF for browser-originated cross-origin requests.
        # Requests with no Origin header come from non-browser clients
        # (curl, the agentforge skill) — skip the check.
        if not origin:
            return True
        token = self.headers.get("X-CSRF-Token", "")
        return secrets.compare_digest(token, _CSRF_TOKEN)

    def log_message(self, format, *args):
        # Suppress default logging
        pass



class QuietHTTPServer(HTTPServer):
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], BrokenPipeError):
            return
        super().handle_error(request, client_address)


def _kill_stale_process_on_port(port: int):
    """Kill any leftover process occupying the port (e.g. orphaned from a previous run)."""
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.settimeout(1)
        sock.connect(("127.0.0.1", port))
        sock.close()
    except (ConnectionRefusedError, OSError):
        return  # port is free
    # Port is occupied — try to find and kill the process
    try:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True, timeout=5
        )
        pids = []
        for pid_str in result.stdout.strip().split("\n"):
            pid_str = pid_str.strip()
            if pid_str and pid_str.isdigit():
                pid = int(pid_str)
                if pid != os.getpid():
                    pids.append(pid)
                    logger.info(f"Killing stale process {pid} on port {port}")
                    os.kill(pid, signal.SIGTERM)
        # Wait for processes to exit, then SIGKILL if still alive
        for _ in range(10):
            time.sleep(0.3)
            pids = [p for p in pids if _pid_alive(p)]
            if not pids:
                return
        for pid in pids:
            logger.warning(f"Force-killing stale process {pid}")
            os.kill(pid, signal.SIGKILL)
        time.sleep(0.3)
    except Exception as e:
        logger.warning(f"Could not clean up port {port}: {e}")


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def run_server(port: int = 9712):
    _kill_stale_process_on_port(port)

    logger.info("Initializing database...")
    db = TaskDB()

    # Initialise MessageBus and channels
    logger.info("Initializing MessageBus...")
    bus = MessageBus()
    ui_channel = UIChannel(bus=bus, db=db)
    ui_channel.start()

    logger.info("Initializing scheduler...")
    scheduler = TaskScheduler(db, on_task_update=lambda tid: None, bus=bus)

    # ── Feishu channel ─────────────────────────────────────────────────────
    feishu_channel = None
    feishu_enabled = db.get_setting("feishu_enabled", "false").lower() == "true"
    logger.info(f"Feishu enabled: {feishu_enabled}")
    if FEISHU_CHANNEL_AVAILABLE and feishu_enabled:
        logger.info("Starting Feishu channel...")
        feishu_channel = FeishuChannel(bus=bus, db=db, scheduler=scheduler)
        feishu_channel.start()
    else:
        logger.info("Feishu channel disabled")
    # ─────────────────────────────────────────────────────────────────────

    # ── Telegram channel ──────────────────────────────────────────────────
    telegram_channel = None
    tg_enabled = db.get_setting("telegram_enabled", "false") == "true"
    tg_token = db.get_setting("telegram_bot_token", "") or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    tg_allowed = db.get_setting("telegram_allowed_users", "") or os.environ.get("TELEGRAM_ALLOWED_USERS", "")
    # Auto-enable if env var set but settings not yet configured
    if not tg_enabled and os.environ.get("TELEGRAM_BOT_TOKEN"):
        tg_enabled = True
    if TELEGRAM_CHANNEL_AVAILABLE and tg_enabled and tg_token:
        logger.info("Starting Telegram channel...")
        telegram_channel = create_telegram_channel(
            db, scheduler, bus=bus,
            token=tg_token, allowed_users_str=tg_allowed,
        )
        if telegram_channel:
            telegram_channel.start()
    else:
        logger.info("Telegram channel disabled")
    # ─────────────────────────────────────────────────────────────────────

    # ── Slack channel ─────────────────────────────────────────────────────
    slack_channel = None
    sl_enabled = db.get_setting("slack_enabled", "false") == "true"
    sl_bot = db.get_setting("slack_bot_token", "") or os.environ.get("SLACK_BOT_TOKEN", "")
    sl_app = db.get_setting("slack_app_token", "") or os.environ.get("SLACK_APP_TOKEN", "")
    # Auto-enable if env vars set but settings not yet configured
    if not sl_enabled and os.environ.get("SLACK_BOT_TOKEN") and os.environ.get("SLACK_APP_TOKEN"):
        sl_enabled = True
    if SLACK_CHANNEL_AVAILABLE and sl_enabled and sl_bot and sl_app:
        logger.info("Starting Slack channel...")
        slack_channel = SlackChannel(
            bus=bus, db=db, scheduler=scheduler,
            bot_token=sl_bot, app_token=sl_app,
        )
        slack_channel.start()
    else:
        logger.info("Slack channel disabled")
    # ─────────────────────────────────────────────────────────────────────

    scheduler.start()

    TaskAPIHandler.scheduler = scheduler
    TaskAPIHandler.db = db
    TaskAPIHandler.feishu_channel = feishu_channel
    TaskAPIHandler.bus = bus
    TaskAPIHandler.ui_channel = ui_channel
    TaskAPIHandler.telegram_channel = telegram_channel
    TaskAPIHandler.slack_channel = slack_channel

    server = QuietHTTPServer(("127.0.0.1", port), TaskAPIHandler)
    logger.info(f"API server running on http://127.0.0.1:{port}")
    logger.info(f"Database at {db.db_path}")

    def shutdown(sig, frame):
        logger.info("Shutting down...")
        if feishu_channel:
            logger.info("Stopping Feishu channel...")
            feishu_channel.stop()
        if telegram_channel:
            logger.info("Stopping Telegram channel...")
            telegram_channel.stop()
        if slack_channel:
            logger.info("Stopping Slack channel...")
            slack_channel.stop()
        logger.info("Stopping scheduler...")
        scheduler.stop()
        logger.info("Closing database...")
        db.conn.close()
        logger.info("Shutting down server...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    server.serve_forever()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9712
    logger.info(f"=== Python backend starting at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} on port {port} ===")
    run_server(port)
# Test comment for hot reload 2026年 2月13日 星期五 23时08分26秒 CST
# Hot reload test at 23:09:11
