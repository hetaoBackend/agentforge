"""Additional direct unit tests for TaskScheduler / heartbeat / skill-sweep
branches that the existing suites don't reach.

Everything here constructs ``TaskDB`` + ``TaskScheduler`` directly, never starts
the background loop, and mocks every agent invocation so no real CLI is spawned.
Skill-library file I/O is sandboxed under a temp ``$HOME``.

Deliberately does NOT duplicate tests in test_scheduler_logic.py, test_heartbeat.py,
test_skill_distill.py, test_skill_registry.py, test_skill_patterns.py or
test_skill_scheduler.py — it targets the still-uncovered edges of:

* on-disk skill helpers (link/unlink/write/remove, frontmatter parse edges)
* AgentExecutor.run output extraction (subprocess mocked, not the executor path)
* heartbeat decision branches (codex prompt path, suppression, resume/pause)
* skill-sweep distillation + draft handling edge cases
* DAG post-execution hooks (scheduled-at/cron unblock, pause/resume/cancel)
"""

import json
import os
from datetime import datetime, timedelta

import pytest

from taskboard import (
    AgentExecutor,
    Heartbeat,
    HeartbeatDecisionType,
    HeartbeatScheduleType,
    ScheduleType,
    Task,
    TaskDB,
    TaskScheduler,
    _compose_skill_md,
    _parse_skill_frontmatter,
    _sanitize_skill_name,
    link_skill,
    remove_skill_from_disk,
    unlink_skill,
    write_skill_to_disk,
)


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "t.db"))


def make_heartbeat(**overrides):
    data = {
        "name": "Repo watcher",
        "working_dir": ".",
        "schedule_type": HeartbeatScheduleType.INTERVAL,
        "interval_seconds": 60,
        "check_prompt": "Inspect repo.",
        "action_prompt_template": "Review the latest changes.",
        "default_agent": "claude",
        "cooldown_seconds": 300,
    }
    data.update(overrides)
    return Heartbeat(**data)


def make_pattern(db, key="k", recurrence=3, tasks=(1, 2, 3), kind="recipe"):
    db.upsert_skill_pattern(key, kind, "summary", tasks[0])
    db.conn.execute(
        "UPDATE skill_patterns SET recurrence_count=?, contributing_task_ids=? WHERE pattern_key=?",
        (recurrence, json.dumps(list(tasks)), key),
    )
    db.conn.commit()
    return db.conn.execute("SELECT id FROM skill_patterns WHERE pattern_key=?", (key,)).fetchone()[
        "id"
    ]


