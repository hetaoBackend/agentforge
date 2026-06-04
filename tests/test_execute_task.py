"""Hermetic tests for the agent subprocess execution + stream-parsing paths.

Targets the largest uncovered region in ``taskboard.py``:

* ``TaskScheduler._execute_task`` — spawns the agent CLI, reads the stdout
  NDJSON ``stream-json`` stream line-by-line, parses + persists each event,
  reads stderr in a background thread, arms a kill timer, and finalizes the
  run/task in the DB (success vs. failure).
* ``TaskScheduler._run_agent_command`` — the heartbeat / skill-sweep agent
  invocation path that also drains stdout/stderr in threads.
* ``AgentExecutor.run`` — builds the ``claude`` CLI command line.
* ``TaskScheduler._extract_error_summary``.

Strategy: patch ``taskboard.subprocess.Popen`` with a finite fake process so
the read loop always terminates, and patch the process-group ``os`` calls
(``getpgid`` / ``killpg``) so they don't touch a real PID. A real
``TaskDB`` on a tmp_path SQLite file lets us assert the persisted run status
and the parsed output events afterwards.
"""

import json
import os
import tempfile
import time
from unittest.mock import patch

import pytest

import taskboard
from taskboard import AgentExecutor, ScheduleType, Task, TaskDB, TaskScheduler


# ── Fakes ────────────────────────────────────────────────────────────────────
class FakePopen:
    """Minimal stand-in for the subprocess.Popen object used by taskboard.

    ``_execute_task`` (and ``_run_agent_command``) iterate ``proc.stdout`` /
    ``proc.stderr`` directly and call ``.wait()``. The stdout/stderr iterables
    are finite so the read loop never hangs.
    """

    _next_pid = 4242

    def __init__(self, stdout_lines, stderr_lines=None, returncode=0):
        FakePopen._next_pid += 1
        self.pid = FakePopen._next_pid
        # text=True in the real call → lines are str
        self.stdout = iter(list(stdout_lines))
        self.stderr = iter(list(stderr_lines or []))
        self.returncode = returncode
        self._killed = False
        self.stdin = _FakeStdin()

    def wait(self, timeout=None):
        return self.returncode

    def poll(self):
        return self.returncode

    def kill(self):
        self._killed = True


class _FakeStdin:
    def __init__(self):
        self.buffer = ""
        self.closed = False

    def write(self, data):
        self.buffer += data

    def close(self):
        self.closed = True


@pytest.fixture
def scheduler(tmp_path):
    db = TaskDB(str(tmp_path / "t.db"))
    sched = TaskScheduler(db)  # NOTE: never .start() — keep it hermetic
    return sched


@pytest.fixture(autouse=True)
def _stub_process_group(monkeypatch):
    """Make the process-group bookkeeping in ``_execute_task`` inert.

    The real code calls ``os.getpgid(pid)`` then loops on ``os.killpg(pgid, 0)``
    to wait for sub-agents. With a fake PID we substitute deterministic stubs:
    ``killpg(_, 0)`` immediately raises ProcessLookupError so the sub-agent
    wait loop exits at once (no sleeps, no hangs).
    """

    def fake_getpgid(pid):
        return pid

    def fake_killpg(pgid, sig):
        # sig == 0 is the "is the group alive?" probe → report it's gone.
        raise ProcessLookupError

    monkeypatch.setattr(taskboard.os, "getpgid", fake_getpgid)
    monkeypatch.setattr(taskboard.os, "killpg", fake_killpg)


# ── Stream fixtures (realistic stream-json lines for both agents) ────────────
def _claude_lines(result_text="All done.", session_id="sess-abc"):
    return [
        json.dumps({"type": "system", "subtype": "init", "session_id": session_id}) + "\n",
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Working on it. "}],
                },
            }
        )
        + "\n",
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "id": "msg_2",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "Bash",
                            "input": {"command": "ls"},
                        }
                    ],
                },
            }
        )
        + "\n",
        json.dumps(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [{"type": "text", "text": "file.txt"}],
                            "is_error": False,
                        }
                    ],
                },
            }
        )
        + "\n",
        "   \n",  # blank line — tolerated
        "this is not json at all and is longer than ten chars\n",  # raw-text branch
        json.dumps(
            {
                "type": "result",
                "subtype": "success",
                "result": result_text,
                "session_id": session_id,
            }
        )
        + "\n",
    ]


