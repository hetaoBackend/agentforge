import os

import pytest

from taskboard import TaskDB, TaskScheduler


def make_db(tmp_path):
    return TaskDB(str(tmp_path / "agentforge-test.db"))


def register(sched, db, name="my-skill"):
    # Use the real approval path so files + symlinks exist on disk.
    db.upsert_skill_pattern(name, "recipe", "summary", 1)
    pid = db.conn.execute("SELECT id FROM skill_patterns WHERE pattern_key=?", (name,)).fetchone()[
        "id"
    ]
    body = f"---\nname: {name}\ndescription: d\n---\n\nbody"
    skill = sched.approve_skill(pid, name, "d", body)
    return skill["id"]


def test_disable_removes_symlinks_keeps_canonical(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    sid = register(sched, db)

    claude = os.path.expanduser("~/.claude/skills/my-skill")
    agents = os.path.expanduser("~/.agents/skills/my-skill")
    canonical = os.path.expanduser("~/.agentforge/skills/my-skill/SKILL.md")
    assert os.path.islink(claude) and os.path.islink(agents)

    sched.toggle_skill(sid, False)
    assert not os.path.lexists(claude)  # symlink gone
    assert not os.path.lexists(agents)
    assert os.path.isfile(canonical)  # canonical preserved
    assert db.get_skill(sid)["enabled"] == 0


def test_enable_recreates_symlinks(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    sid = register(sched, db)
    sched.toggle_skill(sid, False)

    sched.toggle_skill(sid, True)
    claude = os.path.expanduser("~/.claude/skills/my-skill")
    agents = os.path.expanduser("~/.agents/skills/my-skill")
    assert os.path.islink(claude) and os.path.islink(agents)
    assert os.path.isfile(os.path.join(claude, "SKILL.md"))
    assert db.get_skill(sid)["enabled"] == 1


def test_toggle_idempotent(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    sid = register(sched, db)
    # disable twice, enable twice — no errors, stable end state
    sched.toggle_skill(sid, False)
    sched.toggle_skill(sid, False)
    sched.toggle_skill(sid, True)
    sched.toggle_skill(sid, True)
    assert db.get_skill(sid)["enabled"] == 1
    assert os.path.islink(os.path.expanduser("~/.claude/skills/my-skill"))


def test_delete_removes_everything(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    sid = register(sched, db)

    sched.remove_skill(sid)
    assert db.get_skill(sid) is None
    assert not os.path.lexists(os.path.expanduser("~/.claude/skills/my-skill"))
    assert not os.path.lexists(os.path.expanduser("~/.agents/skills/my-skill"))
    assert not os.path.isdir(os.path.expanduser("~/.agentforge/skills/my-skill"))


def test_toggle_unknown_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.toggle_skill(99999, True)


def test_delete_unknown_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    with pytest.raises(ValueError, match="not found"):
        sched.remove_skill(99999)


def test_get_skills_lists_registry(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    db = make_db(tmp_path)
    sched = TaskScheduler(db)
    register(sched, db, "skill-a")
    register(sched, db, "skill-b")
    names = {s["name"] for s in db.get_skills()}
    assert names == {"skill-a", "skill-b"}