# ── on-disk skill helpers (module-level functions) ──────────────────────────
def test_write_skill_to_disk_creates_canonical_and_symlinks(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    md_path, skill_dir = write_skill_to_disk("My Skill", "---\nname: my-skill\n---\nbody")
    assert os.path.isfile(md_path)
    assert os.path.basename(md_path) == "SKILL.md"
    assert skill_dir.endswith("My Skill")
    claude = os.path.expanduser("~/.claude/skills/My Skill")
    agents = os.path.expanduser("~/.agents/skills/My Skill")
    assert os.path.islink(claude) and os.path.islink(agents)
    # symlink target resolves back to canonical SKILL.md
    assert os.path.isfile(os.path.join(claude, "SKILL.md"))


def test_link_skill_replaces_stale_symlink(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    write_skill_to_disk("s1", "body-1")
    claude = os.path.expanduser("~/.claude/skills/s1")
    # Point the consumer symlink somewhere stale, then re-link.
    os.unlink(claude)
    os.symlink(str(tmp_path / "nowhere"), claude, target_is_directory=True)
    assert os.readlink(claude).endswith("nowhere")

    links = link_skill("s1")
    assert claude in links
    # re-link removed the stale link and recreated it at the canonical dir
    assert os.path.realpath(claude).endswith(os.path.join(".agentforge", "skills", "s1"))


def test_unlink_skill_removes_only_symlinks(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    write_skill_to_disk("s2", "body-2")
    canonical = os.path.expanduser("~/.agentforge/skills/s2/SKILL.md")
    unlink_skill("s2")
    assert not os.path.lexists(os.path.expanduser("~/.claude/skills/s2"))
    assert not os.path.lexists(os.path.expanduser("~/.agents/skills/s2"))
    assert os.path.isfile(canonical)  # canonical preserved
    # unlinking again is a no-op (no symlink present)
    unlink_skill("s2")
    assert os.path.isfile(canonical)


def test_remove_skill_from_disk_wipes_everything(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    write_skill_to_disk("s3", "body-3")
    remove_skill_from_disk("s3")
    assert not os.path.isdir(os.path.expanduser("~/.agentforge/skills/s3"))
    assert not os.path.lexists(os.path.expanduser("~/.claude/skills/s3"))
    # removing a non-existent skill is harmless
    remove_skill_from_disk("never-existed")


# ── frontmatter / compose / sanitize edges ──────────────────────────────────
def test_parse_skill_frontmatter_edges():
    # no frontmatter at all
    assert _parse_skill_frontmatter("just a body") == ("", "")
    # opening fence but no closing fence
    assert _parse_skill_frontmatter("---\nname: x") == ("", "")
    # well-formed, with a non key:value line and a duplicate that is ignored
    name, desc = _parse_skill_frontmatter(
        "---\nname: my-skill\nbare line without colon\ndescription: does x\nname: ignored\n---\nbody"
    )
    assert name == "my-skill"
    assert desc == "does x"
    # leading whitespace is tolerated
    assert _parse_skill_frontmatter("   \n---\nname: lead\n---\n")[0] == "lead"


def test_compose_skill_md_flattens_and_strips():
    md = _compose_skill_md("nm", "  multi\nline desc  ", "  body here  ")
    assert "name: nm" in md
    assert "description: multi line desc" in md
    assert md.strip().endswith("body here")
    # None inputs don't blow up
    assert "name: nm" in _compose_skill_md("nm", None, None)


def test_sanitize_skill_name_edges():
    assert _sanitize_skill_name("  Hello World  ") == "hello-world"
    assert _sanitize_skill_name("-leading-and-trailing-") == "leading-and-trailing"
    assert _sanitize_skill_name(None) == ""


# ── AgentExecutor.run (subprocess mocked — not the _execute_task path) ───────
class _FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_agent_executor_run_extracts_result_event(monkeypatch):
    stdout = "\n".join(
        [
            json.dumps({"type": "assistant", "message": "thinking"}),
            json.dumps({"type": "result", "result": "FINAL ANSWER"}),
            "",  # blank line skipped
        ]
    )
    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return _FakeProc(returncode=0, stdout=stdout)

    monkeypatch.setattr("taskboard.subprocess.run", fake_run)
    ok, out = AgentExecutor.run("do it", working_dir=".", image_paths=["/tmp/a.png"])
    assert ok is True
    assert out == "FINAL ANSWER"
    # image path threaded through as -i
    assert "-i" in captured["cmd"] and "/tmp/a.png" in captured["cmd"]


def test_agent_executor_run_no_result_event_returns_full_stdout(monkeypatch):
    stdout = json.dumps({"type": "assistant", "message": "no result line"})
    monkeypatch.setattr("taskboard.subprocess.run", lambda cmd, **k: _FakeProc(0, stdout))
    ok, out = AgentExecutor.run("p")
    assert ok is True
    assert out == stdout  # falls back to full stdout when no result event


def test_agent_executor_run_nonzero_returns_stderr(monkeypatch):
    monkeypatch.setattr("taskboard.subprocess.run", lambda cmd, **k: _FakeProc(1, "", "the error"))
    ok, out = AgentExecutor.run("p")
    assert ok is False
    assert out == "the error"


def test_agent_executor_run_tolerates_garbage_lines(monkeypatch):
    # A non-JSON line precedes the result event; the JSONDecodeError is swallowed.
    stdout = "\n".join(
        [
            "this is not json",
            json.dumps({"type": "result", "result": "OK"}),
        ]
    )
    monkeypatch.setattr("taskboard.subprocess.run", lambda cmd, **k: _FakeProc(0, stdout))
    ok, out = AgentExecutor.run("p")
    assert ok is True and out == "OK"


def test_agent_executor_run_timeout(monkeypatch):
    import subprocess as _sp

    def boom(cmd, **k):
        raise _sp.TimeoutExpired(cmd, 600)

    monkeypatch.setattr("taskboard.subprocess.run", boom)
    ok, out = AgentExecutor.run("p", timeout=600)
    assert ok is False
    assert "timed out" in out


def test_agent_executor_run_missing_cli(monkeypatch):
    def boom(cmd, **k):
        raise FileNotFoundError()

    monkeypatch.setattr("taskboard.subprocess.run", boom)
    ok, out = AgentExecutor.run("p")
    assert ok is False
    assert "not found" in out


def test_agent_executor_run_oserror(monkeypatch):
    def boom(cmd, **k):
        raise OSError("disk gone")

    monkeypatch.setattr("taskboard.subprocess.run", boom)
    ok, out = AgentExecutor.run("p")
    assert ok is False
    assert "disk gone" in out


# ── _run_agent_prompt_once builds the right CLI per agent ────────────────────
def test_run_agent_prompt_once_codex_command(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    seen = {}

    def fake_cmd(agent, cmd, cwd, **kwargs):
        seen["agent"] = agent
        seen["cmd"] = cmd
        seen["cwd"] = cwd
        return True, "ok"

    monkeypatch.setattr(sched, "_run_agent_command", fake_cmd)
    ok, out = sched._run_agent_prompt_once("codex", "the prompt", ".")
    assert ok and out == "ok"
    assert seen["cmd"][0] == "codex"
    assert "--json" in seen["cmd"]
    assert seen["cmd"][-1] == "the prompt"


def test_run_agent_prompt_once_claude_command(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    seen = {}
    monkeypatch.setattr(
        sched,
        "_run_agent_command",
        lambda agent, cmd, cwd, **k: seen.update(cmd=cmd) or (True, "ok"),
    )
    sched._run_agent_prompt_once("claude", "p2", ".")
    assert seen["cmd"][0] == "claude" and seen["cmd"][1] == "-p"


# ── heartbeat: codex prompt path + resume decision ──────────────────────────
def _mock_agent(sched, monkeypatch, payload, success=True):
    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        if on_stdout_line:
            on_stdout_line(payload)
        return success, payload

    monkeypatch.setattr(sched, "_run_agent_command", fake_run)


def test_execute_heartbeat_codex_agent_builds_codex_cmd(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(default_agent="codex"))
    seen = {}

    def fake_run(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        seen["cmd"] = cmd
        seen["agent"] = agent
        return True, json.dumps({"decision": "idle", "reason": "calm"})

    monkeypatch.setattr(sched, "_run_agent_command", fake_run)
    sched._execute_heartbeat(db.get_heartbeat(hid))

    assert seen["agent"] == "codex"
    assert seen["cmd"][0] == "codex" and "--json" in seen["cmd"]
    assert db.get_heartbeat(hid)["last_decision"] == HeartbeatDecisionType.IDLE.value


def test_execute_heartbeat_resume_decision_records_status(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())
    # A non-idle, non-trigger decision flows down the generic finish branch.
    _mock_agent(
        sched,
        monkeypatch,
        json.dumps({"decision": "error", "reason": "self-reported error"}),
    )
    sched._execute_heartbeat(db.get_heartbeat(hid))
    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.ERROR.value
    tick = db.get_latest_heartbeat_tick(hid)
    assert tick["status"] == HeartbeatDecisionType.ERROR.value


def test_execute_heartbeat_trigger_then_suppressed_records_idle(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(cooldown_seconds=600))
    payload = json.dumps({"decision": "trigger_task", "dedupe_key": "dk", "prompt": "do it"})
    _mock_agent(sched, monkeypatch, payload)

    sched._execute_heartbeat(db.get_heartbeat(hid))  # first → triggers a task
    assert len(db.get_all_tasks()) == 1
    sched._execute_heartbeat(db.get_heartbeat(hid))  # second → suppressed → idle

    assert len(db.get_all_tasks()) == 1
    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.IDLE.value
    tick = db.get_latest_heartbeat_tick(hid)
    assert "Suppressed duplicate" in json.loads(tick["decision_payload"])["reason"]


def test_execute_heartbeat_trigger_uses_decision_prompt_over_template(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(action_prompt_template="TEMPLATE"))
    _mock_agent(
        sched,
        monkeypatch,
        json.dumps({"decision": "trigger_task", "prompt": "CUSTOM PROMPT", "title": "Custom"}),
    )
    sched._execute_heartbeat(db.get_heartbeat(hid))
    tasks = db.get_all_tasks()
    assert tasks[0]["prompt"] == "CUSTOM PROMPT"
    assert tasks[0]["title"] == "Custom"


def test_execute_heartbeat_codex_agent_failure_raises_inline(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(default_agent="codex"))

    def fail(agent, cmd, cwd, on_stdout_line=None, on_stderr_line=None):
        return False, "codex crashed"

    monkeypatch.setattr(sched, "_run_agent_command", fail)
    sched._execute_heartbeat(db.get_heartbeat(hid))
    hb = db.get_heartbeat(hid)
    assert hb["last_decision"] == HeartbeatDecisionType.ERROR.value
    assert "codex crashed" in hb["last_error"]


# ── _heartbeat_trigger_suppressed edge: unparseable triggered_at ────────────
def test_trigger_suppressed_bad_timestamp_falls_through(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat(cooldown_seconds=600))
    db.upsert_heartbeat_dedup(hid, "k", None)
    db.conn.execute(
        "UPDATE heartbeat_dedup SET triggered_at=? WHERE heartbeat_id=? AND dedupe_key=?",
        ("not-a-date", hid, "k"),
    )
    db.conn.commit()
    # bad timestamp → cooldown check skipped, no active task → not suppressed
    assert sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid), "k") is False


# ── pause / resume heartbeat ────────────────────────────────────────────────
def test_pause_heartbeat_disables(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())
    sched.pause_heartbeat(hid)
    assert db.get_heartbeat(hid)["enabled"] is False


def test_resume_heartbeat_enables_and_schedules(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())
    sched.pause_heartbeat(hid)
    sched.resume_heartbeat(hid)
    hb = db.get_heartbeat(hid)
    assert hb["enabled"] is True
    assert datetime.fromisoformat(hb["next_run_at"]) > datetime.now()


def test_pause_resume_unknown_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.pause_heartbeat(99999)
    with pytest.raises(ValueError, match="not found"):
        sched.resume_heartbeat(99999)


# ── trigger_heartbeat_now: already running guard ────────────────────────────
def test_trigger_heartbeat_now_already_running_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    hid = db.add_heartbeat(make_heartbeat())

    class _Alive:
        def is_alive(self):
            return True

    sched._active_heartbeats[hid] = _Alive()
    with pytest.raises(ValueError, match="already running"):
        sched.trigger_heartbeat_now(hid)


# ── distill: contributing_task_ids parse fallbacks ──────────────────────────
def test_distill_skill_draft_bad_task_ids_json(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    # Corrupt the JSON so json.loads raises → tids defaults to []
    db.conn.execute(
        "UPDATE skill_patterns SET contributing_task_ids=? WHERE id=?", ("not json", pid)
    )
    db.conn.commit()
    obj = {"name": "X", "description": "d", "body_markdown": "b"}
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, json.dumps(obj)))

    draft = sched.distill_skill_draft(pid, agent="claude")
    assert draft["name"] == "x"
    assert db.get_skill_draft(pid)["status"] == "ready"


def test_distill_skill_draft_unknown_pattern_raises(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="pattern not found"):
        sched.distill_skill_draft(99999)


def test_distill_falls_back_to_pattern_key_when_no_name(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db, key="my-recurring-thing")
    obj = {"description": "d", "body_markdown": "b"}  # no name
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, json.dumps(obj)))
    draft = sched.distill_skill_draft(pid, agent="claude")
    assert draft["name"] == "my-recurring-thing"


# ── trigger_skill_draft: marks 'drafting' for a real pattern ────────────────
def test_trigger_skill_draft_sets_drafting_status(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    pid = make_pattern(db)
    # keep the agent from doing anything real; the worker thread will use it
    monkeypatch.setattr(
        sched,
        "distill_skill_draft",
        lambda *a, **k: db.upsert_skill_draft(pid, "ready", name="x", body="b"),
    )
    assert sched.trigger_skill_draft(pid) is True
    # row exists (either still 'drafting' or already 'ready' from the worker)
    draft = db.get_skill_draft(pid)
    assert draft is not None
    assert draft["status"] in ("drafting", "ready")


# ── distill prompt building: codex agent default resolution ─────────────────
def test_distill_agent_resolution_uses_setting(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("skill_sweep_agent", "codex")
    pid = make_pattern(db)
    seen = {}
    obj = {"name": "x", "description": "d", "body_markdown": "b"}

    def fake_cmd(agent, cmd, cwd, **k):
        seen["agent"] = agent
        return True, json.dumps(obj)

    monkeypatch.setattr(sched, "_run_agent_command", fake_cmd)
    sched.distill_skill_draft(pid)  # no agent arg → resolves from setting
    assert seen["agent"] == "codex"


# ── skill-sweep: non-dict items skipped, recurrence drives 'new' ────────────
def test_run_skill_sweep_skips_non_dict_items(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    rid = db.add_run(tid)
    db.finish_run(rid, status="completed", result="ok")

    payload = json.dumps(
        [
            "garbage-string",  # non-dict → skipped
            {"pattern_key": "real", "kind": "recipe", "summary": "s", "task_id": tid},
            {"pattern_key": "", "kind": "recipe", "summary": "s"},  # blank key → not upserted
        ]
    )
    monkeypatch.setattr(sched, "_run_agent_command", lambda *a, **k: (True, payload))

    result = sched.run_skill_sweep(agent="claude", full=True)
    assert result["scanned"] == 1
    assert result["detected"] == 1  # only the valid keyed entry
    assert db.get_skill_pattern_recurrence("real") == 1


def test_run_skill_sweep_resolves_default_agent_setting(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    db.set_setting("default_agent", "codex")
    result = sched.run_skill_sweep()  # no runs → short-circuits but resolves agent
    assert result["agent"] == "codex"


# ── trigger_skill_sweep background worker captures error ────────────────────
def test_trigger_skill_sweep_worker_records_error(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    rid = db.add_run(tid)
    db.finish_run(rid, status="completed", result="ok")

    def boom(*a, **k):
        raise RuntimeError("worker boom")

    monkeypatch.setattr(sched, "run_skill_sweep", boom)
    assert sched.trigger_skill_sweep(full=True) is True
    # poll until the background worker records the error to sweep status
    import time as _time

    for _ in range(50):
        status = sched.skill_sweep_status()
        if status["last"] and "error" in status["last"]:
            break
        _time.sleep(0.02)
    status = sched.skill_sweep_status()
    assert status["running"] is False
    assert status["last"]["error"] == "worker boom"


# ── DAG post-execution hooks: scheduled_at / cron unblock to 'scheduled' ─────
def test_on_task_completed_unblocks_scheduled_at_to_scheduled(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    future = (datetime.now() + timedelta(hours=2)).replace(microsecond=0).isoformat()
    down = sched.submit_task(
        Task(
            title="down",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.SCHEDULED_AT,
            next_run_at=future,
        ),
        depends_on=[up],
    )
    assert db.get_task(down)["status"] == "blocked"

    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    # scheduled_at downstream unblocks into 'scheduled', not 'pending'
    assert db.get_task(down)["status"] == "scheduled"


def test_on_task_completed_unblocks_cron_to_scheduled(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(
        Task(
            title="down",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.CRON,
            cron_expr="0 0 * * *",
        ),
        depends_on=[up],
    )
    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    assert db.get_task(down)["status"] == "scheduled"


def test_on_task_completed_unblocks_delayed_to_pending(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(
        Task(
            title="down",
            prompt="p",
            working_dir=".",
            schedule_type=ScheduleType.DELAYED,
            delay_seconds=30,
        ),
        depends_on=[up],
    )
    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    assert db.get_task(down)["status"] == "pending"


def test_on_task_completed_unblocks_immediate_to_pending(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = sched.submit_task(
        Task(title="down", prompt="p", working_dir="."),  # immediate
        depends_on=[up],
    )
    assert db.get_task(down)["status"] == "blocked"
    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    assert db.get_task(down)["status"] == "pending"


def test_on_task_failed_cancels_pending_and_scheduled_downstream(tmp_path):
    # The existing suite covers the blocked→cancelled chain; here we exercise the
    # pending/scheduled cancellable states and a diamond (shared downstream).
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    root = db.add_task(Task(title="root", prompt="p", working_dir="."))
    a = db.add_task(Task(title="a", prompt="p", working_dir="."))
    b = db.add_task(Task(title="b", prompt="p", working_dir="."))
    db.add_dependency(a, root)
    db.add_dependency(b, root)
    db.update_task(a, status="pending")
    db.update_task(b, status="scheduled")
    sched._on_task_failed(root)
    assert db.get_task(a)["status"] == "cancelled"
    assert db.get_task(b)["status"] == "cancelled"


def test_on_task_completed_ignores_non_blocked_dependents(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    down = db.add_task(Task(title="down", prompt="p", working_dir="."))
    db.add_dependency(down, up)
    # downstream is 'pending', not 'blocked' → hook leaves it alone
    db.update_task(up, status="completed")
    sched._on_task_completed(up)
    assert db.get_task(down)["status"] == "pending"


def test_on_task_failed_skips_already_running_downstream(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    root = db.add_task(Task(title="root", prompt="p", working_dir="."))
    down = db.add_task(Task(title="down", prompt="p", working_dir="."))
    db.add_dependency(down, root)
    db.update_task(down, status="running")  # not a cancellable state
    sched._on_task_failed(root)
    assert db.get_task(down)["status"] == "running"  # untouched


# ── cancel_task with a registered pgid path ─────────────────────────────────
def test_cancel_task_with_pgid_attempts_killpg(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    db.update_task(tid, status="running")
    sched._active_pgids[tid] = 424242
    killed = []
    monkeypatch.setattr("taskboard.os.killpg", lambda pgid, sig: killed.append(pgid))
    sched.cancel_task(tid)
    assert killed == [424242]
    assert db.get_task(tid)["status"] == "cancelled"


def test_cancel_task_pgid_killpg_oserror_swallowed(tmp_path, monkeypatch):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    tid = db.add_task(Task(title="t", prompt="p", working_dir="."))
    sched._active_pgids[tid] = 999

    def boom(pgid, sig):
        raise OSError("no such pgid")

    monkeypatch.setattr("taskboard.os.killpg", boom)
    sched.cancel_task(tid)  # must not raise
    assert db.get_task(tid)["status"] == "cancelled"


# ── _build_injected_prompt: multiple upstreams concatenated ─────────────────
def test_build_injected_prompt_multiple_upstreams(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    u1 = db.add_task(Task(title="u1", prompt="p", working_dir="."))
    u2 = db.add_task(Task(title="u2", prompt="p", working_dir="."))
    db.update_task(u1, status="completed", result="RESULT ONE")
    db.update_task(u2, status="completed", result="RESULT TWO")
    down = db.add_task(Task(title="down", prompt="MAIN", working_dir="."))
    db.add_dependency(down, u1, inject_result=True)
    db.add_dependency(down, u2, inject_result=True)

    injected = sched._build_injected_prompt(db.get_task(down))
    assert "RESULT ONE" in injected and "RESULT TWO" in injected
    assert injected.strip().endswith("MAIN")


def test_build_injected_prompt_skips_upstream_without_result(tmp_path):
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    up = db.add_task(Task(title="up", prompt="p", working_dir="."))
    db.update_task(up, status="completed")  # no result set
    down = db.add_task(Task(title="down", prompt="ORIG", working_dir="."))
    db.add_dependency(down, up, inject_result=True)
    # inject requested but upstream has no result → original prompt unchanged
    assert sched._build_injected_prompt(db.get_task(down)) == "ORIG"