def _codex_lines(thread_id="thread-xyz", final_text="Codex finished."):
    return [
        json.dumps({"type": "thread.started", "thread_id": thread_id}) + "\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {
                    "id": "cmd_1",
                    "type": "command_execution",
                    "command": "pytest -q",
                    "aggregated_output": "1 passed",
                    "exit_code": 0,
                    "status": "completed",
                },
            }
        )
        + "\n",
        json.dumps(
            {
                "type": "item.completed",
                "item": {"id": "msg_1", "type": "agent_message", "text": final_text},
            }
        )
        + "\n",
        json.dumps({"type": "turn.completed", "usage": {"output_tokens": 5}}) + "\n",
    ]


# ── AgentExecutor.run: command-line construction + flags ─────────────────────
def test_agent_executor_run_builds_claude_command_with_permission_flags():
    captured = {}

    class _Result:
        returncode = 0
        stdout = json.dumps({"type": "result", "result": "hi"}) + "\n"
        stderr = ""

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return _Result()

    with patch.object(taskboard.subprocess, "run", side_effect=fake_run):
        ok, output = AgentExecutor.run("do a thing", working_dir=".", timeout=30)

    assert ok is True
    assert output == "hi"  # result event text extracted, not raw stdout
    cmd = captured["cmd"]
    assert cmd[:3] == ["claude", "-p", "do a thing"]
    # stream-json + bypassPermissions flags appended
    assert "--output-format" in cmd and "stream-json" in cmd
    assert "--permission-mode" in cmd
    assert cmd[cmd.index("--permission-mode") + 1] == "bypassPermissions"
    assert captured["kwargs"]["timeout"] == 30


def test_agent_executor_run_includes_image_flags():
    with patch.object(taskboard.subprocess, "run") as mrun:
        mrun.return_value.returncode = 0
        mrun.return_value.stdout = ""
        mrun.return_value.stderr = ""
        AgentExecutor.run("p", image_paths=["/tmp/a.png", "/tmp/b.jpg"])
    cmd = mrun.call_args.args[0]
    # each image passed via -i
    assert cmd.count("-i") == 2
    assert "/tmp/a.png" in cmd and "/tmp/b.jpg" in cmd


def test_agent_executor_run_nonzero_returns_stderr():
    with patch.object(taskboard.subprocess, "run") as mrun:
        mrun.return_value.returncode = 1
        mrun.return_value.stdout = ""
        mrun.return_value.stderr = "boom from cli"
        ok, output = AgentExecutor.run("p")
    assert ok is False
    assert output == "boom from cli"


def test_agent_executor_run_handles_missing_cli():
    with patch.object(taskboard.subprocess, "run", side_effect=FileNotFoundError()):
        ok, output = AgentExecutor.run("p")
    assert ok is False
    assert "not found" in output


# ── _execute_task: claude success path ───────────────────────────────────────
def test_execute_task_claude_success_persists_completed_and_events(scheduler):
    db = scheduler.db
    tid = db.add_task(Task(title="claude task", prompt="hello", working_dir=".", agent="claude"))
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()  # _execute_task pops this at the end

    fake = FakePopen(_claude_lines(result_text="All done.", session_id="sess-abc"))
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "completed"
    assert refreshed["result"] == "All done."
    assert refreshed["run_count"] == 1
    # session_id extracted from the trailing result event
    assert refreshed["session_id"] == "sess-abc"

    runs = db.get_task_runs(tid)
    assert len(runs) == 1
    assert runs[0]["status"] == "completed"
    assert runs[0]["raw_output"]  # raw stdout stored

    events = db.get_output_events(tid)
    types = {e["event_type"] for e in events}
    # assistant text, a tool_call, a tool_result, the result event, and the raw
    # non-JSON line all persisted.
    assert "assistant" in types
    assert "tool_call" in types
    assert "tool_result" in types
    assert "result" in types
    assert "text" in types  # the malformed/non-JSON line


# ── _execute_task: codex success path ────────────────────────────────────────
def test_execute_task_codex_success_persists_completed_and_events(scheduler, monkeypatch):
    db = scheduler.db
    tid = db.add_task(Task(title="codex task", prompt="hello", working_dir=".", agent="codex"))
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    # No generated images for this run.
    monkeypatch.setattr(scheduler, "_find_codex_generated_images", lambda *a, **k: [])

    fake = FakePopen(_codex_lines(thread_id="thread-xyz", final_text="Codex finished."))
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "completed"
    assert refreshed["result"] == "Codex finished."
    # thread.started thread_id captured as session_id
    assert refreshed["session_id"] == "thread-xyz"

    events = db.get_output_events(tid)
    types = {e["event_type"] for e in events}
    assert "command_execution" in types
    # codex agent_message text stored as assistant output
    assert "assistant" in types


