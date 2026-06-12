// Direct unit tests for TaskDB internals not exercised by HTTP CRUD tests.
//
// Covers: settings, run history, output events, completed-run queries used by
// the skill sweep, skill_patterns ledger (idempotent recurrence counting),
// draft upsert/clear, candidate refresh windowing, dependency rows, and
// cascading delete. Constructs TaskDB directly against a tmp-dir SQLite file.
//
// Ported from tests/test_taskdb.py; test() descriptions keep the Python
// test function names.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import { ScheduleType, makeTask } from "../src/types.ts";
import { dateToLocalIso } from "../src/util.ts";

describe("TaskDB", () => {
  let tmpDir: string;
  let db: TaskDB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    db = new TaskDB(path.join(tmpDir, "taskdb-test.db"));
  });

  afterEach(() => {
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── completed-run queries (skill sweep inputs) helper ─────────────────────
  function finishWithTimestamp(run_id: number, finished_at: string): void {
    db.conn
      .query(
        "UPDATE task_runs SET status='completed', finished_at=? WHERE id=?",
      )
      .run(finished_at, run_id);
  }

  // ── settings ───────────────────────────────────────────────────────────────
  test("test_settings_get_default_and_set_overwrite", () => {
    expect(db.get_setting("missing")).toBeNull();
    expect(db.get_setting("missing", "fallback")).toBe("fallback");
    db.set_setting("k", "v1");
    expect(db.get_setting("k")).toBe("v1");
    db.set_setting("k", "v2"); // INSERT OR REPLACE
    expect(db.get_setting("k")).toBe("v2");
  });

  // ── run history ────────────────────────────────────────────────────────────
  test("test_run_lifecycle_and_ordering", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const run1 = db.add_run(tid);
    db.finish_run(run1, "completed", "ok", null, "raw1");
    const run2 = db.add_run(tid);
    db.finish_run(run2, "failed", null, "boom");

    const runs = db.get_task_runs(tid);
    expect(new Set(runs.map((r) => r["status"]))).toEqual(
      new Set(["completed", "failed"]),
    );
    expect(new Set(runs.map((r) => r["id"]))).toEqual(new Set([run1, run2]));
    const completed = runs.find((r) => r["id"] === run1)!;
    expect(completed["result"]).toBe("ok");
    expect(completed["raw_output"]).toBe("raw1");
    expect(completed["finished_at"]).not.toBeNull();
  });

  test("test_finish_run_and_update_task_is_atomic", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const rid = db.add_run(tid);

    db.finish_run_and_update_task(
      rid,
      "completed",
      tid,
      { status: "completed", result: "done", run_count: 1 },
      "done",
    );

    const run = db.get_task_runs(tid)[0]!;
    expect(run["status"]).toBe("completed");
    expect(run["result"]).toBe("done");
    const task = db.get_task(tid)!;
    expect(task["status"]).toBe("completed");
    expect(task["result"]).toBe("done");
    expect(task["run_count"]).toBe(1);
  });

  // ── output events ──────────────────────────────────────────────────────────
  test("test_output_events_per_task_and_per_run", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const run1 = db.add_run(tid);
    const run2 = db.add_run(tid);
    db.add_output_event(tid, run1, "assistant", "hello");
    db.add_output_event(tid, run1, "result", "done");
    db.add_output_event(tid, run2, "assistant", "second run");

    const all_events = db.get_output_events(tid);
    expect(all_events.length).toBe(3);

    // offset/limit paging (events ordered DESC by timestamp)
    const page = db.get_output_events(tid, 1, 0);
    expect(page.length).toBe(1);

    const run1_events = db.get_run_output_events(run1);
    expect(run1_events.map((e) => e["content"])).toEqual(["hello", "done"]); // ASC order
    const run2_events = db.get_run_output_events(run2);
    expect(run2_events.map((e) => e["content"])).toEqual(["second run"]);
  });

  // ── completed-run queries (skill sweep inputs) ─────────────────────────────
  test("test_get_completed_runs_since_watermark", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const old = db.add_run(tid);
    const newer = db.add_run(tid);
    finishWithTimestamp(old, "2020-01-01T00:00:00");
    finishWithTimestamp(newer, "2025-01-01T00:00:00");

    const after = db.get_completed_runs_since("2023-01-01T00:00:00");
    expect(after.map((r) => r["run_id"])).toEqual([newer]);
    // joined task metadata is present
    expect(after[0]!["title"]).toBe("t");
    expect(after[0]!["prompt"]).toBe("p");

    const everything = db.get_completed_runs_since("");
    expect(everything.map((r) => r["run_id"])).toEqual([old, newer]); // oldest first
  });

  test("test_get_recent_completed_runs_oldest_first_with_limit", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const r1 = db.add_run(tid);
    const r2 = db.add_run(tid);
    const r3 = db.add_run(tid);
    finishWithTimestamp(r1, "2024-01-01T00:00:00");
    finishWithTimestamp(r2, "2024-01-02T00:00:00");
    finishWithTimestamp(r3, "2024-01-03T00:00:00");

    const recent = db.get_recent_completed_runs(2);
    // picks the 2 newest, returns them oldest-first
    expect(recent.map((r) => r["run_id"])).toEqual([r2, r3]);
  });

  // ── skill_patterns ledger ──────────────────────────────────────────────────
  test("test_upsert_skill_pattern_blank_key_returns_none", () => {
    expect(db.upsert_skill_pattern("   ", "recipe", "s", 1)).toBeNull();
  });

  test("test_upsert_skill_pattern_idempotent_per_run", () => {
    const pid = db.upsert_skill_pattern("k", "recipe", "first", 1, 10)!;
    expect(db.get_skill_pattern_recurrence("k")).toBe(1);

    // same run_id again → no recurrence bump, but summary refreshes
    const same = db.upsert_skill_pattern("k", "recipe", "updated", 1, 10);
    expect(same).toBe(pid);
    expect(db.get_skill_pattern_recurrence("k")).toBe(1);
    expect(db.get_skill_pattern(pid)!["summary"]).toBe("updated");

    // new run_id → recurrence bumps and task list grows
    db.upsert_skill_pattern("k", "recipe", "", 2, 11);
    expect(db.get_skill_pattern_recurrence("k")).toBe(2);
    const pattern = db.get_skill_pattern(pid)!;
    expect([...JSON.parse(pattern["contributing_task_ids"])].sort()).toEqual([
      1, 2,
    ]);
    expect([...JSON.parse(pattern["contributing_run_ids"])].sort()).toEqual([
      10, 11,
    ]);
    // empty summary must NOT clobber the prior one
    expect(pattern["summary"]).toBe("updated");
  });

  test("test_upsert_skill_pattern_no_run_id_bumps_each_call", () => {
    db.upsert_skill_pattern("legacy", "recipe", "s", 1);
    db.upsert_skill_pattern("legacy", "recipe", "s", 1);
    expect(db.get_skill_pattern_recurrence("legacy")).toBe(2);
  });

  test("test_upsert_skill_pattern_invalid_kind_falls_back", () => {
    const pid = db.upsert_skill_pattern("k", "nonsense-kind", "s", 1)!;
    expect(db.get_skill_pattern(pid)!["kind"]).toBe("recipe");
  });

  test("test_get_skill_pattern_recurrence_unknown_is_zero", () => {
    expect(db.get_skill_pattern_recurrence("does-not-exist")).toBe(0);
    expect(db.get_skill_pattern_recurrence("")).toBe(0);
  });

  test("test_within_window", () => {
    const first = "2024-01-01T00:00:00";
    const inside = "2024-01-20T00:00:00";
    const outside = "2024-03-01T00:00:00";
    expect(TaskDB._within_window(first, inside, 30)).toBe(true);
    expect(TaskDB._within_window(first, outside, 30)).toBe(false);
    // unparseable timestamps don't block promotion
    expect(TaskDB._within_window("garbage", "garbage", 30)).toBe(true);
  });

  test("test_set_skill_pattern_status_with_promoted_id", () => {
    const pid = db.upsert_skill_pattern("k", "recipe", "s", 1)!;
    db.set_skill_pattern_status(pid, "promoted", 42);
    const row = db.get_skill_pattern(pid)!;
    expect(row["status"]).toBe("promoted");
    expect(row["promoted_skill_id"]).toBe(42);
  });

  // ── skill drafts ───────────────────────────────────────────────────────────
  test("test_skill_draft_upsert_conflict_and_delete", () => {
    const pid = db.upsert_skill_pattern("k", "recipe", "s", 1)!;
    db.upsert_skill_draft(pid, "drafting", "", "", "recipe");
    expect(db.get_skill_draft(pid)!["status"]).toBe("drafting");

    // ON CONFLICT(pattern_id) updates in place
    db.upsert_skill_draft(
      pid,
      "ready",
      "my-skill",
      "",
      "recipe",
      "b",
      null,
      true,
      "reusable",
    );
    const draft = db.get_skill_draft(pid)!;
    expect(draft["status"]).toBe("ready");
    expect(draft["name"]).toBe("my-skill");
    expect(draft["worthy"]).toBe(1);

    db.delete_skill_draft(pid);
    expect(db.get_skill_draft(pid)).toBeNull();
  });

  test("test_skill_draft_worthy_none_stored_as_null", () => {
    const pid = db.upsert_skill_pattern("k", "recipe", "s", 1)!;
    db.upsert_skill_draft(pid, "ready", "", "", "recipe", "", null, null);
    expect(db.get_skill_draft(pid)!["worthy"]).toBeNull();
  });

  // ── dependencies / DAG ─────────────────────────────────────────────────────
  test("test_dependency_crud_and_views", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = db.add_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
    );

    db.add_dependency(down, up, true);
    // duplicate insert is ignored
    db.add_dependency(down, up, true);

    const deps = db.get_dependencies(down);
    expect(deps.length).toBe(1);
    expect(deps[0]!["depends_on_task_id"]).toBe(up);
    expect(deps[0]!["depends_on_title"]).toBe("up");
    expect(deps[0]!["inject_result"]).toBe(1);

    const dependents = db.get_dependents(up);
    expect(dependents.length).toBe(1);
    expect(dependents[0]!["task_id"]).toBe(down);
    expect(dependents[0]!["task_title"]).toBe("down");

    db.remove_dependency(down, up);
    expect(db.get_dependencies(down)).toEqual([]);
  });

  test("test_add_dependencies_batch_and_clear", () => {
    const a = db.add_task(
      makeTask({ title: "a", prompt: "p", working_dir: "." }),
    );
    const b = db.add_task(
      makeTask({ title: "b", prompt: "p", working_dir: "." }),
    );
    const down = db.add_task(
      makeTask({ title: "d", prompt: "p", working_dir: "." }),
    );

    db.add_dependencies_batch(down, [
      { task_id: a, inject_result: true },
      { task_id: b, inject_result: false },
    ]);
    const deps = db.get_dependencies(down);
    expect(new Set(deps.map((d) => d["depends_on_task_id"]))).toEqual(
      new Set([a, b]),
    );

    db.clear_dependencies(down);
    expect(db.get_dependencies(down)).toEqual([]);
  });

  test("test_get_dag_tasks_filters_by_dag_id", () => {
    db.add_task(
      makeTask({ title: "x", prompt: "p", working_dir: ".", dag_id: "flow-1" }),
    );
    db.add_task(
      makeTask({ title: "y", prompt: "p", working_dir: ".", dag_id: "flow-1" }),
    );
    db.add_task(
      makeTask({ title: "z", prompt: "p", working_dir: ".", dag_id: "other" }),
    );

    const flow = db.get_dag_tasks("flow-1");
    expect(new Set(flow.map((t) => t["title"]))).toEqual(new Set(["x", "y"]));
  });

  // ── cascading delete ───────────────────────────────────────────────────────
  test("test_delete_task_removes_runs_events_and_deps", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    db.add_dependency(tid, up);
    const rid = db.add_run(tid);
    db.add_output_event(tid, rid, "assistant", "hi");

    db.delete_task(tid);

    expect(db.get_task(tid)).toBeNull();
    expect(db.get_task_runs(tid)).toEqual([]);
    expect(db.get_output_events(tid)).toEqual([]);
    // the dependency row referencing the deleted task is gone too
    expect(db.get_dependents(up)).toEqual([]);
  });

  // ── due-task selection ─────────────────────────────────────────────────────
  test("test_get_due_tasks_selects_only_ready", () => {
    const now = new Date();
    const past = dateToLocalIso(new Date(now.getTime() - 5 * 60 * 1000));
    const future = dateToLocalIso(new Date(now.getTime() + 60 * 60 * 1000));

    const immediate = db.add_task(
      makeTask({ title: "now", prompt: "p", working_dir: "." }),
    );
    const due_scheduled = db.add_task(
      makeTask({
        title: "due",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.SCHEDULED_AT,
        next_run_at: past,
      }),
    );
    db.update_task(due_scheduled, { status: "scheduled" });
    const not_yet = db.add_task(
      makeTask({
        title: "later",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.SCHEDULED_AT,
        next_run_at: future,
      }),
    );
    db.update_task(not_yet, { status: "scheduled" });
    const running = db.add_task(
      makeTask({ title: "running", prompt: "p", working_dir: "." }),
    );
    db.update_task(running, { status: "running" });

    const due_ids = new Set(db.get_due_tasks().map((t) => t["id"]));
    expect(due_ids.has(immediate)).toBe(true); // pending + no next_run_at
    expect(due_ids.has(due_scheduled)).toBe(true); // scheduled in the past
    expect(due_ids.has(not_yet)).toBe(false); // future
    expect(due_ids.has(running)).toBe(false); // not pending/scheduled
  });
});
