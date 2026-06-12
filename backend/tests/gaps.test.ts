// Final mop-up coverage for still-reachable scheduler/skills branches.
//
// Ported from tests/test_taskboard_gaps.py; test() descriptions keep the
// Python test function names.
//
// SKIPPED (exercise the HTTP API / run_server lifecycle — owned by the API
// handler test suite, not ported here):
//   - test_run_server_starts_all_channels_via_settings
//   - test_run_server_auto_enables_telegram_and_slack_via_env
//   - test_run_server_telegram_factory_returns_none_no_start

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import {
  FileNotFoundError,
  OSError,
  TimeoutExpired,
  type PopenLike,
} from "../src/executor.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import { ScheduleType, makeTask } from "../src/types.ts";

type Row = Record<string, any>;

// ── _run_agent_command: subprocess branches (Popen mocked) ───────────────────
class _FakePopen implements PopenLike {
  pid = 9999;
  returncode: number;
  stdout: string[];
  stderr: string[];
  _wait_raises: Error | null;
  killed = false;

  constructor(
    returncode = 0,
    stdout_lines: string[] | null = null,
    stderr_lines: string[] | null = null,
    wait_raises: Error | null = null,
  ) {
    this.returncode = returncode;
    this.stdout = stdout_lines ?? [];
    this.stderr = stderr_lines ?? [];
    this._wait_raises = wait_raises;
  }

  wait(_timeout: number | null = null): number {
    if (this._wait_raises !== null) {
      throw this._wait_raises;
    }
    return this.returncode;
  }

  kill(): void {
    this.killed = true;
  }
}

