// Additional direct unit tests for TaskScheduler / heartbeat / skill-sweep
// branches that the other suites don't reach.
//
// Ported from tests/test_scheduler_more.py; test() descriptions keep the
// Python test function names.
//
// Everything constructs TaskDB + TaskScheduler directly, never starts the
// background loop, and mocks every agent invocation so no real CLI is spawned.
// Skill-library file I/O is sandboxed under a temp $HOME.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import {
  AgentExecutor,
  FileNotFoundError,
  OSError,
  TimeoutExpired,
  default_subprocess_run,
} from "../src/executor.ts";
import { TaskScheduler, default_os } from "../src/scheduler.ts";
import {
  _compose_skill_md,
  _parse_skill_frontmatter,
  _sanitize_skill_name,
  _skill_creator_dir,
  expanduser,
  link_skill,
  remove_skill_from_disk,
  unlink_skill,
  write_skill_to_disk,
} from "../src/skills.ts";
import {
  HeartbeatDecisionType,
  HeartbeatScheduleType,
  ScheduleType,
  makeHeartbeat,
  makeTask,
  type Heartbeat,
} from "../src/types.ts";

type Row = Record<string, any>;

function make_heartbeat(overrides: Partial<Heartbeat> = {}): Heartbeat {
  return makeHeartbeat({
    name: "Repo watcher",
    working_dir: ".",
    schedule_type: HeartbeatScheduleType.INTERVAL,
    interval_seconds: 60,
    check_prompt: "Inspect repo.",
    action_prompt_template: "Review the latest changes.",
    default_agent: "claude",
    cooldown_seconds: 300,
    ...overrides,
  });
}

function make_pattern(
  db: TaskDB,
  key = "k",
  recurrence = 3,
  tasks: number[] = [1, 2, 3],
  kind = "recipe",
): number {
  db.upsert_skill_pattern(key, kind, "summary", tasks[0]!);
  db.conn
    .query(
      "UPDATE skill_patterns SET recurrence_count=?, contributing_task_ids=? WHERE pattern_key=?",
    )
    .run(recurrence, JSON.stringify(tasks), key);
  const row = db.conn
    .query("SELECT id FROM skill_patterns WHERE pattern_key=?")
    .get(key) as Row;
  return Number(row["id"]);
}

/** ≙ the `_mock_agent` helper. */
function _mock_agent(
  sched: TaskScheduler,
  payload: string,
  success = true,
): void {
  (sched as any)._run_agent_command = async (
    _agent: string,
    _cmd: string[],
    _cwd: string,
    on_stdout_line: ((line: string) => void) | null = null,
  ): Promise<[boolean, string]> => {
    if (on_stdout_line) {
      on_stdout_line(payload);
    }
    return [success, payload];
  };
}

