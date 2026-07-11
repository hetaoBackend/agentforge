// Hermetic tests for the agent subprocess execution + stream-parsing paths.
//
// Ported from tests/test_execute_task.py; test() descriptions keep the Python
// test function names.
//
// Strategy: swap the injectable seams (`TaskScheduler._popen` ≙ subprocess.Popen,
// `TaskScheduler._os` ≙ os.getpgid/killpg, `AgentExecutor.subprocess_run` ≙
// subprocess.run) with finite fakes so the read loops always terminate. A real
// TaskDB on a tmp-dir SQLite file lets us assert the persisted run status and
// the parsed output events afterwards.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import {
  AgentExecutor,
  FileNotFoundError,
  PIPE,
  ProcessLookupError,
  default_subprocess_run,
  type PopenLike,
  type SubprocessRunOptions,
} from "../src/executor.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import { ScheduleType, makeTask } from "../src/types.ts";

type Row = Record<string, any>;

// ── Fakes ────────────────────────────────────────────────────────────────────
class _FakeStdin {
  buffer = "";
  closed = false;
  write(data: string): void {
    this.buffer += data;
  }
  close(): void {
    this.closed = true;
  }
}

/**
 * Minimal stand-in for the Popen object used by the scheduler.
 * `_execute_task` (and `_run_agent_command`) iterate `proc.stdout` /
 * `proc.stderr` directly and call `.wait()`. The stdout/stderr iterables
 * are finite so the read loop never hangs.
 */
class FakePopen implements PopenLike {
  static _next_pid = 4242;
  pid: number;
  stdout: Iterable<string> | AsyncIterable<string>;
  stderr: Iterable<string> | AsyncIterable<string>;
  stdin: _FakeStdin;
  returncode: number;
  _killed = false;

  constructor(
    stdout_lines: Iterable<string> | AsyncIterable<string>,
    stderr_lines: string[] | null = null,
    returncode = 0,
  ) {
    FakePopen._next_pid += 1;
    this.pid = FakePopen._next_pid;
    this.stdout = stdout_lines;
    this.stderr = stderr_lines ?? [];
    this.returncode = returncode;
    this.stdin = new _FakeStdin();
  }

  wait(_timeout: number | null = null): number {
    return this.returncode;
  }

  kill(): void {
    this._killed = true;
  }
}

/**
 * Make the process-group bookkeeping in `_execute_task` inert (≙ the autouse
 * `_stub_process_group` pytest fixture): `killpg(_, 0)` immediately raises
 * ProcessLookupError so the sub-agent wait loop exits at once.
 */
function stubProcessGroup(sched: TaskScheduler): void {
  sched._os = {
    getpgid: (pid: number) => pid,
    killpg: () => {
      // sig == 0 is the "is the group alive?" probe → report it's gone.
      throw new ProcessLookupError();
    },
    kill: () => {
      throw new ProcessLookupError();
    },
  };
}

// ── Stream fixtures (realistic stream-json lines for both agents) ────────────
function _claude_lines(
  result_text = "All done.",
  session_id = "sess-abc",
): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id }) + "\n",
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Working on it. " }],
      },
    }) + "\n",
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    }) + "\n",
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file.txt" }],
            is_error: false,
          },
        ],
      },
    }) + "\n",
    "   \n", // blank line — tolerated
    "this is not json at all and is longer than ten chars\n", // raw-text branch
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: result_text,
      session_id,
    }) + "\n",
  ];
}

function _codex_lines(
  thread_id = "thread-xyz",
  final_text = "Codex finished.",
): string[] {
  return [
    JSON.stringify({ type: "thread.started", thread_id }) + "\n",
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd_1",
        type: "command_execution",
        command: "pytest -q",
        aggregated_output: "1 passed",
        exit_code: 0,
        status: "completed",
      },
    }) + "\n",
    JSON.stringify({
      type: "item.completed",
      item: { id: "msg_1", type: "agent_message", text: final_text },
    }) + "\n",
    JSON.stringify({ type: "turn.completed", usage: { output_tokens: 5 } }) +
      "\n",
  ];
}