def test_execute_task_codex_builds_resume_command_when_session_present(scheduler, monkeypatch):
    db = scheduler.db
    tid = db.add_task(Task(title="codex resume", prompt="again", working_dir=".", agent="codex"))
    db.update_task(tid, session_id="prev-thread")
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()
    monkeypatch.setattr(scheduler, "_find_codex_generated_images", lambda *a, **k: [])

    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakePopen(_codex_lines(thread_id="prev-thread", final_text="ok"))

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        scheduler._execute_task(task)

    cmd = captured["cmd"]
    assert cmd[:4] == ["codex", "exec", "resume", "--json"]
    assert "prev-thread" in cmd
    assert "--dangerously-bypass-approvals-and-sandbox" in cmd


# ── _execute_task: failure path (non-zero exit) ──────────────────────────────
def test_execute_task_failure_sets_failed_with_error_summary(scheduler):
    db = scheduler.db
    tid = db.add_task(Task(title="boom", prompt="fail please", working_dir=".", agent="claude"))
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    fake = FakePopen(
        stdout_lines=[],
        stderr_lines=["fatal: something exploded\n"],
        returncode=1,
    )
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "failed"
    assert "exploded" in (refreshed["error"] or "")

    runs = db.get_task_runs(tid)
    assert runs[0]["status"] == "failed"


# ── _execute_task: missing CLI binary ────────────────────────────────────────
def test_execute_task_missing_binary_fails_with_install_hint(scheduler):
    db = scheduler.db
    tid = db.add_task(Task(title="no cli", prompt="x", working_dir=".", agent="codex"))
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    with patch.object(taskboard.subprocess, "Popen", side_effect=FileNotFoundError()):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "failed"
    assert "codex" in (refreshed["error"] or "")
    assert "not found" in (refreshed["error"] or "")


# ── _execute_task: cron reschedule on success ────────────────────────────────
def test_execute_task_cron_success_reschedules_instead_of_completing(scheduler):
    db = scheduler.db
    tid = db.add_task(
        Task(
            title="cron task",
            prompt="tick",
            working_dir=".",
            agent="claude",
            schedule_type=ScheduleType.CRON,
            cron_expr="*/5 * * * *",
        )
    )
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    fake = FakePopen(_claude_lines(result_text="tick done"))
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    # cron task with remaining runs reschedules rather than completing
    assert refreshed["status"] == "scheduled"
    assert refreshed["next_run_at"]
    assert refreshed["run_count"] == 1


