// Direct unit tests for TaskScheduler logic not exercised by HTTP tests.
//
// Ported from tests/test_scheduler_logic.py; test() descriptions keep the
// Python test function names.
//
// Covers schedule computation / due dispatch (_tick, _schedule_delayed), heartbeat
// decision flow (idle / notify / suppressed / error), heartbeat next-run + cooldown
// suppression, skill sweep core (run_skill_sweep, _parse_sweep_output,
// _build_sweep_prompt), distill prompt building, submit_task dependency gating, and
// the DAG unblock / cascade-cancel helpers. All agent execution is mocked — no real
// subprocess is ever spawned, and the background loop is never started.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import {
  HeartbeatDecisionType,
  HeartbeatScheduleType,
  ScheduleType,
  makeHeartbeat,
  makeTask,
  type Heartbeat,
} from "../src/types.ts";
import { dateToLocalIso } from "../src/util.ts";

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

/** ≙ the `_mock_agent` helper: stub `_run_agent_command` with a fixed payload. */
function _mock_agent(sched: TaskScheduler, payload: string): void {
  (sched as any)._run_agent_command = async (
    _agent: string,
    _cmd: string[],
    _cwd: string,
    on_stdout_line: ((line: string) => void) | null = null,
  ): Promise<[boolean, string]> => {
    if (on_stdout_line) {
      on_stdout_line(payload);
    }
    return [true, payload];
  };
}