describe("taskboard gaps", () => {
  let tmpDir: string;
  let db: TaskDB;
  let sched: TaskScheduler;
  let savedHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    savedHome = process.env.HOME;
    db = new TaskDB(path.join(tmpDir, "t.db"));
    sched = new TaskScheduler(db);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function _make_pattern(key = "pk"): number {
    db.upsert_skill_pattern(key, "recipe", "summary", 1);
    const row = db.conn
      .query("SELECT id FROM skill_patterns WHERE pattern_key=?")
      .get(key) as Row;
    return Number(row["id"]);
  }

  test("test_run_agent_command_filenotfound", async () => {
    sched._popen = () => {
      throw new FileNotFoundError();
    };
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(false);
    expect(out).toContain("not found");
  });

  test("test_run_agent_command_oserror", async () => {
    sched._popen = () => {
      throw new OSError("boom");
    };
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(false);
    expect(out).toContain("boom");
  });

  test("test_run_agent_command_timeout_kills_proc", async () => {
    const proc = new _FakePopen(
      0,
      null,
      null,
      new TimeoutExpired(["claude"], 1),
    );
    sched._popen = () => proc;
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(false);
    expect(out).toContain("timed out");
    expect(proc.killed).toBe(true);
  });

  test("test_run_agent_command_nonzero_returns_stderr", async () => {
    const proc = new _FakePopen(2, [], ["the error\n"]);
    sched._popen = () => proc;
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(false);
    expect(out).toContain("the error");
  });

  test("test_run_agent_command_codex_parses_agent_message", async () => {
    const lines = [
      "\n", // blank → skipped
      "not json\n", // parse error → skipped
      JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\n",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "CODEX FINAL" },
      }) + "\n",
    ];
    const proc = new _FakePopen(0, lines);
    sched._popen = () => proc;
    const [ok, out] = await sched._run_agent_command("codex", ["codex"], ".");
    expect(ok).toBe(true);
    expect(out).toBe("CODEX FINAL");
  });

  test("test_run_agent_command_claude_parses_result_and_assistant", async () => {
    const lines = [
      "\n", // blank → skipped
      "garbage\n", // parse error → skipped
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "thinking" }, "raw-str"] },
      }) + "\n",
      JSON.stringify({ type: "result", result: "CLAUDE RESULT" }) + "\n",
    ];
    const proc = new _FakePopen(0, lines);
    sched._popen = () => proc;
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(true);
    expect(out).toBe("CLAUDE RESULT");
  });

  test("test_run_agent_command_claude_falls_back_to_assistant_text", async () => {
    // No result event → falls back to the last assistant text.
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ONLY TEXT" }] },
      }) + "\n",
    ];
    const proc = new _FakePopen(0, lines);
    sched._popen = () => proc;
    const [ok, out] = await sched._run_agent_command("claude", ["claude"], ".");
    expect(ok).toBe(true);
    expect(out).toBe("ONLY TEXT");
  });

  // ── skill draft worker error path + approve_skill guards ─────────────────
  test("test_trigger_skill_draft_worker_records_error", async () => {
    const pid = _make_pattern();

    (sched as any).distill_skill_draft = async () => {
      throw new Error("distill kaboom");
    };
    expect(sched.trigger_skill_draft(pid)).toBe(true);

    // Poll until the background worker persists the error to the draft row.
    for (let i = 0; i < 50; i++) {
      const draft = db.get_skill_draft(pid);
      if (draft && draft["status"] === "error") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const draft = db.get_skill_draft(pid)!;
    expect(draft["status"]).toBe("error");
    expect(draft["error"] || "").toContain("distill kaboom");
  });

  test("test_trigger_skill_draft_unknown_pattern_returns_false", () => {
    expect(sched.trigger_skill_draft(99999)).toBe(false);
  });

  test("test_approve_skill_invalid_name_raises", () => {
    process.env.HOME = tmpDir;
    const pid = _make_pattern("!!!"); // sanitizes to empty
    // Body with frontmatter whose name also sanitizes to empty.
    const body = "---\nname: !!!\n---\nbody";
    expect(() => sched.approve_skill(pid, "!!!", "d", body)).toThrow(
      /invalid skill name/,
    );
  });

  test("test_approve_skill_empty_body_raises", () => {
    const pid = _make_pattern();
    expect(() => sched.approve_skill(pid, "ok", "d", "   ")).toThrow(
      /skill body is empty/,
    );
  });

  // ── output listeners: error swallow + remove edge ────────────────────────
  test("test_fire_output_listeners_swallows_callback_error", () => {
    const calls: Array<[number, string]> = [];

    const bad = () => {
      throw new Error("listener boom");
    };
    const good = (
      task_id: number,
      _run_id: number,
      _event_type: string,
      content: string,
    ) => {
      calls.push([task_id, content]);
    };

    sched.add_output_listener(bad);
    sched.add_output_listener(good);
    // Must not raise even though `bad` throws; `good` still runs.
    sched._fire_output_listeners(1, 2, "assistant", "hello");
    expect(calls).toEqual([[1, "hello"]]);
  });

  test("test_remove_output_listener_unregistered_is_noop", () => {
    // Removing a callback that was never added hits the not-found branch.
    sched.remove_output_listener(() => {}); // must not raise
  });

  // ── DAG hooks: edge branches ─────────────────────────────────────────────
  test("test_on_task_completed_skips_when_downstream_deleted", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [up],
    );
    expect(db.get_task(down)!["status"]).toBe("blocked");

    db.update_task(up, { status: "completed" });
    // get_task(downstream) returns null → the `continue` branch is taken.
    const real_get_task = db.get_task.bind(db);

    (db as any).get_task = (task_id: number) =>
      task_id === down ? null : real_get_task(task_id);
    sched._on_task_completed(up);
    (db as any).get_task = real_get_task;
    // Downstream never updated because it "vanished" mid-hook.
    expect(db.get_task(down)!["status"]).toBe("blocked");
  });

  test("test_on_task_completed_unknown_schedule_type_defaults_pending", () => {
    const up = db.add_task(
      makeTask({ title: "up", prompt: "p", working_dir: "." }),
    );
    const down = sched.submit_task(
      makeTask({ title: "down", prompt: "p", working_dir: "." }),
      [up],
    );
    // Force an unrecognized schedule_type so the else-branch (pending) runs.
    db.conn
      .query("UPDATE tasks SET schedule_type='weird' WHERE id=?")
      .run(down);
    db.update_task(up, { status: "completed" });
    sched._on_task_completed(up);
    expect(db.get_task(down)!["status"]).toBe("pending");
  });

  test("test_on_task_failed_diamond_visits_shared_downstream_once", () => {
    // root → a, root → b, both a & b → leaf. The `already visited` continue
    // branch fires for leaf the second time it's reached.
    const root = db.add_task(
      makeTask({ title: "root", prompt: "p", working_dir: "." }),
    );
    const a = db.add_task(
      makeTask({ title: "a", prompt: "p", working_dir: "." }),
    );
    const b = db.add_task(
      makeTask({ title: "b", prompt: "p", working_dir: "." }),
    );
    const leaf = db.add_task(
      makeTask({ title: "leaf", prompt: "p", working_dir: "." }),
    );
    db.add_dependency(a, root);
    db.add_dependency(b, root);
    db.add_dependency(leaf, a);
    db.add_dependency(leaf, b);
    for (const t of [a, b, leaf]) {
      db.update_task(t, { status: "blocked" });
    }
    sched._on_task_failed(root);
    expect(db.get_task(a)!["status"]).toBe("cancelled");
    expect(db.get_task(b)!["status"]).toBe("cancelled");
    expect(db.get_task(leaf)!["status"]).toBe("cancelled");
  });

  // ── _schedule_delayed transitions pending → scheduled with next_run_at ───
  test("test_schedule_delayed_sets_scheduled_and_next_run", () => {
    const tid = db.add_task(
      makeTask({
        title: "t",
        prompt: "p",
        working_dir: ".",
        schedule_type: ScheduleType.DELAYED,
        delay_seconds: 30,
      }),
    );
    sched._schedule_delayed(db.get_task(tid)!);
    const row = db.get_task(tid)!;
    expect(row["status"]).toBe("scheduled");
    expect(row["next_run_at"]).not.toBeNull();
  });
});