# ── _execute_task: image path handling (safe load + unsafe reject) ───────────
def test_execute_task_claude_loads_safe_image_and_streams_via_stdin(scheduler):
    """A real PNG under /tmp is a safe path → base64-loaded → claude switches to
    the stdin ``--input-format stream-json`` multimodal command; an unsafe path
    outside the allowed roots is rejected and never loaded.
    """
    db = scheduler.db
    # /tmp is one of the hard-coded allowed roots (realpaths cleanly on mac/linux).
    fd_dir = tempfile.mkdtemp(dir="/tmp")
    img = os.path.join(fd_dir, "pic.png")
    with open(img, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\nfakepng")

    tid = db.add_task(
        Task(
            title="img task",
            prompt="see image",
            working_dir=".",
            agent="claude",
            image_paths=[img, "/etc/shadow"],  # one safe, one rejected
        )
    )
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["stdin"] = kwargs.get("stdin")
        return FakePopen(_claude_lines(result_text="saw it"))

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "completed"
    # Safe image loaded → multimodal stdin path selected.
    cmd = captured["cmd"]
    assert "--input-format" in cmd
    assert cmd[cmd.index("--input-format") + 1] == "stream-json"
    assert captured["stdin"] is taskboard.subprocess.PIPE


def test_execute_task_codex_passes_image_flag(scheduler, monkeypatch):
    db = scheduler.db
    fd_dir = tempfile.mkdtemp(dir="/tmp")
    img = os.path.join(fd_dir, "shot.png")
    with open(img, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\nfakepng")

    tid = db.add_task(
        Task(title="codex img", prompt="render", working_dir=".", agent="codex", image_paths=[img])
    )
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()
    monkeypatch.setattr(scheduler, "_find_codex_generated_images", lambda *a, **k: [])

    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakePopen(_codex_lines(final_text="rendered"))

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        scheduler._execute_task(task)

    cmd = captured["cmd"]
    assert "--image" in cmd
    assert cmd[cmd.index("--image") + 1] == img


def test_execute_task_claude_resume_appends_session_flag(scheduler):
    db = scheduler.db
    tid = db.add_task(Task(title="resume", prompt="continue", working_dir=".", agent="claude"))
    db.update_task(tid, session_id="claude-sess-1")
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    captured = {}

    def fake_popen(cmd, **kwargs):
        captured["cmd"] = cmd
        return FakePopen(_claude_lines(result_text="resumed", session_id="claude-sess-1"))

    with patch.object(taskboard.subprocess, "Popen", side_effect=fake_popen):
        scheduler._execute_task(task)

    cmd = captured["cmd"]
    assert "--resume" in cmd
    assert cmd[cmd.index("--resume") + 1] == "claude-sess-1"


# ── _execute_task: timeout / kill path ───────────────────────────────────────
def test_execute_task_timeout_kills_group_and_marks_failed(scheduler):
    """A short configured timeout fires the kill timer while stdout is still
    streaming, exercising ``_kill`` (killpg → kill fallback) and the
    ``timed_out`` failure branch.
    """
    db = scheduler.db
    db.set_setting("timeout", "0")  # threading.Timer(0, _kill) fires immediately
    tid = db.add_task(Task(title="slow", prompt="hang", working_dir=".", agent="claude"))
    task = db.get_task(tid)
    scheduler._active_tasks[tid] = object()

    def slow_lines():
        # Give the timer (delay 0) a moment to fire mid-stream.
        time.sleep(0.2)
        yield json.dumps({"type": "system", "subtype": "init"}) + "\n"

    fake = FakePopen(slow_lines())
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        scheduler._execute_task(task)

    refreshed = db.get_task(tid)
    assert refreshed["status"] == "failed"
    # The run record preserves the raw "Task timed out after Ns" message.
    runs = db.get_task_runs(tid)
    assert runs[0]["status"] == "failed"
    assert "timed out" in (runs[0]["error"] or "")


# ── _run_agent_command: heartbeat/skill-sweep invocation ─────────────────────
def test_run_agent_command_claude_returns_result_text(scheduler):
    db = scheduler.db
    lines = [
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "id": "m1",
                    "content": [{"type": "text", "text": "intermediate"}],
                },
            }
        )
        + "\n",
        json.dumps({"type": "result", "result": "FINAL DECISION"}) + "\n",
    ]
    fake = FakePopen(lines, returncode=0)
    seen = []
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        ok, out = scheduler._run_agent_command(
            "claude",
            ["claude", "-p", "decide"],
            ".",
            on_stdout_line=seen.append,
        )
    assert ok is True
    assert out == "FINAL DECISION"
    assert any("FINAL DECISION" in s for s in seen)
    # db unused here but keep reference to satisfy fixture wiring
    assert db is not None


def test_run_agent_command_codex_returns_last_agent_message(scheduler):
    fake = FakePopen(_codex_lines(final_text="codex decision"), returncode=0)
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        ok, out = scheduler._run_agent_command("codex", ["codex", "exec"], ".")
    assert ok is True
    assert out == "codex decision"


def test_run_agent_command_nonzero_returns_stderr(scheduler):
    fake = FakePopen([], stderr_lines=["heartbeat blew up\n"], returncode=2)
    with patch.object(taskboard.subprocess, "Popen", return_value=fake):
        ok, out = scheduler._run_agent_command("claude", ["claude", "-p", "x"], ".")
    assert ok is False
    assert "blew up" in out


def test_run_agent_command_missing_binary(scheduler):
    with patch.object(taskboard.subprocess, "Popen", side_effect=FileNotFoundError()):
        ok, out = scheduler._run_agent_command("claude", ["claude"], ".")
    assert ok is False
    assert "not found" in out


# ── _extract_error_summary: branches ─────────────────────────────────────────
def test_extract_error_summary_prefers_short_plain_stderr(scheduler):
    summary = scheduler._extract_error_summary("permission denied", "")
    assert summary == "permission denied"


def test_extract_error_summary_parses_stream_json_error_event(scheduler):
    stdout = "\n".join(
        [
            json.dumps({"type": "system", "subtype": "init"}),
            json.dumps({"type": "error", "error": "rate limited"}),
        ]
    )
    summary = scheduler._extract_error_summary("", stdout)
    assert summary == "rate limited"


def test_extract_error_summary_falls_back_to_last_assistant_text(scheduler):
    stdout = json.dumps(
        {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "I could not finish."}]},
        }
    )
    summary = scheduler._extract_error_summary("", stdout)
    assert summary == "I could not finish."