describe("scheduler logic", () => {
  let tmpDir: string;
  let db: TaskDB;
  let sched: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    db = new TaskDB(path.join(tmpDir, "sched-test.db"));
    sched = new TaskScheduler(db);
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── heartbeat next-run computation ──────────────────────────────────────
  test("test_compute_next_run_interval", () => {
    const now = new Date(2024, 0, 1, 12, 0, 0);
    const nxt = db._compute_heartbeat_next_run_at(
      make_heartbeat({ interval_seconds: 90 }),
      now,
    );
    expect(nxt).toBe(dateToLocalIso(new Date(now.getTime() + 90 * 1000)));
  });

  test("test_compute_next_run_cron", () => {
    const now = new Date(2024, 0, 1, 12, 30, 0);
    const hb = make_heartbeat({
      schedule_type: HeartbeatScheduleType.CRON,
      cron_expr: "0 * * * *",
      interval_seconds: null,
    });
    const nxt = db._compute_heartbeat_next_run_at(hb, now);
    expect(nxt).toBe(dateToLocalIso(new Date(2024, 0, 1, 13, 0, 0)));
  });

  test("test_compute_next_run_invalid_raises", () => {
    expect(() =>
      db._compute_heartbeat_next_run_at(
        make_heartbeat({ interval_seconds: 0 }),
        new Date(),
      ),
    ).toThrow(/interval_seconds/);
    expect(() =>
      db._compute_heartbeat_next_run_at(
        make_heartbeat({
          schedule_type: HeartbeatScheduleType.CRON,
          cron_expr: null,
        }),
        new Date(),
      ),
    ).toThrow(/cron_expr/);
  });

  // ── _tick dispatch by schedule type ─────────────────────────────────────
  test("test_tick_promotes_delayed_pending_to_scheduled", () => {
    const tid = db.add_task(
      makeTask({
        title: "delayed",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.DELAYED,
        delay_seconds: 120,
      }),
    );
    const spawned: number[] = [];
    (sched as any)._spawn_task = (t: Row) => spawned.push(t["id"]);

    sched._tick(); // pending delayed → schedules forward, does not spawn yet

    expect(spawned).toEqual([]);
    const task = db.get_task(tid)!;
    expect(task["status"]).toBe("scheduled");
    const nra = new Date(task["next_run_at"]);
    expect(nra.getTime()).toBeGreaterThan(Date.now());
  });

  test("test_tick_spawns_immediate_and_due_cron", () => {
    const imm = db.add_task(
      makeTask({ title: "imm", prompt: "p", working_dir: "." }),
    );
    const cron = db.add_task(
      makeTask({
        title: "cron",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.CRON,
        cron_expr: "* * * * *",
        next_run_at: dateToLocalIso(new Date(Date.now() - 60 * 1000)),
      }),
    );
    db.update_task(cron, { status: "scheduled" });

    const spawned: number[] = [];
    (sched as any)._spawn_task = (t: Row) => spawned.push(t["id"]);

    sched._tick();

    expect(spawned).toContain(imm);
    expect(spawned).toContain(cron);
  });

  test("test_tick_skips_active_task", () => {
    const tid = db.add_task(
      makeTask({ title: "imm", prompt: "p", working_dir: "." }),
    );

    sched._active_tasks.set(tid, { is_alive: () => true });
    const spawned: number[] = [];
    (sched as any)._spawn_task = (t: Row) => spawned.push(t["id"]);

    sched._tick();
    expect(spawned).toEqual([]); // already running, not re-picked
  });

  test("test_tick_shutting_down_is_noop", () => {
    db.add_task(makeTask({ title: "imm", prompt: "p", working_dir: "." }));
    sched._shutting_down = true;
    const called: Row[] = [];
    (sched as any)._spawn_task = (t: Row) => called.push(t);
    sched._tick();
    expect(called).toEqual([]);
  });

  test("test_schedule_delayed_uses_delay_seconds", () => {
    const tid = db.add_task(
      makeTask({
        title: "d",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.DELAYED,
        delay_seconds: 300,
      }),
    );
    const before = Date.now();
    sched._schedule_delayed(db.get_task(tid)!);
    const task = db.get_task(tid)!;
    expect(task["status"]).toBe("scheduled");
    const nra = new Date(task["next_run_at"]).getTime();
    expect(nra).toBeGreaterThanOrEqual(before + 299 * 1000);
    expect(nra).toBeLessThanOrEqual(before + 301 * 1000);
  });

  // ── submit_task scheduling / dependency gating ──────────────────────────
  test("test_submit_task_cron_sets_next_run", () => {
    const tid = sched.submit_task(
      makeTask({
        title: "c",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.CRON,
        cron_expr: "0 0 * * *",
      }),
    );
    const task = db.get_task(tid)!;
    expect(task["status"]).toBe("scheduled");
    expect(task["next_run_at"]).not.toBeNull();
    expect(new Date(task["next_run_at"]).getTime()).toBeGreaterThan(Date.now());
  });

  test("test_submit_task_scheduled_at_requires_next_run", () => {
    expect(() =>
      sched.submit_task(
        makeTask({
          title: "s",
          prompt: "p",
          working_dir: ".",
          schedule_type: ScheduleType.SCHEDULED_AT,
        }),
      ),
    ).toThrow(/next_run_at/);
  });

  test("test_submit_task_blocks_on_unmet_dependency", () => {
    const upstream = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    ); // pending, not completed
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [{ task_id: upstream, inject_result: true }],
    );
    expect(db.get_task(down)!["status"]).toBe("blocked");
    const deps = db.get_dependencies(down);
    expect(deps[0]!["depends_on_task_id"]).toBe(upstream);
    expect(deps[0]!["inject_result"]).toBe(1);
  });

  test("test_submit_task_ready_when_dependency_completed", () => {
    const upstream = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    db.update_task(upstream, { status: "completed" });
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [upstream], // bare int form
    );
    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_submit_task_rolls_back_task_when_dependency_batch_fails", () => {
    expect(() =>
      sched.submit_task(
        makeTask({ title: "orphan", prompt: "p", working_dir: "." }),
        [999],
      ),
    ).toThrow(/Dependency task #999 not found/);

    expect(db.get_all_tasks()).toEqual([]);
  });

  test("test_submit_task_rolls_back_task_and_partial_dependencies_on_insert_error", () => {
    const a = db.add_task(
      makeTask({ title: "a", prompt: "p", working_dir: "." }),
    );
    const b = db.add_task(
      makeTask({ title: "b", prompt: "p", working_dir: "." }),
    );
    db.conn.run(`
      CREATE TRIGGER fail_second_dependency
      BEFORE INSERT ON task_dependencies
      WHEN NEW.depends_on_task_id = ${b}
      BEGIN
        SELECT RAISE(ABORT, 'injected dependency insert failure');
      END
    `);

    expect(() =>
      sched.submit_task(
        makeTask({ title: "rolled back", prompt: "p", working_dir: "." }),
        [a, b],
      ),
    ).toThrow(/injected dependency insert failure/);

    expect(db.get_all_tasks().map((task) => task["id"])).toEqual([a, b]);
    expect(db.get_dependents(a)).toEqual([]);
  });

  // ── DAG unblock / cascade-cancel ────────────────────────────────────────
  test("test_on_task_completed_unblocks_downstream", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [up],
    );
    expect(db.get_task(down)!["status"]).toBe("blocked");

    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);

    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_on_task_completed_keeps_blocked_when_other_dep_pending", () => {
    const a = db.add_task(
      makeTask({ title: "a", prompt: "p", working_dir: "." }),
    );
    const b = db.add_task(
      makeTask({ title: "b", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [a, b],
    );

    db.update_task(a, { status: "completed" });
    sched._on_task_completed(a);
    // b still pending → stays blocked
    expect(db.get_task(down)!["status"]).toBe("blocked");
  });

  test("test_on_task_failed_cascade_cancels", () => {
    const root = db.add_task(
      makeTask({ title: "root", prompt: "p", working_dir: "." }),
    );
    const mid = sched.submit_task(
      makeTask({ title: "mid", prompt: "p", working_dir: "." }),
      [root],
    );
    const leaf = sched.submit_task(
      makeTask({ title: "leaf", prompt: "p", working_dir: "." }),
      [mid],
    );

    sched._on_task_failed(root);

    expect(db.get_task(mid)!["status"]).toBe("cancelled");
    expect(db.get_task(leaf)!["status"]).toBe("cancelled"); // recursive cascade
    expect(db.get_task(mid)!["error"]).toContain(`#${root}`);
  });

  test("test_build_injected_prompt_prepends_upstream_result", () => {
    const up = db.add_task(
      makeTask({ title: "upstream", prompt: "p", working_dir: "." }),
    );
    db.update_task(up, { status: "completed", result: "UPSTREAM OUTPUT" });
    const down = db.add_task(
      makeTask({ title: "down", prompt: "DO THE THING", working_dir: "." }),
    );
    db.add_dependency(down, up, true);

    const injected = sched._build_injected_prompt(db.get_task(down)!);
    expect(injected).toContain("UPSTREAM OUTPUT");
    expect(injected.trim().endsWith("DO THE THING")).toBe(true);
  });

  test("test_build_injected_prompt_without_inject_returns_original", () => {
    const up = db.add_task(
      makeTask({ title: "upstream", prompt: "p", working_dir: "." }),
    );
    db.update_task(up, { status: "completed", result: "X" });
    const down = db.add_task(
      makeTask({ title: "down", prompt: "ORIGINAL", working_dir: "." }),
    );
    db.add_dependency(down, up, false);
    expect(sched._build_injected_prompt(db.get_task(down)!)).toBe("ORIGINAL");
  });

  // ── cancel / retry ──────────────────────────────────────────────────────
  test("test_cancel_and_retry_task", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    db.update_task(tid, { status: "running" });

    sched.cancel_task(tid);
    expect(db.get_task(tid)!["status"]).toBe("cancelled");

    db.update_task(tid, { status: "failed", error: "boom" });
    sched.retry_task(tid);
    const retried = db.get_task(tid)!;
    expect(retried["status"]).toBe("pending");
    expect(retried["error"]).toBeNull();
  });

  // ── heartbeat decision parsing ──────────────────────────────────────────
  test("test_parse_heartbeat_decision_strips_fence_and_normalizes", () => {
    const raw = '```json\n{"decision":"idle","reason":"nothing"}\n```';
    const decision = sched._parse_heartbeat_decision(raw);
    expect(decision["decision"]).toBe("idle");
    expect(decision["reason"]).toBe("nothing");
    // missing fields are coerced to defaults
    expect(decision["title"]).toBe("");
    expect(decision["metadata"]).toEqual({});
  });

  test("test_parse_heartbeat_decision_extracts_embedded_object", () => {
    const raw =
      'noise before {"decision":"trigger_task","dedupe_key":"k"} noise after';
    const decision = sched._parse_heartbeat_decision(raw);
    expect(decision["decision"]).toBe("trigger_task");
    expect(decision["dedupe_key"]).toBe("k");
  });

  test("test_parse_heartbeat_decision_invalid_decision_raises", () => {
    expect(() =>
      sched._parse_heartbeat_decision('{"decision":"explode"}'),
    ).toThrow(/Invalid heartbeat decision/);
  });

  test("test_parse_heartbeat_decision_non_dict_metadata_raises", () => {
    expect(() =>
      sched._parse_heartbeat_decision('{"decision":"idle","metadata":[1,2]}'),
    ).toThrow(/metadata must be an object/);
  });

  test("test_render_heartbeat_check_prompt_includes_action_template", () => {
    const hid = db.add_heartbeat(
      make_heartbeat({ action_prompt_template: "REVIEW THE DIFF" }),
    );
    const prompt = sched._render_heartbeat_check_prompt(db.get_heartbeat(hid)!);
    expect(prompt).toContain("Inspect repo.");
    expect(prompt).toContain("REVIEW THE DIFF");
    expect(prompt).toContain("trigger_task");
  });

  // ── heartbeat tick execution flow ───────────────────────────────────────
  test("test_execute_heartbeat_idle_decision", async () => {
    const hid = db.add_heartbeat(make_heartbeat());
    _mock_agent(sched, JSON.stringify({ decision: "idle", reason: "calm" }));

    await sched._execute_heartbeat(db.get_heartbeat(hid)!);

    expect(db.get_all_tasks()).toEqual([]);
    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.IDLE);
    expect(hb["last_error"]).toBeNull();
    // next_run_at advanced
    expect(new Date(hb["next_run_at"]).getTime()).toBeGreaterThan(Date.now());
    const tick = db.get_latest_heartbeat_tick(hid)!;
    expect(tick["status"]).toBe("idle");
  });

  test("test_execute_heartbeat_notify_only_records_decision", async () => {
    const hid = db.add_heartbeat(make_heartbeat());
    _mock_agent(
      sched,
      JSON.stringify({
        decision: "notify_only",
        reason: "FYI",
        dedupe_key: "n1",
      }),
    );

    await sched._execute_heartbeat(db.get_heartbeat(hid)!);

    expect(db.get_all_tasks()).toEqual([]); // notify does not create a task
    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.NOTIFY_ONLY);
    const tick = db.get_latest_heartbeat_tick(hid)!;
    expect(tick["status"]).toBe(HeartbeatDecisionType.NOTIFY_ONLY);
  });

  test("test_execute_heartbeat_trigger_falls_back_to_action_template", async () => {
    const hid = db.add_heartbeat(
      make_heartbeat({ action_prompt_template: "DEFAULT ACTION" }),
    );
    // decision has no prompt/title → falls back to action_prompt_template + default title
    _mock_agent(
      sched,
      JSON.stringify({ decision: "trigger_task", dedupe_key: "dk" }),
    );

    await sched._execute_heartbeat(db.get_heartbeat(hid)!);

    const tasks = db.get_all_tasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!["prompt"]).toBe("DEFAULT ACTION");
    expect(tasks[0]!["title"]).toBe("Heartbeat: Repo watcher");
    expect(tasks[0]!["tags"]).toBe("heartbeat");
    // dedup row recorded
    expect(db.get_heartbeat_dedup(hid, "dk")).not.toBeNull();
  });

  test("test_execute_heartbeat_agent_failure_records_error", async () => {
    const hid = db.add_heartbeat(make_heartbeat());

    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [false, "agent crashed"];

    await sched._execute_heartbeat(db.get_heartbeat(hid)!);

    const hb = db.get_heartbeat(hid)!;
    expect(hb["last_decision"]).toBe(HeartbeatDecisionType.ERROR);
    expect(hb["last_error"]).toContain("agent crashed");
    expect(db.get_latest_heartbeat_tick(hid)!["status"]).toBe("error");
  });

  // ── heartbeat cooldown suppression ──────────────────────────────────────
  test("test_trigger_suppressed_empty_key_is_false", () => {
    expect(
      sched._heartbeat_trigger_suppressed({ id: 1, cooldown_seconds: 300 }, ""),
    ).toBe(false);
  });

  test("test_trigger_suppressed_during_cooldown", () => {
    const hid = db.add_heartbeat(make_heartbeat({ cooldown_seconds: 600 }));
    db.upsert_heartbeat_dedup(hid, "k", null); // triggered now
    expect(
      sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid)!, "k"),
    ).toBe(true);
  });

  test("test_trigger_not_suppressed_after_cooldown_when_no_active_task", () => {
    const hid = db.add_heartbeat(make_heartbeat({ cooldown_seconds: 60 }));
    db.upsert_heartbeat_dedup(hid, "k", null);
    // age the dedup row past the cooldown
    const old = dateToLocalIso(new Date(Date.now() - 120 * 1000));
    db.conn
      .query(
        "UPDATE heartbeat_dedup SET triggered_at=? WHERE heartbeat_id=? AND dedupe_key=?",
      )
      .run(old, hid, "k");
    expect(
      sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid)!, "k"),
    ).toBe(false);
  });

  test("test_trigger_suppressed_while_prior_task_active", () => {
    const hid = db.add_heartbeat(make_heartbeat({ cooldown_seconds: 0 })); // no cooldown
    const task_id = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    ); // pending = active
    db.upsert_heartbeat_dedup(hid, "k", task_id);
    expect(
      sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid)!, "k"),
    ).toBe(true);

    // once that task completes, the signal is no longer suppressed
    db.update_task(task_id, { status: "completed" });
    expect(
      sched._heartbeat_trigger_suppressed(db.get_heartbeat(hid)!, "k"),
    ).toBe(false);
  });

  // ── trigger_heartbeat_now ───────────────────────────────────────────────
  test("test_trigger_heartbeat_now_unknown_raises", () => {
    expect(() => sched.trigger_heartbeat_now(99999)).toThrow(/not found/);
  });

  // ── skill sweep core ────────────────────────────────────────────────────
  test("test_parse_sweep_output_variants", () => {
    expect(sched._parse_sweep_output("[]")).toEqual([]);
    const fenced = '```json\n[{"pattern_key":"k"}]\n```';
    expect(sched._parse_sweep_output(fenced)).toEqual([{ pattern_key: "k" }]);
    const embedded = 'prose [{"pattern_key":"k2"}] tail';
    expect(sched._parse_sweep_output(embedded)).toEqual([
      { pattern_key: "k2" },
    ]);
    // non-array / garbage → empty list, never raises
    expect(sched._parse_sweep_output('{"a":1}')).toEqual([]);
    expect(sched._parse_sweep_output("not json")).toEqual([]);
    expect(sched._parse_sweep_output("")).toEqual([]);
  });

  test("test_run_skill_sweep_no_runs_short_circuits", async () => {
    const called: unknown[][] = [];
    (sched as any)._run_agent_prompt_once = async (
      ...a: unknown[]
    ): Promise<[boolean, string]> => {
      called.push(a);
      return [true, "[]"];
    };

    const result = await sched.run_skill_sweep("claude");

    expect(result["scanned"]).toBe(0);
    expect(result["detected"]).toBe(0);
    expect(called).toEqual([]); // never invokes the agent when there's nothing to scan
  });

  test("test_run_skill_sweep_detects_and_advances_watermark", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "run pytest", working_dir: "." }),
    );
    const r1 = db.add_run(tid);
    const r2 = db.add_run(tid);
    db.conn
      .query(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
      )
      .run("2024-01-01T00:00:00", r1);
    db.conn
      .query(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
      )
      .run("2024-01-02T00:00:00", r2);

    // agent reuses the same pattern_key across both runs → recurrence aggregates
    const sweep_output = JSON.stringify([
      {
        pattern_key: "run-pytest",
        kind: "recipe",
        summary: "s",
        run_id: r1,
        task_id: tid,
      },
      {
        pattern_key: "run-pytest",
        kind: "recipe",
        summary: "s",
        run_id: r2,
        task_id: tid,
      },
    ]);
    (sched as any)._run_agent_prompt_once = async (): Promise<
      [boolean, string]
    > => [true, sweep_output];

    const result = await sched.run_skill_sweep("claude", true);

    expect(result["scanned"]).toBe(2);
    expect(result["detected"]).toBe(2);
    expect(result["new"]).toBe(2);
    expect(db.get_skill_pattern_recurrence("run-pytest")).toBe(2);
    // watermark advanced to the newest finished_at
    expect(db.get_setting("skill_sweep_watermark")).toBe("2024-01-02T00:00:00");
  });

  test("test_run_skill_sweep_agent_failure_raises", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.conn
      .query(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
      )
      .run("2024-01-01T00:00:00", rid);
    (sched as any)._run_agent_prompt_once = async (): Promise<
      [boolean, string]
    > => [false, "kaboom"];
    await expect(sched.run_skill_sweep("claude", true)).rejects.toThrow(
      /kaboom/,
    );
  });

  test("test_run_skill_sweep_full_ignores_watermark", async () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.conn
      .query(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
      )
      .run("2024-01-01T00:00:00", rid);
    // watermark is past the run; full=true must still re-scan it
    db.set_setting("skill_sweep_watermark", "2030-01-01T00:00:00");
    (sched as any)._run_agent_prompt_once = async (): Promise<
      [boolean, string]
    > => [true, "[]"];

    const result = await sched.run_skill_sweep("claude", true);
    expect(result["scanned"]).toBe(1);
  });

  test("test_skill_sweep_status_reflects_last_result", async () => {
    (sched as any)._run_agent_prompt_once = async (): Promise<
      [boolean, string]
    > => [true, "[]"];
    await sched.run_skill_sweep("claude"); // no runs → cached as last
    const status = sched.skill_sweep_status();
    expect(status.running).toBe(false);
    expect(status.last!["scanned"]).toBe(0);
  });

  // ── prompt builders ─────────────────────────────────────────────────────
  test("test_build_sweep_prompt_lists_existing_and_runs", () => {
    const runs = [
      {
        run_id: 5,
        task_id: 2,
        title: "Run tests",
        prompt: "uv run pytest",
        result: "all green",
      },
    ];
    const existing = [
      {
        pattern_key: "run-pytest",
        kind: "recipe",
        recurrence_count: 3,
        summary: "tests",
      },
    ];
    const prompt = sched._build_sweep_prompt(runs, existing);
    expect(prompt).toContain("run-pytest");
    expect(prompt).toContain("run #5");
    expect(prompt).toContain("uv run pytest");
    // empty existing renders the placeholder
    expect(sched._build_sweep_prompt(runs, [])).toContain("(none yet)");
  });

  test("test_build_distill_context_and_prompt", () => {
    const tid = db.add_task(
      makeTask({ title: "Run tests", prompt: "run pytest", working_dir: "." }),
    );
    const rid = db.add_run(tid);
    db.finish_run(rid, "completed", "green");

    const context = sched._build_distill_context([tid]);
    expect(context).toContain(`task #${tid}`);
    expect(context).toContain("run pytest");
    expect(context).toContain("green");

    const pattern = db.get_skill_pattern(
      db.upsert_skill_pattern("k", "recipe", "summary", tid)!,
    )!;
    const with_creator = sched._build_distill_prompt(
      pattern,
      context,
      "a/SKILL.md",
    );
    expect(with_creator).toContain("skill-creator");
    expect(with_creator).toContain("a/SKILL.md");
    const without_creator = sched._build_distill_prompt(pattern, context, null);
    expect(without_creator).not.toContain("a/SKILL.md");
    expect(without_creator).toContain("skill-creator conventions");
  });

  // ── timezone normalization on submit (scheduled_at) ─────────────────────
  test("test_submit_scheduled_at_naive_passthrough", () => {
    // ≙ Python (now + 2h).replace(microsecond=0).isoformat()
    const naive = dateToLocalIso(new Date(Date.now() + 2 * 3600 * 1000)).slice(
      0,
      19,
    );
    const tid = sched.submit_task(
      makeTask({
        title: "s",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.SCHEDULED_AT,
        next_run_at: naive,
      }),
    );
    // Naive input keeps the same local wall time (no tz shift). Deviation from
    // Python: storage re-serializes with a 6-digit fractional suffix instead of
    // passing the string through byte-identically.
    const stored: string = db.get_task(tid)!["next_run_at"];
    expect(stored.startsWith(naive)).toBe(true);
    expect(new Date(stored).getTime()).toBe(new Date(naive).getTime());
  });

  test("test_submit_scheduled_at_aware_is_localized", () => {
    const aware = new Date(Date.now() + 3 * 3600 * 1000);
    const tid = sched.submit_task(
      makeTask({
        title: "s",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.SCHEDULED_AT,
        next_run_at: aware.toISOString(), // offset-aware (UTC) input
      }),
    );
    // ≙ aware.astimezone().replace(tzinfo=None).isoformat(): local-naive storage
    const expected = dateToLocalIso(aware);
    expect(db.get_task(tid)!["next_run_at"]).toBe(expected);
  });
});
