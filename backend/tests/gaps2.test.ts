// Second mop-up coverage pass for still-reachable scheduler branches.
//
// Ported from tests/test_taskboard_gaps2.py; test() descriptions keep the
// Python test function names.
//
// Targets the Codex/Claude streaming delta + event-normalization helpers
// (_codex_text_delta, _codex_append_text_delta, _codex_event_delta_text,
//  _extract_codex_thread_id, _find_codex_generated_images, _image_media_type,
//  _extract_codex_success_output, _store_generated_image_events,
//  _claude_text_delta, _claude_message_id, _content_to_display_text,
//  _parse_codex_event variants, _store_output_event empty-skip) and the
// _execute_task EDGE branches (magic-byte media sniffing, unsafe-path
// rejection, the sub-agent wait loop, the notify fan-out).
//
// SKIPPED (exercise the HTTP API handler — owned by the API handler test
// suite, not ported here):
//   - test_feishu_settings_restart_stops_old_and_starts_new
//   - test_channels_settings_restart_all_three
//   - test_telegram_restart_factory_returns_none
//   - test_create_dag_prompt_images_json_string
//   - test_create_dag_prompt_images_bad_json_falls_back
//   - test_task_resume_not_found
//   - test_delete_csrf_rejected
//   - test_delete_csrf_accepted_with_token
//   - test_post_body_too_large_returns_413
//   - test_read_body_too_large_drains_declared_body

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskDB } from "../src/db.ts";
import { ProcessLookupError, type PopenLike } from "../src/executor.ts";
import { TaskScheduler } from "../src/scheduler.ts";
import { makeTask } from "../src/types.ts";

type Row = Record<string, any>;

// ── shared FakePopen for _execute_task drives ───────────────────────────────
class _FakeStdin {
  buffer = "";
  write(data: string): void {
    this.buffer += data;
  }
  close(): void {}
}

class FakePopen implements PopenLike {
  static _next_pid = 9000;
  pid: number;
  stdout: Iterable<string> | AsyncIterable<string>;
  stderr: Iterable<string> | AsyncIterable<string>;
  stdin: _FakeStdin;
  returncode: number;

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

  kill(): void {}
}

/** ≙ the `_stub_process_group` pytest fixture. */
function stubProcessGroup(sched: TaskScheduler): void {
  sched._os = {
    getpgid: (pid: number) => pid,
    killpg: () => {
      throw new ProcessLookupError();
    },
    kill: () => {
      throw new ProcessLookupError();
    },
  };
}

function _claude_lines(result_text = "done", session_id = "s1"): string[] {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id }) + "\n",
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: result_text,
      session_id,
    }) + "\n",
  ];
}

/** ≙ the Python dict key tuple (run_id, item_id) used by the delta-state maps. */
function tupleKey(run_id: number | null, item_id: string): string {
  return JSON.stringify([run_id, item_id]);
}

