// Skill-pattern ledger + skill-sweep tests.
//
// Ported from tests/test_skill_patterns.py; test() descriptions keep the
// Python test function names.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import { makeTask } from "../src/types.ts";

describe("skill patterns", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    db = new TaskDB(path.join(tmpDir, "agentforge-test.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function add_completed_task(
    title = "Run tests",
    prompt = "run the test suite",
    result = "ok",
  ) {
    const tid = db.add_task(makeTask({ title, prompt, working_dir: "." }));
    const run_id = db.add_run(tid);
    db.finish_run(run_id, "completed", result, null, "");
    return tid;
  }

  // ── upsert / dedup ledger ──────────────────────────────────────────────
  test("test_upsert_new_then_bump", () => {
    const pid = db.upsert_skill_pattern(
      "run-pytest",
      "recipe",
      "run pytest suite",
      1,
    );
    expect(pid).not.toBeNull();

    let patterns = db.get_skill_patterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0]!["recurrence_count"]).toBe(1);
    expect(JSON.parse(patterns[0]!["contributing_task_ids"])).toEqual([1]);
    expect(patterns[0]!["status"]).toBe("tracking");

    db.upsert_skill_pattern("run-pytest", "recipe", "updated summary", 2);
    patterns = db.get_skill_patterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0]!["recurrence_count"]).toBe(2);
    expect(new Set(JSON.parse(patterns[0]!["contributing_task_ids"]))).toEqual(
      new Set([1, 2]),
    );
    expect(patterns[0]!["summary"]).toBe("updated summary");
  });

  test("test_upsert_distinct_keys", () => {
    db.upsert_skill_pattern("a", "recipe", "s", 1);
    db.upsert_skill_pattern("b", "pitfall", "s", 1);
    const patterns = db.get_skill_patterns();
    expect(patterns.length).toBe(2);
    expect(new Set(patterns.map((p) => p["kind"]))).toEqual(
      new Set(["recipe", "pitfall"]),
    );
  });

  test("test_upsert_ignores_blank_key", () => {
    expect(db.upsert_skill_pattern("", "recipe", "s", 1)).toBeNull();
    expect(db.upsert_skill_pattern("   ", "recipe", "s", 1)).toBeNull();
    expect(db.get_skill_patterns()).toEqual([]);
  });

  test("test_upsert_invalid_kind_defaults_to_recipe", () => {
    db.upsert_skill_pattern("k", "bogus", "s", 1);
    expect(db.get_skill_patterns()[0]!["kind"]).toBe("recipe");
  });

  test("test_same_task_counts_occurrence_but_not_distinct", () => {
    db.upsert_skill_pattern("k", "recipe", "s", 5);
    db.upsert_skill_pattern("k", "recipe", "s", 5);
    const p = db.get_skill_patterns()[0]!;
    expect(p["recurrence_count"]).toBe(2); // each observation bumps the count
    expect(JSON.parse(p["contributing_task_ids"])).toEqual([5]); // but distinct tasks stay = 1
  });

  // ── completed-runs watermark query ─────────────────────────────────────
  test("test_get_completed_runs_since_watermark", () => {
    add_completed_task();
    add_completed_task("Deploy");
    expect(db.get_completed_runs_since("").length).toBe(2);
    expect(db.get_completed_runs_since("2999-01-01T00:00:00")).toEqual([]);
  });

  test("test_get_completed_runs_excludes_unfinished", () => {
    const tid = db.add_task(makeTask({ title: "Pending", prompt: "x" }));
    db.add_run(tid); // left running, no finish
    expect(db.get_completed_runs_since("")).toEqual([]);
  });

  // ── sweep output parsing ───────────────────────────────────────────────
  test("test_parse_sweep_output_variants", () => {
    const sched = new TaskScheduler(db);
    const arr =
      '[{"pattern_key":"x","kind":"recipe","summary":"s","task_id":1}]';
    expect(
      (sched._parse_sweep_output(arr).items[0] as any)["pattern_key"],
    ).toBe("x");
    expect(
      (
        sched._parse_sweep_output("```json\n" + arr + "\n```")
          .items[0] as any
      )["pattern_key"],
    ).toBe("x");
    expect(
      (
        sched._parse_sweep_output("Here you go:\n" + arr + "\nDone.")
          .items[0] as any
      )["pattern_key"],
    ).toBe("x");
    expect(sched._parse_sweep_output("nonsense")).toEqual({
      ok: false,
      items: [],
    });
    expect(sched._parse_sweep_output("[]")).toEqual({
      ok: true,
      items: [],
    });
    expect(sched._parse_sweep_output("")).toEqual({
      ok: false,
      items: [],
    });
  });

  // ── full sweep (mocked agent) ──────────────────────────────────────────
  test("test_run_skill_sweep_upserts_and_advances_watermark", async () => {
    const sched = new TaskScheduler(db);
    const t1 = add_completed_task("Run tests", "run pytest");
    const t2 = add_completed_task("Run tests again", "run the suite");

    const payload = JSON.stringify([
      {
        pattern_key: "run-test-suite",
        kind: "recipe",
        summary: "run pytest",
        task_id: t1,
      },
      {
        pattern_key: "run-test-suite",
        kind: "recipe",
        summary: "run pytest",
        task_id: t2,
      },
    ]);

    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, payload];

    const result = await sched.run_skill_sweep("claude");
    expect(result["scanned"]).toBe(2);
    expect(result["detected"]).toBe(2);

    const patterns = db.get_skill_patterns();
    expect(patterns.length).toBe(1);
    expect(patterns[0]!["recurrence_count"]).toBe(2);
    expect(new Set(JSON.parse(patterns[0]!["contributing_task_ids"]))).toEqual(
      new Set([t1, t2]),
    );

    expect(db.get_setting("skill_sweep_watermark", "")).not.toBe("");

    // second sweep: watermark consumed everything → nothing new
    const result2 = await sched.run_skill_sweep("claude");
    expect(result2["scanned"]).toBe(0);
    expect(result2["detected"]).toBe(0);
  });

  test("test_run_skill_sweep_empty_history", async () => {
    const sched = new TaskScheduler(db);
    const result = await sched.run_skill_sweep("claude");
    expect(result["scanned"]).toBe(0);
    expect(result["detected"]).toBe(0);
    expect(result["agent"]).toBe("claude");
    expect(result["watermark"]).toBe("");
  });

  test("test_upsert_run_id_idempotent", () => {
    // same run_id seen twice → counted once
    db.upsert_skill_pattern("k", "recipe", "s", 1, 100);
    db.upsert_skill_pattern("k", "recipe", "s", 1, 100);
    let p = db.get_skill_patterns()[0]!;
    expect(p["recurrence_count"]).toBe(1);
    expect(JSON.parse(p["contributing_run_ids"])).toEqual([100]);
    // a different run of the same task → new occurrence
    db.upsert_skill_pattern("k", "recipe", "s", 1, 101);
    p = db.get_skill_patterns()[0]!;
    expect(p["recurrence_count"]).toBe(2);
    expect(new Set(JSON.parse(p["contributing_run_ids"]))).toEqual(
      new Set([100, 101]),
    );
    expect(JSON.parse(p["contributing_task_ids"])).toEqual([1]); // still one distinct task
  });

  test("test_full_sweep_rescan_does_not_inflate", async () => {
    const sched = new TaskScheduler(db);
    const t1 = add_completed_task("ETL", "run weekly etl");
    const t2 = add_completed_task("ETL", "run weekly etl again");
    const run1 = db.get_task_runs(t1)[0]!["id"];
    const run2 = db.get_task_runs(t2)[0]!["id"];

    const payload = JSON.stringify([
      {
        pattern_key: "weekly-etl",
        kind: "recipe",
        summary: "etl",
        run_id: run1,
        task_id: t1,
      },
      {
        pattern_key: "weekly-etl",
        kind: "recipe",
        summary: "etl",
        run_id: run2,
        task_id: t2,
      },
    ]);
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, payload];

    const r1 = await sched.run_skill_sweep("claude", true);
    expect(r1["scanned"]).toBe(2);
    expect(r1["new"]).toBe(2);
    expect(db.get_skill_patterns()[0]!["recurrence_count"]).toBe(2);

    // Re-scan the SAME runs → idempotent: recurrence unchanged, no new occurrences
    const r2 = await sched.run_skill_sweep("claude", true);
    expect(r2["scanned"]).toBe(2);
    expect(r2["new"]).toBe(0);
    expect(db.get_skill_patterns()[0]!["recurrence_count"]).toBe(2);
  });

  test("test_run_skill_sweep_agent_failure_raises", async () => {
    const sched = new TaskScheduler(db);
    add_completed_task();

    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [false, "agent exploded"];

    await expect(sched.run_skill_sweep("claude")).rejects.toThrow(
      /agent exploded/,
    );
    // failed sweep must not advance the watermark
    expect(db.get_setting("skill_sweep_watermark", "")).toBe("");
  });

  test("test_run_skill_sweep_parse_failure_does_not_advance_watermark", async () => {
    const sched = new TaskScheduler(db);
    add_completed_task();
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, "not valid json"];

    await expect(sched.run_skill_sweep("claude")).rejects.toThrow(
      /invalid JSON array/,
    );
    expect(db.get_setting("skill_sweep_watermark", "")).toBe("");
  });

  test("test_run_skill_sweep_valid_empty_result_advances_watermark", async () => {
    const sched = new TaskScheduler(db);
    const tid = add_completed_task();
    const finishedAt = db.get_task_runs(tid)[0]!["finished_at"];
    (sched as any)._run_agent_command = async (): Promise<
      [boolean, string]
    > => [true, "[]"];

    const result = await sched.run_skill_sweep("claude");

    expect(result["detected"]).toBe(0);
    expect(result["watermark"]).toBe(finishedAt);
    expect(db.get_setting("skill_sweep_watermark", "")).toBe(finishedAt);
  });

  test("test_scheduled_sweep_advances_next_run_only_when_started", () => {
    const sched = new TaskScheduler(db);
    const due = "2000-01-01T00:00:00";
    db.set_setting("skill_library_enabled", "1");
    db.set_setting("skill_sweep_cron", "0 3 * * *");
    db.set_setting("skill_sweep_next_run", due);

    (sched as any).trigger_skill_sweep = () => false;
    sched._maybe_run_scheduled_sweep();
    expect(db.get_setting("skill_sweep_next_run", "")).toBe(due);

    (sched as any).trigger_skill_sweep = () => true;
    sched._maybe_run_scheduled_sweep();
    expect(db.get_setting("skill_sweep_next_run", "")).not.toBe(due);
  });

  test("test_trigger_skill_sweep_guards_concurrency", () => {
    const sched = new TaskScheduler(db);
    // Simulate an in-flight sweep
    sched._skill_sweep_running = true;
    expect(sched.trigger_skill_sweep()).toBe(false);
    const status = sched.skill_sweep_status();
    expect(status.running).toBe(true);
  });
});
