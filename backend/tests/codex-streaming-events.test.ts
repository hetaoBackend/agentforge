// Codex NDJSON streaming-event parsing and generated-image handling.
//
// Ported from tests/test_codex_streaming_events.py; test() descriptions keep
// the Python test function names.
//
// The Python suite builds `TaskScheduler(Mock())` and replaces
// `db.add_output_event` with a Mock; here the db seam is a stub object that
// records every add_output_event call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskDB } from "../src/db.ts";
import { TaskScheduler } from "../src/scheduler.ts";

type Row = Record<string, any>;

interface StubbedScheduler {
  scheduler: TaskScheduler;
  /** Every db.add_output_event(...) call's positional args. */
  stored: any[][];
}

function _scheduler(): StubbedScheduler {
  const stored: any[][] = [];
  const db = {
    add_output_event: (...args: any[]) => {
      stored.push(args);
    },
  } as unknown as TaskDB;
  const scheduler = new TaskScheduler(db);
  return { scheduler, stored };
}

function addListener(scheduler: TaskScheduler): any[][] {
  const calls: any[][] = [];
  scheduler.add_output_listener((...args) => {
    calls.push(args);
  });
  return calls;
}

describe("codex streaming events", () => {
  let tmpDir: string;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-test-"));
    savedCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("test_codex_item_updated_cumulative_text_emits_only_deltas", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const events = [
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "Hel" },
      },
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "Hello " },
      },
      {
        type: "item.updated",
        item: { id: "msg_1", type: "agent_message", text: "Hello world" },
      },
      {
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "Hello world" },
      },
    ];

    for (const event of events) {
      scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");
    }

    expect(stored.map((c) => c[3])).toEqual(["Hel", "lo ", "world"]);
    expect(listener.map((c) => c[3])).toEqual(["Hel", "lo ", "world"]);
  });

  test("test_codex_item_updated_delta_text_does_not_duplicate_completed_text", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const events = [
      {
        type: "item.updated",
        delta: { text: "Hello" },
        item: { id: "msg_1", type: "agent_message" },
      },
      {
        type: "item.updated",
        delta: { text: " world" },
        item: { id: "msg_1", type: "agent_message" },
      },
      {
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "Hello world" },
      },
    ];

    for (const event of events) {
      scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");
    }

    expect(stored.map((c) => c[3])).toEqual(["Hello", " world"]);
    expect(listener.map((c) => c[3])).toEqual(["Hello", " world"]);
  });

  test("test_codex_reasoning_updated_text_does_not_duplicate_completed_text", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const events = [
      {
        type: "item.updated",
        delta: { text: "Think" },
        item: { id: "reasoning_1", type: "reasoning" },
      },
      {
        type: "item.updated",
        delta: { text: " carefully" },
        item: { id: "reasoning_1", type: "reasoning" },
      },
      {
        type: "item.completed",
        item: { id: "reasoning_1", type: "reasoning", text: "Think carefully" },
      },
    ];

    for (const event of events) {
      scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");
    }

    expect(stored.map((c) => c[3])).toEqual([
      "[thinking] Think",
      "[thinking]  carefully",
    ]);
    expect(listener.map((c) => c[3])).toEqual([
      "[thinking] Think",
      "[thinking]  carefully",
    ]);
  });

  test("test_codex_command_execution_is_stored_and_streamed", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const event = {
      type: "item.completed",
      item: {
        id: "cmd_1",
        type: "command_execution",
        command: "pytest -q",
        aggregated_output: "42 passed",
        exit_code: 0,
        status: "completed",
      },
    };

    scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");

    expect(stored.length).toBe(1);
    const [task_id, run_id, event_type, content] = stored[0]!;
    expect([task_id, run_id, event_type]).toEqual([1, 2, "command_execution"]);
    expect(JSON.parse(content)).toEqual({
      id: "cmd_1",
      command: "pytest -q",
      output: "42 passed",
      exit_code: 0,
      status: "completed",
    });
    expect(listener.length).toBe(1);
    expect(listener[0]).toEqual([1, 2, "command_execution", content]);
  });

  test("test_codex_mcp_tool_call_is_stored_and_streamed_with_redacted_arguments", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const event = {
      type: "item.completed",
      item: {
        id: "mcp_1",
        type: "mcp_tool_call",
        server: "github",
        tool: "search_issues",
        arguments: {
          query: "is:open",
          token: "ghp_secret",
        },
        result: { total_count: 1 },
        status: "completed",
      },
    };

    scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");

    const [task_id, run_id, event_type, content] = stored[stored.length - 1]!;
    expect([task_id, run_id, event_type]).toEqual([1, 2, "tool_call"]);
    expect(JSON.parse(content)).toEqual({
      id: "mcp_1",
      server: "github",
      name: "search_issues",
      input: {
        query: "is:open",
        token: "[redacted]",
      },
      result: { total_count: 1 },
      status: "completed",
    });
    expect(listener.length).toBe(1);
    expect(listener[0]).toEqual([1, 2, "tool_call", content]);
  });

  test("test_codex_web_search_and_file_change_events_are_stored_and_streamed", () => {
    const { scheduler, stored } = _scheduler();
    const listener = addListener(scheduler);

    const events = [
      {
        type: "item.completed",
        item: {
          id: "search_1",
          type: "web_search",
          query: "AgentForge taskboard",
          action: "search",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "file_1",
          type: "file_change",
          changes: [{ path: "taskboard.py", kind: "modified" }],
          status: "completed",
        },
      },
    ];

    for (const event of events) {
      scheduler._parse_and_store_event(1, 2, JSON.stringify(event), "codex");
    }

    const parsed = stored.map((c) => [c[2], JSON.parse(c[3])]);
    expect(parsed).toEqual([
      [
        "web_search",
        {
          id: "search_1",
          query: "AgentForge taskboard",
          action: "search",
        },
      ],
      [
        "file_change",
        {
          id: "file_1",
          changes: [{ path: "taskboard.py", kind: "modified" }],
          status: "completed",
        },
      ],
    ]);
    expect(listener.map((c) => c[2])).toEqual(["web_search", "file_change"]);
  });

  test("test_codex_empty_final_message_uses_generated_images_not_raw_json", () => {
    const codex_home = path.join(tmpDir, "codex");
    const thread_id = "019e6224-test";
    const image_dir = path.join(codex_home, "generated_images", thread_id);
    fs.mkdirSync(image_dir, { recursive: true });
    const image_path = path.join(image_dir, "skills-overview.png");
    fs.writeFileSync(
      image_path,
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from("PNG\r\n"),
        Buffer.from([0x1a, 0x0a]),
        Buffer.from("fakepng"),
      ]),
    );
    process.env.CODEX_HOME = codex_home;

    const raw_stdout = [
      JSON.stringify({ type: "thread.started", thread_id }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "msg_1", type: "agent_message", text: "" },
      }),
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 10 } }),
    ].join("\n");

    const { scheduler } = _scheduler();
    const generated_images = scheduler._find_codex_generated_images(thread_id);
    const output = scheduler._extract_codex_success_output(
      raw_stdout,
      generated_images,
    );

    expect(generated_images).toEqual([image_path]);
    expect(output).toBe(`已生成 1 张图片：\n- ${image_path}`);
    expect(output).not.toContain("thread.started");
    expect(output).not.toContain("item.completed");
  });

  test("test_store_generated_image_events_adds_path_and_renderable_image", () => {
    const image_path = path.join(tmpDir, "result.png");
    fs.writeFileSync(
      image_path,
      Buffer.concat([
        Buffer.from([0x89]),
        Buffer.from("PNG\r\n"),
        Buffer.from([0x1a, 0x0a]),
        Buffer.from("fakepng"),
      ]),
    );

    const { scheduler, stored } = _scheduler();
    scheduler._store_generated_image_events(1, 2, [image_path]);

    const parsed: Array<[string, Row]> = stored.map((c) => [
      c[2],
      JSON.parse(c[3]),
    ]);
    expect(parsed[0]).toEqual([
      "generated_image",
      { path: image_path, media_type: "image/png" },
    ]);
    expect(parsed[1]![0]).toBe("image_content");
    expect(parsed[1]![1]["path"]).toBe(image_path);
    expect(parsed[1]![1]["media_type"]).toBe("image/png");
    expect(parsed[1]![1]["data"]).toBeTruthy();
  });
});