describe("taskboard gaps2", () => {
  let tmpDir: string;
  let db: TaskDB;
  let sched: TaskScheduler;
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    savedHome = process.env.HOME;
    savedCodexHome = process.env.CODEX_HOME;
    db = new TaskDB(path.join(tmpDir, "t.db"));
    sched = new TaskScheduler(db);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    db.conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Codex streaming delta helpers ───────────────────────────────────────
  test("test_codex_text_delta_cumulative_and_reset", () => {
    // First emission returns the whole text (no previous).
    expect(sched._codex_text_delta(1, "item", "Hello")).toBe("Hello");
    // Cumulative continuation returns only the new suffix.
    expect(sched._codex_text_delta(1, "item", "Hello World")).toBe(" World");
    // Identical text → no new delta.
    expect(sched._codex_text_delta(1, "item", "Hello World")).toBeNull();
    // Empty current text → null.
    expect(sched._codex_text_delta(1, "item2", "")).toBeNull();
    // Non-prefix (a full rewrite) returns the new text as-is.
    expect(sched._codex_text_delta(1, "item", "Totally different")).toBe(
      "Totally different",
    );
  });

  test("test_codex_append_text_delta_accumulates", () => {
    expect(sched._codex_append_text_delta(2, "a", "")).toBeNull();
    expect(sched._codex_append_text_delta(2, "a", "foo")).toBe("foo");
    expect(sched._codex_append_text_delta(2, "a", "bar")).toBe("bar");
    expect(sched._codex_item_text.get(tupleKey(2, "a"))).toBe("foobar");
  });

  test("test_codex_event_delta_text_variants", () => {
    // string delta on item
    expect(sched._codex_event_delta_text({}, { delta: "abc" })).toBe("abc");
    // dict delta with text on event
    expect(sched._codex_event_delta_text({ delta: { text: "xyz" } }, {})).toBe(
      "xyz",
    );
    // dict delta whose text is not a string → null
    expect(
      sched._codex_event_delta_text({}, { delta: { text: 5 } }),
    ).toBeNull();
    // no delta anywhere → null
    expect(sched._codex_event_delta_text({}, {})).toBeNull();
  });

  test("test_extract_codex_thread_id_skips_noise", () => {
    const raw = [
      "   ", // blank
      "not json", // parse error
      JSON.stringify({ type: "turn.started" }), // no thread id
      JSON.stringify({ type: "thread.started", thread_id: "TH-42" }),
    ].join("\n");
    expect(sched._extract_codex_thread_id(raw)).toBe("TH-42");
    expect(sched._extract_codex_thread_id("only noise here")).toBeNull();
  });

  test("test_image_media_type_extension_map", () => {
    expect(sched._image_media_type("/x/a.png")).toBe("image/png");
    expect(sched._image_media_type("/x/a.JPG")).toBe("image/jpeg");
    expect(sched._image_media_type("/x/a.webp")).toBe("image/webp");
    // unknown extension → default png
    expect(sched._image_media_type("/x/a.bmp")).toBe("image/png");
  });

  test("test_find_codex_generated_images_filters_and_sorts", () => {
    process.env.HOME = tmpDir;
    delete process.env.CODEX_HOME;

    // No thread id → empty.
    expect(sched._find_codex_generated_images(null)).toEqual([]);
    // Thread id with no directory → empty.
    expect(sched._find_codex_generated_images("ghost")).toEqual([]);

    const img_dir = path.join(tmpDir, ".codex", "generated_images", "TH");
    fs.mkdirSync(img_dir, { recursive: true });
    fs.writeFileSync(path.join(img_dir, "b.png"), "x");
    fs.writeFileSync(path.join(img_dir, "a.webp"), "y");
    fs.writeFileSync(path.join(img_dir, "note.txt"), "skip me"); // non-image suffix

    const found = sched._find_codex_generated_images("TH");
    expect(found.map((p) => path.basename(p))).toEqual(["a.webp", "b.png"]);
  });

  test("test_find_codex_generated_images_since_timestamp", () => {
    process.env.HOME = tmpDir;
    delete process.env.CODEX_HOME;
    const img_dir = path.join(tmpDir, ".codex", "generated_images", "TH");
    fs.mkdirSync(img_dir, { recursive: true });
    const old = path.join(img_dir, "old.png");
    fs.writeFileSync(old, "x");
    fs.utimesSync(old, 1000, 1000); // ancient mtime
    const fresh = path.join(img_dir, "new.png");
    fs.writeFileSync(fresh, "y"); // current mtime

    // Only the freshly written file passes the since_timestamp filter.
    const found = sched._find_codex_generated_images(
      "TH",
      Date.now() / 1000 - 60,
    );
    expect(found.map((p) => path.basename(p))).toEqual(["new.png"]);
  });

  test("test_extract_codex_success_output_with_images", () => {
    const raw = [
      "  ", // blank skipped
      "not json", // decode error skipped
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done" },
      }),
    ].join("\n");
    const out = sched._extract_codex_success_output(raw, ["/a.png", "/b.png"]);
    expect(out).toContain("Done");
    expect(out).toContain("2 张图片");
    expect(out).toContain("/a.png");
    expect(out).toContain("/b.png");
    // No images and no agent_message text → empty string.
    expect(sched._extract_codex_success_output("nothing here")).toBe("");
  });

  test("test_store_generated_image_events_persists_metadata_and_data", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const run_id = db.add_run(tid);

    const real = fs.mkdtempSync("/tmp/agentforge-img-");
    const img = path.join(real, "pic.png");
    fs.writeFileSync(
      img,
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from("PNG\r\n"),
        Buffer.from([0x1a, 0x0a]),
        Buffer.from("bytes"),
      ]),
    );
    const missing = path.join(real, "gone.png"); // never created → read-error branch

    sched._store_generated_image_events(tid, run_id, [img, missing]);
    fs.rmSync(real, { recursive: true, force: true });

    const events = db.get_output_events(tid);
    const types = events.map((e) => e["event_type"]);
    // The real image yields both a generated_image trace and an image_content row;
    // the missing one yields only the trace (read fails → continue).
    expect(types.filter((t) => t === "generated_image").length).toBe(2);
    expect(types.filter((t) => t === "image_content").length).toBe(1);
    const content = events.find((e) => e["event_type"] === "image_content")!;
    const parsed = JSON.parse(content["content"]);
    expect(parsed["media_type"]).toBe("image/png");
    expect(parsed["data"]).toBeTruthy(); // base64 payload present
  });

  // ── Claude streaming delta helpers ──────────────────────────────────────
  test("test_claude_text_delta_paths", () => {
    // empty current → null
    expect(sched._claude_text_delta(1, "m", "")).toBeNull();
    // first emission returns whole text
    expect(sched._claude_text_delta(1, "m", "abc")).toBe("abc");
    // identical → null
    expect(sched._claude_text_delta(1, "m", "abc")).toBeNull();
    // cumulative continuation → suffix
    expect(sched._claude_text_delta(1, "m", "abcdef")).toBe("def");
    // non-cumulative chunk on same message → returns chunk, accumulates state
    expect(sched._claude_text_delta(1, "m", "ZZZ")).toBe("ZZZ");
    expect(sched._claude_message_text.get(tupleKey(1, "m"))).toBe("abcdefZZZ");
  });

  test("test_claude_message_id_fallback", () => {
    expect(sched._claude_message_id({ message: { id: "msg-7" } }, 1)).toBe(
      "msg-7",
    );
    expect(sched._claude_message_id({ message: { message_id: "mm" } }, 1)).toBe(
      "mm",
    );
    // no id at all → synthesized from run id
    expect(sched._claude_message_id({ message: {} }, 3)).toBe("assistant:3");
    expect(sched._claude_message_id({ message: "not-a-dict" }, 4)).toBe(
      "assistant:4",
    );
  });

  test("test_content_to_display_text_variants", () => {
    expect(sched._content_to_display_text(null)).toBe("");
    expect(sched._content_to_display_text("plain")).toBe("plain");
    const mixed = [
      "raw",
      { type: "text", text: "T" },
      { type: "image" },
      { type: "other", k: "v" },
    ];
    const out = sched._content_to_display_text(mixed);
    expect(out).toContain("raw");
    expect(out).toContain("T");
    expect(out).toContain("[image]");
    expect(out).toContain("other");
    // dict with text type
    expect(sched._content_to_display_text({ type: "text", text: "hi" })).toBe(
      "hi",
    );
    // dict without text type → JSON dump
    expect(sched._content_to_display_text({ foo: "bar" })).toContain("foo");
    // non-str/list/dict → String()
    expect(sched._content_to_display_text(42)).toBe("42");
  });

  test("test_store_output_event_skips_empty", () => {
    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: "." }),
    );
    const run_id = db.add_run(tid);
    sched._store_output_event(tid, run_id, "assistant", ""); // empty → no row
    expect(db.get_output_events(tid)).toEqual([]);
    sched._store_output_event(tid, run_id, "assistant", "real");
    expect(db.get_output_events(tid).length).toBe(1);
  });

  // ── _parse_codex_event normalization branches ───────────────────────────
  test("test_parse_codex_event_reasoning_and_kinds", () => {
    // reasoning delta → "[thinking] ..." assistant content
    let [etype, content] = sched._parse_codex_event(
      {
        type: "item.updated",
        item: { id: "r1", type: "reasoning", delta: "ponder" },
      },
      1,
    );
    expect(etype).toBe("assistant");
    expect(content).toBe("[thinking] ponder");

    // command_execution
    [etype, content] = sched._parse_codex_event({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        aggregated_output: "files",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(etype).toBe("command_execution");
    expect(JSON.parse(content!)["command"]).toBe("ls");

    // mcp_tool_call → tool_call
    [etype] = sched._parse_codex_event({
      type: "item.completed",
      item: { type: "mcp_tool_call", tool: "x" },
    });
    expect(etype).toBe("tool_call");

    // web_search
    [etype] = sched._parse_codex_event({
      type: "item.completed",
      item: { type: "web_search", query: "q" },
    });
    expect(etype).toBe("web_search");

    // file_change
    [etype] = sched._parse_codex_event({
      type: "item.completed",
      item: { type: "file_change", changes: [] },
    });
    expect(etype).toBe("file_change");

    // unknown item type → passthrough (etype, full json)
    [etype, content] = sched._parse_codex_event({
      type: "item.completed",
      item: { type: "mystery" },
    });
    expect(etype).toBe("item.completed");
  });

  test("test_parse_codex_event_errors_and_skips", () => {
    // turn.failed → error with message
    expect(
      sched._parse_codex_event({
        type: "turn.failed",
        error: { message: "boom" },
      }),
    ).toEqual(["error", "boom"]);
    // turn.failed with non-dict error
    expect(
      sched._parse_codex_event({ type: "turn.failed", error: "plain" }),
    ).toEqual(["error", "plain"]);
    // plain error event
    expect(sched._parse_codex_event({ type: "error", message: "bad" })).toEqual(
      ["error", "bad"],
    );
    // silent skips
    expect(sched._parse_codex_event({ type: "turn.completed" })).toEqual([
      null,
      null,
    ]);
    expect(sched._parse_codex_event({ type: "thread.started" })).toEqual([
      null,
      null,
    ]);
    // truly unknown top-level type → passthrough
    const [etype] = sched._parse_codex_event({ type: "weird.thing", a: 1 });
    expect(etype).toBe("weird.thing");
  });

  // ── _execute_task EDGE: magic-byte media sniff + unsafe-path reject ──────
  test("test_execute_task_sniffs_media_type_for_extensionless_images", async () => {
    // An extension-less safe image is loaded and its media type detected from
    // magic bytes; an unsafe path (outside allowed roots) is rejected. The Claude
    // multimodal stdin path is then taken with the sniffed media type.
    stubProcessGroup(sched);

    const real = fs.mkdtempSync("/tmp/agentforge-img-");
    const gif = path.join(real, "noext_gif"); // no extension → magic-byte branch
    fs.writeFileSync(
      gif,
      Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)]),
    );

    const tid = db.add_task(
      makeTask({
        title: "img",
        prompt: "see",
        working_dir: ".",
        agent: "claude",
        image_paths: [gif, "/etc/shadow"], // one safe extensionless, one rejected
      }),
    );
    const task = db.get_task(tid)!;
    sched._active_tasks.set(tid, { is_alive: () => true });

    const captured: Row = {};
    sched._popen = (cmd: string[], kwargs) => {
      captured["cmd"] = cmd;
      captured["stdin_obj"] = kwargs.stdin;
      return new FakePopen(_claude_lines("ok"));
    };
    await sched._execute_task(task);
    fs.rmSync(real, { recursive: true, force: true });

    expect(db.get_task(tid)!["status"]).toBe("completed");
    // multimodal stdin path selected because exactly one image loaded
    const cmd: string[] = captured["cmd"];
    expect(cmd).toContain("--input-format");
    // stdin is the PIPE sentinel; the message content lives on the fake stdin
    // object that _popen returned.
    const { PIPE } = await import("../src/executor.ts");
    expect(captured["stdin_obj"]).toBe(PIPE);
  });

  test("test_execute_task_sniffs_jpeg_magic_bytes", async () => {
    stubProcessGroup(sched);
    const real = fs.mkdtempSync("/tmp/agentforge-img-");
    const jpg = path.join(real, "noext_jpeg");
    fs.writeFileSync(
      jpg,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]),
    );

    const tid = db.add_task(
      makeTask({
        title: "j",
        prompt: "p",
        working_dir: ".",
        agent: "claude",
        image_paths: [jpg],
      }),
    );
    const task = db.get_task(tid)!;
    sched._active_tasks.set(tid, { is_alive: () => true });

    const written: { fp?: FakePopen } = {};
    sched._popen = () => {
      const fp = new FakePopen(_claude_lines());
      written.fp = fp;
      return fp;
    };
    await sched._execute_task(task);
    fs.rmSync(real, { recursive: true, force: true });

    expect(db.get_task(tid)!["status"]).toBe("completed");
    // The multimodal stdin message embeds the jpeg media type sniffed from bytes.
    expect(written.fp!.stdin.buffer).toContain("image/jpeg");
  });

  test("test_execute_task_notify_fans_out_to_channels_and_callback", async () => {
    // _notify (called several times during execution) fires the on_task_update
    // callback and schedules a notify call for each registered channel.
    const updates: number[] = [];

    class _Chan {
      notified: number[] = [];
      notify_task(task_id: number): void {
        this.notified.push(task_id);
      }
    }

    const chan = new _Chan();
    const sched2 = new TaskScheduler(db, (tid) => updates.push(tid));
    stubProcessGroup(sched2);
    sched2._channels.push(chan);

    const tid = db.add_task(
      makeTask({ title: "t", prompt: "p", working_dir: ".", agent: "claude" }),
    );
    const task = db.get_task(tid)!;
    sched2._active_tasks.set(tid, { is_alive: () => true });

    const fake = new FakePopen(_claude_lines("fine"));
    sched2._popen = () => fake;
    await sched2._execute_task(task);

    // Give the deferred notify callbacks a moment to run.
    for (let i = 0; i < 50; i++) {
      if (chan.notified.includes(tid)) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(db.get_task(tid)!["status"]).toBe("completed");
    expect(updates).toContain(tid); // on_task_update callback fired
    expect(chan.notified).toContain(tid); // channel notify_task fired
  });

  test("test_execute_task_waits_for_subagents_then_group_exits", async () => {
    // Drive the sub-agent wait loop: the first killpg(pgid, 0) probe reports the
    // group alive (enters the wait body once), the second reports it gone (breaks).
    // The 1s pause seam is stubbed so the wait is instant.
    const tid = db.add_task(
      makeTask({
        title: "sub",
        prompt: "p",
        working_dir: ".",
        agent: "claude",
      }),
    );
    const task = db.get_task(tid)!;
    sched._active_tasks.set(tid, { is_alive: () => true });

    const probe_calls = { n: 0 };

    sched._os = {
      getpgid: (pid: number) => pid,
      killpg: (_pgid: number, sig: number | NodeJS.Signals) => {
        if (sig === 0) {
          probe_calls.n += 1;
          if (probe_calls.n === 1) {
            return; // group still alive → loop body runs once
          }
          throw new ProcessLookupError(); // gone → loop breaks
        }
        throw new ProcessLookupError();
      },
      kill: () => {
        throw new ProcessLookupError();
      },
    };
    // Make the 1s wait-loop sleep instant.
    sched._sleep = async () => {};

    const fake = new FakePopen(_claude_lines("ok"));
    sched._popen = () => fake;
    await sched._execute_task(task);

    expect(db.get_task(tid)!["status"]).toBe("completed");
    // The loop probed at least twice (alive, then gone).
    expect(probe_calls.n).toBeGreaterThanOrEqual(2);
  });
});