describe("scheduler more", () => {
  let tmpDir: string;
  let db: TaskDB;
  let sched: TaskScheduler;
  let savedHome: string | undefined;
  let savedSkillCreatorDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    // Sandbox $HOME so the on-disk skill helpers never touch the real home dir.
    savedHome = process.env.HOME;
    savedSkillCreatorDir = process.env.AGENTFORGE_SKILL_CREATOR_DIR;
    process.env.HOME = tmpDir;
    delete process.env.AGENTFORGE_SKILL_CREATOR_DIR;
    db = new TaskDB(path.join(tmpDir, "t.db"));
    sched = new TaskScheduler(db);
  });

  afterEach(() => {
    AgentExecutor.subprocess_run = default_subprocess_run;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedSkillCreatorDir === undefined)
      delete process.env.AGENTFORGE_SKILL_CREATOR_DIR;
    else process.env.AGENTFORGE_SKILL_CREATOR_DIR = savedSkillCreatorDir;
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── on-disk skill helpers (module-level functions) ──────────────────────
  test("test_write_skill_to_disk_creates_canonical_and_symlinks", () => {
    const [md_path, skill_dir] = write_skill_to_disk(
      "My Skill",
      "---\nname: my-skill\n---\nbody",
    );
    expect(fs.statSync(md_path).isFile()).toBe(true);
    expect(path.basename(md_path)).toBe("SKILL.md");
    expect(skill_dir.endsWith("My Skill")).toBe(true);
    const claude = expanduser("~/.claude/skills/My Skill");
    const agents = expanduser("~/.agents/skills/My Skill");
    expect(fs.lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(agents).isSymbolicLink()).toBe(true);
    // symlink target resolves back to canonical SKILL.md
    expect(fs.statSync(path.join(claude, "SKILL.md")).isFile()).toBe(true);
  });

  test("test_link_skill_replaces_stale_symlink", () => {
    write_skill_to_disk("s1", "body-1");
    const claude = expanduser("~/.claude/skills/s1");
    // Point the consumer symlink somewhere stale, then re-link.
    fs.unlinkSync(claude);
    fs.symlinkSync(path.join(tmpDir, "nowhere"), claude, "dir");
    expect(fs.readlinkSync(claude).endsWith("nowhere")).toBe(true);

    const links = link_skill("s1");
    expect(links).toContain(claude);
    // re-link removed the stale link and recreated it at the canonical dir
    expect(
      fs
        .realpathSync(claude)
        .endsWith(path.join(".agentforge", "skills", "s1")),
    ).toBe(true);
  });

  test("test_unlink_skill_removes_only_symlinks", () => {
    write_skill_to_disk("s2", "body-2");
    const canonical = expanduser("~/.agentforge/skills/s2/SKILL.md");
    unlink_skill("s2");
    expect(fs.existsSync(expanduser("~/.claude/skills/s2"))).toBe(false);
    expect(fs.existsSync(expanduser("~/.agents/skills/s2"))).toBe(false);
    expect(fs.statSync(canonical).isFile()).toBe(true); // canonical preserved
    // unlinking again is a no-op (no symlink present)
    unlink_skill("s2");
    expect(fs.statSync(canonical).isFile()).toBe(true);
  });

  test("test_remove_skill_from_disk_wipes_everything", () => {
    write_skill_to_disk("s3", "body-3");
    remove_skill_from_disk("s3");
    expect(fs.existsSync(expanduser("~/.agentforge/skills/s3"))).toBe(false);
    expect(fs.existsSync(expanduser("~/.claude/skills/s3"))).toBe(false);
    // removing a non-existent skill is harmless
    remove_skill_from_disk("never-existed");
  });

  // ── frontmatter / compose / sanitize edges ──────────────────────────────
  test("test_parse_skill_frontmatter_edges", () => {
    // no frontmatter at all
    expect(_parse_skill_frontmatter("just a body")).toEqual(["", ""]);
    // opening fence but no closing fence
    expect(_parse_skill_frontmatter("---\nname: x")).toEqual(["", ""]);
    // well-formed, with a non key:value line and a duplicate that is ignored
    const [name, desc] = _parse_skill_frontmatter(
      "---\nname: my-skill\nbare line without colon\ndescription: does x\nname: ignored\n---\nbody",
    );
    expect(name).toBe("my-skill");
    expect(desc).toBe("does x");
    // leading whitespace is tolerated
    expect(_parse_skill_frontmatter("   \n---\nname: lead\n---\n")[0]).toBe(
      "lead",
    );
  });

  test("test_compose_skill_md_flattens_and_strips", () => {
    const md = _compose_skill_md("nm", "  multi\nline desc  ", "  body here  ");
    expect(md).toContain("name: nm");
    expect(md).toContain("description: multi line desc");
    expect(md.trim().endsWith("body here")).toBe(true);
    // null inputs don't blow up
    expect(_compose_skill_md("nm", null, null)).toContain("name: nm");
  });

  test("test_sanitize_skill_name_edges", () => {
    expect(_sanitize_skill_name("  Hello World  ")).toBe("hello-world");
    expect(_sanitize_skill_name("-leading-and-trailing-")).toBe(
      "leading-and-trailing",
    );
    expect(_sanitize_skill_name(null)).toBe("");
  });

  test("test_skill_creator_dir_honors_packaged_resource_override", () => {
    const packaged = path.join(tmpDir, "Resources", "vendor", "skill-creator");
    process.env.AGENTFORGE_SKILL_CREATOR_DIR = packaged;

    expect(_skill_creator_dir()).toBe(packaged);
  });

  // ── AgentExecutor.run (subprocess mocked — not the _execute_task path) ───
  test("test_agent_executor_run_extracts_result_event", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", message: "thinking" }),
      JSON.stringify({ type: "result", result: "FINAL ANSWER" }),
      "", // blank line skipped
    ].join("\n");
    const captured: Row = {};
    AgentExecutor.subprocess_run = (cmd: string[]) => {
      captured["cmd"] = cmd;
      return { returncode: 0, stdout, stderr: "" };
    };
    const [ok, out] = AgentExecutor.run(
      "do it",
      ".",
      undefined as unknown as number,
      ["/tmp/a.png"],
    );
    expect(ok).toBe(true);
    expect(out).toBe("FINAL ANSWER");
    // image path threaded through as -i
    expect(captured["cmd"]).toContain("-i");
    expect(captured["cmd"]).toContain("/tmp/a.png");
  });

  test("test_agent_executor_run_no_result_event_returns_full_stdout", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: "no result line",
    });
    AgentExecutor.subprocess_run = () => ({
      returncode: 0,
      stdout,
      stderr: "",
    });
    const [ok, out] = AgentExecutor.run("p");
    expect(ok).toBe(true);
    expect(out).toBe(stdout); // falls back to full stdout when no result event
  });

  test("test_agent_executor_run_nonzero_returns_stderr", () => {
    AgentExecutor.subprocess_run = () => ({
      returncode: 1,
      stdout: "",
      stderr: "the error",
    });
    const [ok, out] = AgentExecutor.run("p");
    expect(ok).toBe(false);
    expect(out).toBe("the error");
  });

  test("test_agent_executor_run_tolerates_garbage_lines", () => {
    // A non-JSON line precedes the result event; the parse error is swallowed.
    const stdout = [
      "this is not json",
      JSON.stringify({ type: "result", result: "OK" }),
    ].join("\n");
    AgentExecutor.subprocess_run = () => ({
      returncode: 0,
      stdout,
      stderr: "",
    });
    const [ok, out] = AgentExecutor.run("p");
    expect(ok).toBe(true);
    expect(out).toBe("OK");
  });

  test("test_agent_executor_run_timeout", () => {
    AgentExecutor.subprocess_run = (cmd: string[]) => {
      throw new TimeoutExpired(cmd, 600);
    };
    const [ok, out] = AgentExecutor.run("p", ".", 600);
    expect(ok).toBe(false);
    expect(out).toContain("timed out");
  });

  test("test_agent_executor_run_missing_cli", () => {
    AgentExecutor.subprocess_run = () => {
      throw new FileNotFoundError();
    };
    const [ok, out] = AgentExecutor.run("p");
    expect(ok).toBe(false);
    expect(out).toContain("not found");
  });

  test("test_agent_executor_run_oserror", () => {
    AgentExecutor.subprocess_run = () => {
      throw new OSError("disk gone");
    };
    const [ok, out] = AgentExecutor.run("p");
    expect(ok).toBe(false);
    expect(out).toContain("disk gone");
  });

  // ── _run_agent_prompt_once builds the right CLI per agent ────────────────
  test("test_run_agent_prompt_once_codex_command", async () => {
    const seen: Row = {};
    (sched as any)._run_agent_command = async (
      agent: string,
      cmd: string[],
      cwd: string,
    ): Promise<[boolean, string]> => {
      seen["agent"] = agent;
      seen["cmd"] = cmd;
      seen["cwd"] = cwd;
      return [true, "ok"];
    };
    const [ok, out] = await sched._run_agent_prompt_once(
      "codex",
      "the prompt",
      ".",
    );
    expect(ok).toBe(true);
    expect(out).toBe("ok");
    expect(seen["cmd"][0]).toBe("codex");
    expect(seen["cmd"]).toContain("--json");
    expect(seen["cmd"][seen["cmd"].length - 1]).toBe("the prompt");
  });

  test("test_run_agent_prompt_once_claude_command", async () => {
    const seen: Row = {};
    (sched as any)._run_agent_command = async (
      _agent: string,
      cmd: string[],
    ): Promise<[boolean, string]> => {
      seen["cmd"] = cmd;
      return [true, "ok"];
    };
    await sched._run_agent_prompt_once("claude", "p2", ".");
    expect(seen["cmd"][0]).toBe("claude");
    expect(seen["cmd"][1]).toBe("-p");
  });

  // ── heartbeat: codex prompt path + resume decision ──────────────────────
  test("test_execute_heartbeat_codex_agent_builds_codex_cmd", async () => {
    const hid = db.add_heartbeat(make_heartbeat({ default_agent: "codex" }));
    const seen: Row = {};

    (sched as any)._run_agent_command = async (
      agent: string,
      cmd: string[],
    ): Promise<[boolean, string]> => {
      seen["cmd"] = cmd;
      seen["agent"] = agent;
      return [true, JSON.stringify({ decision: "idle", reason: "calm" })];
    };
    await sched._execute_heartbeat(db.get_heartbeat(hid)!);

    expect(seen["agent"]).toBe("codex");
    expect(seen["cmd"][0]).toBe("codex");
    expect(seen["cmd"]).toContain("--json");
    expect(db.get_heartbeat(hid)!["last_decision"]).toBe(
      HeartbeatDecisionType.IDLE,
    );
  });

  test("test_execute_heartbeat_resume_decision_records_status", async () => {
    const hid = db.add_heartbeat(make_heartbeat());
    // A non-idle, non-trigger decision flows down the generic finish branch.
    _mock_agent(
      sched,
      JSON.stringify({ decision: "error", reason: "self-reported error" }),
    );
    await sched._execute_heartbeat(db.get_heartbeat(hid)!);
    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.ERROR);
    const tick = db.get_latest_heartbeat_tick(hid)!;
    expect(tick["status"]).toBe(HeartbeatDecisionType.ERROR);
  });

  test("test_execute_heartbeat_trigger_then_suppressed_records_idle", async () => {
    const hid = db.add_heartbeat(make_heartbeat({ cooldown_seconds: 600 }));
    const payload = JSON.stringify({
      decision: "trigger_task",
      dedupe_key: "dk",
      prompt: "do it",
    });
    _mock_agent(sched, payload);

    await sched._execute_heartbeat(db.get_heartbeat(hid)!); // first → triggers a task
    expect(db.get_all_tasks().length).toBe(1);
    await sched._execute_heartbeat(db.get_heartbeat(hid)!); // second → suppressed → idle

    expect(db.get_all_tasks().length).toBe(1);
    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.IDLE);
    const tick = db.get_latest_heartbeat_tick(hid)!;
    expect(JSON.parse(tick["decision_payload"])["reason"]).toContain(
      "Suppressed duplicate",
    );
  });

  test("test_execute_heartbeat_trigger_uses_decision_prompt_over_template", async () => {
    const hid = db.add_heartbeat(
      make_heartbeat({ action_prompt_template: "TEMPLATE" }),
    );
    _mock_agent(
      sched,
      JSON.stringify({
        decision: "trigger_task",
        prompt: "CUSTOM PROMPT",
        title: "Custom",
      }),
    );
    await sched._execute_heartbeat(db.get_heartbeat(hid)!);
    const tasks = db.get_all_tasks();
    expect(tasks[0]!["prompt"]).toBe("CUSTOM PROMPT");
    expect(tasks[0]!["title"]).toBe("Custom");
  });

  test("test_execute_heartbeat_codex_agent_failure_raises_inline", async () => {
    const hid = db.add_heartbeat(make_heartbeat({ default_agent: "codex" }));

    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [false, "codex crashed"];
    await sched._execute_heartbeat(db.get_heartbeat(hid)!);
    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.ERROR);
    expect(hb["last_error"]).toContain("codex crashed");
  });

  // ── _heartbeat_trigger_suppressed edge: unparseable triggered_at ────────
  test("test_trigger_suppressed_bad_timestamp_falls_through", () => {
    const hid = db.add_heartbeat(make_heartbeat({ cooldown_seconds: 600 }));
    db.upsert_heartbeat_dedup(hid, "k", null);
    db.conn
      .query(
        "UPDATE heartbeat_dedup SET triggered_at=? WHERE heartbeat_id=? AND dedupe_key=?",
      )
      .run("not-a-date", hid, "k");
    // bad timestamp → cooldown check skipped, no active task → not suppressed
    expect(
      sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid)!, "k"),
    ).toBe(false);
  });

  // ── pause / resume heartbeat ────────────────────────────────────────────
  test("test_pause_heartbeat_disables", () => {
    const hid = db.add_heartbeat(make_heartbeat());
    sched.pause_heartbeat(hid);
    expect(db.get_heartbeat(hid)!["enabled"]).toBe(false);
  });

  test("test_resume_heartbeat_enables_and_schedules", () => {
    const hid = db.add_heartbeat(make_heartbeat());
    sched.pause_heartbeat(hid);
    sched.resume_heartbeat(hid);
    const hb = db.get_heartbeat(hid)!;
    expect(hb["enabled"]).toBe(true);
    expect(new Date(hb["next_run_at"]).getTime()).toBeGreaterThan(Date.now());
  });

  test("test_pause_resume_unknown_raises", () => {
    expect(() => sched.pause_heartbeat(99999)).toThrow(/not found/);
    expect(() => sched.resume_heartbeat(99999)).toThrow(/not found/);
  });

  // ── trigger_heartbeat_now: already running guard ────────────────────────
  test("test_trigger_heartbeat_now_already_running_raises", () => {
    const hid = db.add_heartbeat(make_heartbeat());

    sched._active_heartbeats.set(hid, { is_alive: () => true });
    expect(() => sched.trigger_heartbeat_now(hid)).toThrow(/already running/);
  });

  // ── distill: contributing_task_ids parse fallbacks ──────────────────────
  test("test_distill_skill_draft_bad_task_ids_json", async () => {
    const pid = make_pattern(db);
    // Corrupt the JSON so the parse fails → tids defaults to []
    db.conn
      .query("UPDATE skill_patterns SET contributing_task_ids=? WHERE id=?")
      .run("not json", pid);
    const obj = { name: "X", description: "d", body_markdown: "b" };
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, JSON.stringify(obj)];

    const draft = await sched.distill_skill_draft(pid, "claude");
    expect(draft["name"]).toBe("x");
    expect(db.get_skill_draft(pid)!["status"]).toBe("ready");
  });

  test("test_distill_skill_draft_unknown_pattern_raises", async () => {
    await expect(sched.distill_skill_draft(99999)).rejects.toThrow(
      /pattern not found/,
    );
  });

  test("test_distill_falls_back_to_pattern_key_when_no_name", async () => {
    const pid = make_pattern(db, "my-recurring-thing");
    const obj = { description: "d", body_markdown: "b" }; // no name
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, JSON.stringify(obj)];
    const draft = await sched.distill_skill_draft(pid, "claude");
    expect(draft["name"]).toBe("my-recurring-thing");
  });

  // ── trigger_skill_draft: marks 'drafting' for a real pattern ────────────
  test("test_trigger_skill_draft_sets_drafting_status", async () => {
    const pid = make_pattern(db);
    // keep the agent from doing anything real; the worker will use it
    (sched as any).distill_skill_draft = async () => {
      db.upsert_skill_draft(pid, "ready", "x", "", "recipe", "b");
    };
    expect(sched.trigger_skill_draft(pid)).toBe(true);
    // row exists (either still 'drafting' or already 'ready' from the worker)
    const draft = db.get_skill_draft(pid);
    expect(draft).not.toBeNull();
    expect(["drafting", "ready"]).toContain(draft!["status"]);
  });

  // ── distill prompt building: codex agent default resolution ─────────────
  test("test_distill_agent_resolution_uses_setting", async () => {
    db.set_setting("skill_sweep_agent", "codex");
    const pid = make_pattern(db);
    const seen: Row = {};
    const obj = { name: "x", description: "d", body_markdown: "b" };

    (sched as any)._run_agent_command = async (
      agent: string,
    ): Promise<[boolean, string]> => {
      seen["agent"] = agent;
      return [true, JSON.stringify(obj)];
    };
    await sched.distill_skill_draft(pid); // no agent arg → resolves from setting
    expect(seen["agent"]).toBe("codex");
  });

  // ── skill-sweep: non-dict items skipped, recurrence drives 'new' ────────
  test("test_run_skill_sweep_skips_non_dict_items", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.finish_run(rid, "completed", "ok");

    const payload = JSON.stringify([
      "garbage-string", // non-dict → skipped
      { pattern_key: "real", kind: "recipe", summary: "s", task_id: tid },
      { pattern_key: "", kind: "recipe", summary: "s" }, // blank key → not upserted
    ]);
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, payload];

    const result = await sched.run_skill_sweep("claude", true);
    expect(result["scanned"]).toBe(1);
    expect(result["detected"]).toBe(1); // only the valid keyed entry
    expect(db.get_skill_pattern_recurrence("real")).toBe(1);
  });

  test("test_run_skill_sweep_resolves_default_agent_setting", async () => {
    db.set_setting("default_agent", "codex");
    const result = await sched.run_skill_sweep(); // no runs → short-circuits but resolves agent
    expect(result["agent"]).toBe("codex");
  });

  // ── trigger_skill_sweep background worker captures error ────────────────
  test("test_trigger_skill_sweep_worker_records_error", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.finish_run(rid, "completed", "ok");

    (sched as any).run_skill_sweep = async () => {
      throw new Error("worker boom");
    };
    expect(sched.trigger_skill_sweep(null, true)).toBe(true);
    // poll until the background worker records the error to sweep status
    for (let i = 0; i < 50; i++) {
      const status = sched.skill_sweep_status();
      if (status.last && "error" in status.last) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const status = sched.skill_sweep_status();
    expect(status.running).toBe(false);
    expect(status.last!["error"]).toBe("worker boom");
  });

  // ── DAG post-execution hooks: scheduled_at / cron unblock to 'scheduled' ─
  test("test_on_task_completed_unblocks_scheduled_at_to_scheduled", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const down = sched.submit_task(
      makeTask({
        title: "down",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.SCHEDULED_AT,
        next_run_at: future,
      }),
      [up],
    );
    expect(db.get_task(down)!["status"]).toBe("blocked");

    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    // scheduled_at downstream unblocks into 'scheduled', not 'pending'
    expect(db.get_task(down)!["status"]).toBe("scheduled");
  });

  test("test_on_task_completed_unblocks_cron_to_scheduled", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({
        title: "down",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.CRON,
        cron_expr: "0 0 * * *",
      }),
      [up],
    );
    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    expect(db.get_task(down)!["status"]).toBe("scheduled");
  });

  test("test_on_task_completed_unblocks_delayed_to_pending", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({
        title: "down",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.DELAYED,
        delay_seconds: 30,
      }),
      [up],
    );
    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_on_task_completed_unblocks_immediate_to_pending", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }), // immediate
      [up],
    );
    expect(db.get_task(down)!["status"]).toBe("blocked");
    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_on_task_failed_cancels_pending_and_scheduled_downstream", () => {
    // The existing suite covers the blocked→cancelled chain; here we exercise the
    // pending/scheduled cancellable states and a diamond (shared downstream).
    const root = db.add_task(
      makeTask({ title: "root", prompt: "p", working_dir: "." }),
    );
    const a = db.add_task(
      makeTask({ title: "a", prompt: "p", working_dir: "." }),
    );
    const b = db.add_task(
      makeTask({ title: "b", prompt: "p", working_dir: "." }),
    );
    db.add_dependency(a, root);
    db.add_dependency(b, root);
    db.update_task(a, { status: "pending" });
    db.update_task(b, { status: "scheduled" });
    sched._on_task_failed(root);
    expect(db.get_task(a)!["status"]).toBe("cancelled");
    expect(db.get_task(b)!["status"]).toBe("cancelled");
  });

  test("test_on_task_completed_ignores_non_blocked_dependents", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = db.add_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
    );
    db.add_dependency(down, up);
    // downstream is 'pending', not 'blocked' → hook leaves it alone
    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_on_task_failed_skips_already_running_downstream", () => {
    const root = db.add_task(
      makeTask({ title: "root", prompt: "p", working_dir: "." }),
    );
    const down = db.add_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
    );
    db.add_dependency(down, root);
    db.update_task(down, { status: "running" }); // not a cancellable state
    sched._on_task_failed(root);
    expect(db.get_task(down)!["status"]).toBe("running"); // untouched
  });

  // ── cancel_task with a registered pgid path ─────────────────────────────
  test("test_cancel_task_with_pgid_attempts_killpg", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    db.update_task(tid, { status: "running" });
    sched._active_pgids.set(tid, 424242);
    const killed: number[] = [];
    sched._os = {
      ...default_os,
      killpg: (pgid: number) => {
        killed.push(pgid);
      },
    };
    sched.cancel_task(tid);
    expect(killed).toEqual([424242]);
    expect(db.get_task(tid)!["status"]).toBe("cancelled");
  });

  test("test_cancel_task_flushes_pending_output_events", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.add_output_event(tid, rid, "assistant", "before cancel");

    sched.cancel_task(tid);

    const events = db.conn
      .query("SELECT content FROM task_output_events WHERE run_id = ?")
      .all(rid) as Row[];
    expect(events.map((event) => event["content"])).toEqual(["before cancel"]);
  });

  test("test_stop_flushes_pending_output_events", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.add_output_event(tid, rid, "assistant", "before stop");

    await sched.stop();

    const events = db.conn
      .query("SELECT content FROM task_output_events WHERE run_id = ?")
      .all(rid) as Row[];
    expect(events.map((event) => event["content"])).toEqual(["before stop"]);
  });

  test("test_cancel_task_pgid_killpg_oserror_swallowed", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    sched._active_pgids.set(tid, 999);

    sched._os = {
      ...default_os,
      killpg: () => {
        throw new OSError("no such pgid");
      },
    };
    sched.cancel_task(tid); // must not raise
    expect(db.get_task(tid)!["status"]).toBe("cancelled");
  });

  // ── _build_injected_prompt: multiple upstreams concatenated ─────────────
  test("test_build_injected_prompt_multiple_upstreams", () => {
    const u1 = db.add_task(
      makeTask({ title: "u1", prompt: "p", working_dir: "." }),
    );
    const u2 = db.add_task(
      makeTask({ title: "u2", prompt: "p", working_dir: "." }),
    );
    db.update_task(u1, { status: "completed", result: "RESULT ONE" });
    db.update_task(u2, { status: "completed", result: "RESULT TWO" });
    const down = db.add_task(
      makeTask({ title: "down", prompt: "MAIN", working_dir: "." }),
    );
    db.add_dependency(down, u1, true);
    db.add_dependency(down, u2, true);

    const injected = sched._build_injected_prompt(db.get_task(down)!);
    expect(injected).toContain("RESULT ONE");
    expect(injected).toContain("RESULT TWO");
    expect(injected.trim().endsWith("MAIN")).toBe(true);
  });

  test("test_build_injected_prompt_skips_upstream_without_result", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    db.update_task(up, { status: "completed" }); // no result set
    const down = db.add_task(
      makeTask({ title: "down", prompt: "ORIG", working_dir: "." }),
    );
    db.add_dependency(down, up, true);
    // inject requested but upstream has no result → original prompt unchanged
    expect(sched._build_injected_prompt(db.get_task(down)!)).toBe("ORIG");
  });
});