describe("execute task", () => {
  let tmpDir: string;
  let db: TaskDB;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    db = new TaskDB(path.join(tmpDir, "t.db"));
    scheduler = new TaskScheduler(db); // NOTE: never .start() — keep it hermetic
    stubProcessGroup(scheduler);
  });

  afterEach(() => {
    AgentExecutor.subprocess_run = default_subprocess_run;
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── AgentExecutor.run: command-line construction + flags ─────────────────
  test("test_agent_executor_run_builds_claude_command_with_permission_flags", () => {
    const captured: Row = {};
    AgentExecutor.subprocess_run = (
      cmd: string[],
      opts: SubprocessRunOptions,
    ) => {
      captured["cmd"] = cmd;
      captured["kwargs"] = opts;
      return {
        returncode: 0,
        stdout: JSON.stringify({ type: "result", result: "hi" }) + "\n",
        stderr: "",
      };
    };

    const [ok, output] = AgentExecutor.run("do a thing", ".", 30);

    expect(ok).toBe(true);
    expect(output).toBe("hi"); // result event text extracted, not raw stdout
    const cmd: string[] = captured["cmd"];
    expect(cmd.slice(0, 3)).toEqual(["claude", "-p", "do a thing"]);
    // stream-json + bypassPermissions flags appended
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("stream-json");
    expect(cmd).toContain("--permission-mode");
    expect(cmd[cmd.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(captured["kwargs"].timeout).toBe(30);
  });

  test("test_agent_executor_run_includes_image_flags", () => {
    let cmd: string[] = [];
    AgentExecutor.subprocess_run = (c: string[]) => {
      cmd = c;
      return { returncode: 0, stdout: "", stderr: "" };
    };
    AgentExecutor.run("p", ".", undefined as unknown as number, [
      "/tmp/a.png",
      "/tmp/b.jpg",
    ]);
    // each image passed via -i
    expect(cmd.filter((a) => a === "-i").length).toBe(2);
    expect(cmd).toContain("/tmp/a.png");
    expect(cmd).toContain("/tmp/b.jpg");
  });

  test("test_agent_executor_run_nonzero_returns_stderr", () => {
    AgentExecutor.subprocess_run = () => ({
      returncode: 1,
      stdout: "",
      stderr: "boom from cli",
    });
    const [ok, output] = AgentExecutor.run("p");
    expect(ok).toBe(false);
    expect(output).toBe("boom from cli");
  });

  test("test_agent_executor_run_handles_missing_cli", () => {
    AgentExecutor.subprocess_run = () => {
      throw new FileNotFoundError();
    };
    const [ok, output] = AgentExecutor.run("p");
    expect(ok).toBe(false);
    expect(output).toContain("not found");
  });

  // ── _execute_task: claude success path ───────────────────────────────────
  test("test_execute_task_claude_success_persists_completed_and_events", async () => {
    const tid = db.add_task(
      makeTask({
        title: "claude task",
        prompt: "hello",
        working_dir: ".",
        agent: "claude",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true }); // _execute_task pops this at the end

    const fake = new FakePopen(_claude_lines("All done.", "sess-abc"));
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("completed");
    expect(refreshed["result"]).toBe("All done.");
    expect(refreshed["run_count"]).toBe(1);
    // session_id extracted from the trailing result event
    expect(refreshed["session_id"]).toBe("sess-abc");

    const runs = db.get_task_runs(tid);
    expect(runs.length).toBe(1);
    expect(runs[0]!["status"]).toBe("completed");
    expect(runs[0]!["raw_output"]).toBeTruthy(); // raw stdout stored

    const events = db.get_output_events(tid);
    const types = new Set(events.map((e) => e["event_type"]));
    // assistant text, a tool_call, a tool_result, the result event, and the raw
    // non-JSON line all persisted.
    expect(types.has("assistant")).toBe(true);
    expect(types.has("tool_call")).toBe(true);
    expect(types.has("tool_result")).toBe(true);
    expect(types.has("result")).toBe(true);
    expect(types.has("text")).toBe(true); // the malformed/non-JSON line
  });

  // ── _execute_task: codex success path ────────────────────────────────────
  test("test_execute_task_codex_success_persists_completed_and_events", async () => {
    const tid = db.add_task(
      makeTask({
        title: "codex task",
        prompt: "hello",
        working_dir: ".",
        agent: "codex",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    // No generated images for this run.
    (scheduler as any)._find_codex_generated_images = () => [];

    const fake = new FakePopen(_codex_lines("thread-xyz", "Codex finished."));
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("completed");
    expect(refreshed["result"]).toBe("Codex finished.");
    // thread.started thread_id captured as session_id
    expect(refreshed["session_id"]).toBe("thread-xyz");

    const events = db.get_output_events(tid);
    const types = new Set(events.map((e) => e["event_type"]));
    expect(types.has("command_execution")).toBe(true);
    // codex agent_message text stored as assistant output
    expect(types.has("assistant")).toBe(true);
  });

  test("test_execute_task_codex_does_not_wait_for_notify_process_group", async () => {
    // Codex can leave notify hook processes alive after `codex exec` exits.
    // The task should complete once the Codex process exits successfully;
    // only Claude needs the post-exit process-group wait for background Task agents.
    const tid = db.add_task(
      makeTask({
        title: "codex notify",
        prompt: "hello",
        working_dir: ".",
        agent: "codex",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });
    (scheduler as any)._find_codex_generated_images = () => [];

    let group_probed = false;
    scheduler._os = {
      getpgid: (pid: number) => pid,
      killpg: (_pgid: number, sig: number | NodeJS.Signals) => {
        if (sig === 0) {
          group_probed = true;
        }
        throw new ProcessLookupError();
      },
      kill: () => {
        throw new ProcessLookupError();
      },
    };

    const fake = new FakePopen(_codex_lines("thread-notify", "done"));
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    expect(group_probed).toBe(false);
    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("completed");
    expect(refreshed["result"]).toBe("done");
  });

  test("test_execute_task_codex_builds_resume_command_when_session_present", async () => {
    const tid = db.add_task(
      makeTask({
        title: "codex resume",
        prompt: "again",
        working_dir: ".",
        agent: "codex",
      }),
    );
    db.update_task(tid, { session_id: "prev-thread" });
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });
    (scheduler as any)._find_codex_generated_images = () => [];

    const captured: Row = {};
    scheduler._popen = (cmd: string[]) => {
      captured["cmd"] = cmd;
      return new FakePopen(_codex_lines("prev-thread", "ok"));
    };
    await scheduler._execute_task(task);

    const cmd: string[] = captured["cmd"];
    expect(cmd.slice(0, 4)).toEqual(["codex", "exec", "resume", "--json"]);
    expect(cmd).toContain("prev-thread");
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  // ── _execute_task: failure path (non-zero exit) ──────────────────────────
  test("test_execute_task_failure_sets_failed_with_error_summary", async () => {
    const tid = db.add_task(
      makeTask({
        title: "boom",
        prompt: "fail please",
        working_dir: ".",
        agent: "claude",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    const fake = new FakePopen([], ["fatal: something exploded\n"], 1);
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    expect(refreshed["error"] || "").toContain("exploded");

    const runs = db.get_task_runs(tid);
    expect(runs[0]!["status"]).toBe("failed");
  });

  // ── _execute_task: failure still persists session_id (resumable retry) ───
  test("test_execute_task_codex_failure_still_persists_session_id", async () => {
    // A codex run that emits ``thread.started`` then fails must still persist
    // the ``thread_id`` as ``session_id``. Otherwise a failed task cannot be
    // resumed (e.g. replying in the Feishu thread to retry) → "no saved session".
    const tid = db.add_task(
      makeTask({
        title: "codex boom",
        prompt: "x",
        working_dir: ".",
        agent: "codex",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });
    (scheduler as any)._find_codex_generated_images = () => [];

    const stdout_lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-fail-1" }) +
        "\n",
    ];
    const fake = new FakePopen(
      stdout_lines,
      ["codex error: model overloaded\n"],
      1,
    );
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    // The conversation id is preserved despite the failure → resumable.
    expect(refreshed["session_id"]).toBe("thread-fail-1");
  });

  test("test_execute_task_claude_failure_still_persists_session_id", async () => {
    // A claude run whose trailing ``result`` event carries a ``session_id``
    // (e.g. ``error_during_execution``) must persist it on failure too.
    const tid = db.add_task(
      makeTask({
        title: "claude boom",
        prompt: "x",
        working_dir: ".",
        agent: "claude",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    const stdout_lines = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "sess-fail-9",
      }) + "\n",
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        session_id: "sess-fail-9",
      }) + "\n",
    ];
    const fake = new FakePopen(stdout_lines, ["boom\n"], 1);
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    expect(refreshed["session_id"]).toBe("sess-fail-9");
  });

  // ── _execute_task: missing CLI binary ────────────────────────────────────
  test("test_execute_task_missing_binary_fails_with_install_hint", async () => {
    const tid = db.add_task(
      makeTask({
        title: "no cli",
        prompt: "x",
        working_dir: ".",
        agent: "codex",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    scheduler._popen = () => {
      throw new FileNotFoundError();
    };
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    expect(refreshed["error"] || "").toContain("codex");
    expect(refreshed["error"] || "").toContain("not found");
  });

  // ── _execute_task: cron reschedule on success ────────────────────────────
  test("test_execute_task_cron_success_reschedules_instead_of_completing", async () => {
    const tid = db.add_task(
      makeTask({
        title: "cron task",
        prompt: "tick",
        working_dir: ".",
        agent: "claude",
        schedule_type: ScheduleType.CRON,
        cron_expr: "*/5 * * * *",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    const fake = new FakePopen(_claude_lines("tick done"));
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    // cron task with remaining runs reschedules rather than completing
    expect(refreshed["status"]).toBe("scheduled");
    expect(refreshed["next_run_at"]).toBeTruthy();
    expect(refreshed["run_count"]).toBe(1);
  });

  // ── _execute_task: image path handling (safe load + unsafe reject) ───────
  test("test_execute_task_claude_loads_safe_image_and_streams_via_stdin", async () => {
    // A real PNG under /tmp is a safe path → base64-loaded → claude switches to
    // the stdin ``--input-format stream-json`` multimodal command; an unsafe path
    // outside the allowed roots is rejected and never loaded.
    //
    // /tmp is one of the hard-coded allowed roots (realpaths cleanly on mac/linux).
    const fd_dir = fs.mkdtempSync("/tmp/agentforge-img-");
    const img = path.join(fd_dir, "pic.png");
    fs.writeFileSync(
      img,
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from("PNG\r\n"),
        Buffer.from([0x1a, 0x0a]),
        Buffer.from("fakepng"),
      ]),
    );

    const tid = db.add_task(
      makeTask({
        title: "img task",
        prompt: "see image",
        working_dir: ".",
        agent: "claude",
        image_paths: [img, "/etc/shadow"], // one safe, one rejected
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    const captured: Row = {};
    scheduler._popen = (cmd: string[], kwargs) => {
      captured["cmd"] = cmd;
      captured["stdin"] = kwargs.stdin;
      return new FakePopen(_claude_lines("saw it"));
    };
    await scheduler._execute_task(task);
    fs.rmSync(fd_dir, { recursive: true, force: true });

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("completed");
    // Safe image loaded → multimodal stdin path selected.
    const cmd: string[] = captured["cmd"];
    expect(cmd).toContain("--input-format");
    expect(cmd[cmd.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(captured["stdin"]).toBe(PIPE);
  });

  test("test_execute_task_codex_passes_image_flag", async () => {
    const fd_dir = fs.mkdtempSync("/tmp/agentforge-img-");
    const img = path.join(fd_dir, "shot.png");
    fs.writeFileSync(
      img,
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from("PNG\r\n"),
        Buffer.from([0x1a, 0x0a]),
        Buffer.from("fakepng"),
      ]),
    );

    const tid = db.add_task(
      makeTask({
        title: "codex img",
        prompt: "render",
        working_dir: ".",
        agent: "codex",
        image_paths: [img, "/etc/shadow"],
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });
    (scheduler as any)._find_codex_generated_images = () => [];

    const captured: Row = {};
    scheduler._popen = (cmd: string[]) => {
      captured["cmd"] = cmd;
      return new FakePopen(_codex_lines("thread-xyz", "rendered"));
    };
    await scheduler._execute_task(task);
    fs.rmSync(fd_dir, { recursive: true, force: true });

    const cmd: string[] = captured["cmd"];
    expect(cmd).toContain("--image");
    expect(cmd[cmd.indexOf("--image") + 1]).toBe(img);
    expect(cmd).not.toContain("/etc/shadow");
    expect(cmd.filter((arg) => arg === "--image")).toHaveLength(1);
  });

  test("test_execute_task_claude_resume_appends_session_flag", async () => {
    const tid = db.add_task(
      makeTask({
        title: "resume",
        prompt: "continue",
        working_dir: ".",
        agent: "claude",
      }),
    );
    db.update_task(tid, { session_id: "claude-sess-1" });
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    const captured: Row = {};
    scheduler._popen = (cmd: string[]) => {
      captured["cmd"] = cmd;
      return new FakePopen(_claude_lines("resumed", "claude-sess-1"));
    };
    await scheduler._execute_task(task);

    const cmd: string[] = captured["cmd"];
    expect(cmd).toContain("--resume");
    expect(cmd[cmd.indexOf("--resume") + 1]).toBe("claude-sess-1");
  });

  // ── _execute_task: timeout / kill path ───────────────────────────────────
  test("test_execute_task_timeout_kills_group_and_marks_failed", async () => {
    // A short configured timeout fires the kill timer while stdout is still
    // streaming, exercising ``_kill`` (killpg → kill fallback) and the
    // ``timed_out`` failure branch.
    db.set_setting("timeout", "0"); // setTimeout(_kill, 0) fires immediately
    const tid = db.add_task(
      makeTask({
        title: "slow",
        prompt: "hang",
        working_dir: ".",
        agent: "claude",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });

    async function* slow_lines(): AsyncGenerator<string> {
      // Give the timer (delay 0) a moment to fire mid-stream.
      await new Promise((r) => setTimeout(r, 200));
      yield JSON.stringify({ type: "system", subtype: "init" }) + "\n";
    }

    const fake = new FakePopen(slow_lines());
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    // The run record preserves the raw "Task timed out after Ns" message.
    const runs = db.get_task_runs(tid);
    expect(runs[0]!["status"]).toBe("failed");
    expect(runs[0]!["error"] || "").toContain("timed out");
  });

  test("test_execute_task_timeout_error_summary_states_timeout_not_stderr", async () => {
    // On timeout the human-readable ``task.error`` must say it timed out, not
    // surface an unrelated stderr line. Regression: codex prints "Reading
    // additional input from stdin…" to stderr, which ``_extract_error_summary``
    // picked over the real "Task timed out after Ns" reason.
    db.set_setting("timeout", "0"); // kill timer (delay 0) fires immediately
    const tid = db.add_task(
      makeTask({
        title: "slow review",
        prompt: "hang",
        working_dir: ".",
        agent: "codex",
      }),
    );
    const task = db.get_task(tid)!;
    scheduler._active_tasks.set(tid, { is_alive: () => true });
    (scheduler as any)._find_codex_generated_images = () => [];

    async function* slow_lines(): AsyncGenerator<string> {
      await new Promise((r) => setTimeout(r, 200)); // let the delay-0 timer fire mid-stream
      yield JSON.stringify({ type: "thread.started", thread_id: "t-1" }) + "\n";
    }

    const fake = new FakePopen(
      slow_lines(),
      ["Reading additional input from stdin...\n"],
      0,
    );
    scheduler._popen = () => fake;
    await scheduler._execute_task(task);

    const refreshed = db.get_task(tid)!;
    expect(refreshed["status"]).toBe("failed");
    // error summary states the timeout, not the stderr noise
    expect(refreshed["error"] || "").toContain("timed out");
    expect(refreshed["error"] || "").not.toContain("stdin");
  });

  // ── _run_agent_command: heartbeat/skill-sweep invocation ─────────────────
  test("test_run_agent_command_claude_returns_result_text", async () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m1",
          content: [{ type: "text", text: "intermediate" }],
        },
      }) + "\n",
      JSON.stringify({ type: "result", result: "FINAL DECISION" }) + "\n",
    ];
    const fake = new FakePopen(lines, null, 0);
    const seen: string[] = [];
    scheduler._popen = () => fake;
    const [ok, out] = await scheduler._run_agent_command(
      "claude",
      ["claude", "-p", "decide"],
      ".",
      (line) => seen.push(line),
    );
    expect(ok).toBe(true);
    expect(out).toBe("FINAL DECISION");
    expect(seen.some((s) => s.includes("FINAL DECISION"))).toBe(true);
    // db unused here but keep reference to satisfy fixture wiring
    expect(db).not.toBeNull();
  });

  test("test_run_agent_command_codex_returns_last_agent_message", async () => {
    const fake = new FakePopen(
      _codex_lines("thread-xyz", "codex decision"),
      null,
      0,
    );
    scheduler._popen = () => fake;
    const [ok, out] = await scheduler._run_agent_command(
      "codex",
      ["codex", "exec"],
      ".",
    );
    expect(ok).toBe(true);
    expect(out).toBe("codex decision");
  });

  test("test_run_agent_command_nonzero_returns_stderr", async () => {
    const fake = new FakePopen([], ["heartbeat blew up\n"], 2);
    scheduler._popen = () => fake;
    const [ok, out] = await scheduler._run_agent_command(
      "claude",
      ["claude", "-p", "x"],
      ".",
    );
    expect(ok).toBe(false);
    expect(out).toContain("blew up");
  });

  test("test_run_agent_command_missing_binary", async () => {
    scheduler._popen = () => {
      throw new FileNotFoundError();
    };
    const [ok, out] = await scheduler._run_agent_command(
      "claude",
      ["claude"],
      ".",
    );
    expect(ok).toBe(false);
    expect(out).toContain("not found");
  });

  // ── _extract_error_summary: branches ─────────────────────────────────────
  test("test_extract_error_summary_prefers_short_plain_stderr", () => {
    const summary = scheduler._extract_error_summary("permission denied", "");
    expect(summary).toBe("permission denied");
  });

  test("test_extract_error_summary_parses_stream_json_error_event", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "error", error: "rate limited" }),
    ].join("\n");
    const summary = scheduler._extract_error_summary("", stdout);
    expect(summary).toBe("rate limited");
  });

  test("test_extract_error_summary_falls_back_to_last_assistant_text", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "I could not finish." }] },
    });
    const summary = scheduler._extract_error_summary("", stdout);
    expect(summary).toBe("I could not finish.");
  });
});
