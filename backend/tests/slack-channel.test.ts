// Ported from tests/test_slack_channel.py (bun:test).
//
// Python's MagicMock web client becomes a small object of bun `mock()`
// functions with the same call surface; `_wait_threads()` (joining Python's
// daemon threads) becomes draining the event loop with setTimeout(0).

import { expect, mock, test } from "bun:test";

import {
  bus_notify,
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
} from "../src/bus.ts";
import { _hooks as dir_hooks } from "../src/channels/dir_utils.ts";
import { SlackChannel } from "../src/channels/slack.ts";
import type { SlackTaskDB } from "../src/channels/slack.ts";
import type { Task } from "../src/types.ts";

class StubDB implements SlackTaskDB {
  settings: Record<string, string> = {};
  tasks: Record<number, Record<string, unknown>> = {};
  updated: Array<[number, Record<string, unknown>]> = [];

  get_setting(key: string, defaultValue: string | null = null): string | null {
    return this.settings[key] ?? defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.settings[key] = value;
  }

  get_task(task_id: number): Record<string, unknown> | null {
    return this.tasks[task_id] ?? null;
  }

  update_task(task_id: number, updates: Record<string, unknown>): void {
    this.updated.push([task_id, updates]);
    this.tasks[task_id] = {
      ...(this.tasks[task_id] ?? { id: task_id }),
      ...updates,
    };
  }
}

class StubScheduler {
  submitted: Task[] = [];

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }
}

/** ≙ the MagicMock web client injected by the pytest helper. */
function make_web_client() {
  return {
    auth_test: mock(async () => ({}) as Record<string, unknown>),
    chat_postMessage: mock(async (_args: any) => ({ ts: "1700.0001" }) as any),
    reactions_add: mock(async (_args: any) => ({}) as any),
    conversations_open: mock(async (_args: any) => ({}) as any),
  };
}

type WebClientMock = ReturnType<typeof make_web_client>;

function _make_channel(db?: StubDB, scheduler?: StubScheduler) {
  const bus = new MessageBus();
  const the_db = db ?? new StubDB();
  const the_scheduler = scheduler ?? new StubScheduler();
  const channel = new SlackChannel(
    bus,
    the_db,
    the_scheduler,
    "xoxb-test",
    "xapp-test",
  );
  // Inject a mock web client and bot id so helpers don't hit the network.
  const web = make_web_client();
  channel._web_client = web;
  channel._bot_user_id = "UBOT";
  return { channel, bus, db: the_db, scheduler: the_scheduler, web };
}

function last_text(web: WebClientMock): string {
  return (web.chat_postMessage.mock.calls.at(-1)![0] as any).text;
}

function all_texts(web: WebClientMock): string[] {
  return web.chat_postMessage.mock.calls.map((c) => (c[0] as any).text);
}

/** ≙ pytest `patch("channels.dir_utils.resolve_working_dir", ...)`. */
async function with_resolved_dir<T>(
  value: string,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = dir_hooks.extract_working_dir_with_claude;
  dir_hooks.extract_working_dir_with_claude = async () => value;
  try {
    return await fn();
  } finally {
    dir_hooks.extract_working_dir_with_claude = orig;
  }
}

/** ≙ pytest capsys: capture console.log output. */
function capture_logs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = orig;
    },
  };
}

/** ≙ joining the daemon threads spawned by send()/_add_reaction. */
async function _wait_threads(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ── construction / config ────────────────────────────────────────

test("test_init_reads_tokens_and_subscribes", () => {
  const { channel, bus } = _make_channel();
  expect(channel.bot_token).toBe("xoxb-test");
  expect(channel.app_token).toBe("xapp-test");
  expect(channel.name).toBe("slack");
  expect((bus as any)._outbound_listeners).toContain(channel._on_outbound);
});

test("test_init_falls_back_to_env", () => {
  const orig_bot = process.env.SLACK_BOT_TOKEN;
  const orig_app = process.env.SLACK_APP_TOKEN;
  process.env.SLACK_BOT_TOKEN = "xoxb-env";
  process.env.SLACK_APP_TOKEN = "xapp-env";
  try {
    const channel = new SlackChannel(
      new MessageBus(),
      new StubDB(),
      new StubScheduler(),
    );
    expect(channel.bot_token).toBe("xoxb-env");
    expect(channel.app_token).toBe("xapp-env");
  } finally {
    if (orig_bot === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = orig_bot;
    if (orig_app === undefined) delete process.env.SLACK_APP_TOKEN;
    else process.env.SLACK_APP_TOKEN = orig_app;
  }
});

test("test_start_disabled_without_tokens", async () => {
  const channel = new SlackChannel(
    new MessageBus(),
    new StubDB(),
    new StubScheduler(),
  );
  channel.bot_token = "";
  channel.app_token = "";
  const { logs, restore } = capture_logs();
  try {
    await channel.start();
  } finally {
    restore();
  }
  expect(logs.join("\n")).toContain("disabled");
  expect(channel._running).toBe(false);
});

test("test_parse_task_id", () => {
  expect(SlackChannel._parse_task_id("#42")).toBe(42);
  expect(SlackChannel._parse_task_id(" 7 ")).toBe(7);
  expect(SlackChannel._parse_task_id("nope")).toBeNull();
  expect(SlackChannel._parse_task_id("")).toBeNull();
});

// ── task creation ────────────────────────────────────────────────

test("test_create_task_submits_and_tracks_origin", async () => {
  const scheduler = new StubScheduler();
  const { channel, web } = _make_channel(undefined, scheduler);

  await with_resolved_dir("~/myapp", () =>
    channel._handle_user_message("fix login bug", "C1", null, "100.1"),
  );

  expect(scheduler.submitted.length).toBe(1);
  const task = scheduler.submitted[0]!;
  expect(task.prompt).toBe("fix login bug");
  expect(task.title).toBe("[Slack] fix login bug");
  expect(task.tags).toBe("slack");
  expect(task.working_dir).toBe("~/myapp");
  // origin tracked: [channel_id, thread_ts, reaction_ts]
  expect(channel._task_origin.get(1)).toEqual(["C1", "100.1", "100.1"]);
  expect(channel._thread_ts_map.get("100.1")).toBe(1);
  expect(last_text(web)).toBe("Thinking ▌");
  expect(last_text(web)).not.toContain("Task #");
  expect(last_text(web)).not.toContain("[Slack]");
});

test("test_create_task_registers_slack_source_for_bus_notifications", async () => {
  const { channel, bus, db } = _make_channel();

  await with_resolved_dir("~/myapp", () =>
    channel._handle_user_message("fix login bug", "C1", null, "100.1"),
  );
  db.tasks[1] = {
    status: "completed",
    result: "ok",
    error: null,
    title: "[Slack] fix login bug",
  };

  bus_notify(bus, db, 1);

  const msg = await bus.get_outbound();
  expect(msg!.metadata["source_channel"]).toBe("slack");
});

test("test_empty_message_replies_help", async () => {
  const { channel, web } = _make_channel();
  await channel._handle_user_message("", "C1", null, "100.1");
  expect(last_text(web)).toContain("AgentForge Bot");
});

test("test_help_command_and_word", async () => {
  const { channel, web } = _make_channel();
  await channel._handle_user_message("/help", "C1", null, "1.0");
  await channel._handle_user_message("help", "C1", null, "2.0");
  const texts = all_texts(web);
  expect(texts.length).toBe(2);
  for (const t of texts) {
    expect(t).toContain("AgentForge Bot");
  }
});

test("test_unknown_command_replies_help", async () => {
  const { channel, web } = _make_channel();
  await channel._handle_user_message("/bogus", "C1", null, "1.0");
  expect(last_text(web)).toContain("AgentForge Bot");
});

// ── commands ─────────────────────────────────────────────────────

test("test_cmd_status_usage_and_not_found", async () => {
  const { channel, web } = _make_channel();
  await channel._cmd_status("", "C1", "1.0");
  expect(last_text(web)).toContain("Usage");

  await channel._cmd_status("99", "C1", "1.0");
  expect(last_text(web)).toContain("not found");
});

test("test_cmd_status_renders_task", async () => {
  const db = new StubDB();
  db.tasks[5] = {
    id: 5,
    title: "Build feature",
    status: "completed",
    created_at: "2026-01-01",
    last_run_at: "2026-01-02",
    result: "all green",
    error: null,
  };
  const { channel, web } = _make_channel(db);
  await channel._cmd_status("#5", "C1", "1.0");
  const text = last_text(web);
  expect(text).toContain(":white_check_mark:");
  expect(text).toContain("Task #5");
  expect(text).toContain("Build feature");
  expect(text).toContain("all green");
});

test("test_cmd_cancel_paths", async () => {
  const db = new StubDB();
  db.tasks[1] = { id: 1, title: "t", status: "running" };
  db.tasks[2] = { id: 2, title: "t", status: "completed" };
  const { channel, web } = _make_channel(db);

  await channel._cmd_cancel("", "C1", "1.0");
  expect(last_text(web)).toContain("Usage");

  await channel._cmd_cancel("99", "C1", "1.0");
  expect(last_text(web)).toContain("not found");

  await channel._cmd_cancel("2", "C1", "1.0");
  expect(last_text(web)).toContain("already");

  await channel._cmd_cancel("1", "C1", "1.0");
  expect(db.updated.at(-1)).toEqual([1, { status: "cancelled" }]);
  expect(last_text(web)).toContain("cancelled");
});

test("test_cmd_resume_paths", async () => {
  const db = new StubDB();
  db.tasks[1] = { id: 1, title: "t", status: "completed", session_id: "s1" };
  db.tasks[2] = { id: 2, title: "t", status: "completed" }; // no session
  const { channel, web } = _make_channel(db);

  await channel._cmd_resume("", "C1", "1.0");
  expect(last_text(web)).toContain("Usage");

  await channel._cmd_resume("1", "C1", "1.0");
  expect(last_text(web)).toContain("provide a message");

  await channel._cmd_resume("2 keep going", "C1", "1.0");
  expect(last_text(web)).toContain("no saved session");

  const replies_before_success = web.chat_postMessage.mock.calls.length;
  await channel._cmd_resume("#1 keep going", "C1", "1.0");
  expect(db.updated.at(-1)![0]).toBe(1);
  expect(db.updated.at(-1)![1]["prompt"]).toBe("keep going");
  expect(db.updated.at(-1)![1]["status"]).toBe("pending");
  expect(channel._task_origin.get(1)).toEqual(["C1", "1.0", "1.0"]);
  expect(web.chat_postMessage.mock.calls.length).toBe(replies_before_success);
});

test("test_slash_command_dispatch_dir_and_agent", async () => {
  const db = new StubDB();
  const { channel } = _make_channel(db);

  await channel._handle_user_message("/dir ~/proj", "C1", null, "1.0");
  expect(db.get_setting("slack_default_working_dir")).toBe("~/proj");

  await channel._handle_user_message("/agent codex", "C1", null, "2.0");
  expect(db.get_setting("default_agent")).toBe("codex");
});

// ── resume by thread reply ───────────────────────────────────────

test("test_thread_reply_resumes_task", async () => {
  const db = new StubDB();
  db.tasks[8] = { id: 8, title: "t", status: "completed", session_id: "s8" };
  const { channel, web } = _make_channel(db);
  channel._notification_map.set("root.1", 8);

  await channel._handle_user_message(
    "continue please",
    "C1",
    "root.1",
    "200.1",
  );

  expect(db.updated.at(-1)![0]).toBe(8);
  expect(db.updated.at(-1)![1]["prompt"]).toBe("continue please");
  expect(channel._task_origin.get(8)).toEqual(["C1", "root.1", "200.1"]);
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_thread_reply_via_thread_ts_map", async () => {
  const db = new StubDB();
  db.tasks[9] = { id: 9, title: "t", status: "completed", session_id: "s9" };
  const { channel, web } = _make_channel(db);
  channel._thread_ts_map.set("root.9", 9);

  await channel._handle_user_message("more work", "C1", "root.9", "300.1");
  expect(db.updated.at(-1)![0]).toBe(9);
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_thread_reply_no_session_warns", async () => {
  const db = new StubDB();
  db.tasks[10] = { id: 10, title: "t", status: "completed" }; // no session
  const { channel, web } = _make_channel(db);
  channel._notification_map.set("root.10", 10);

  await channel._handle_user_message("go", "C1", "root.10", "400.1");
  expect(db.updated).toEqual([]);
  expect(last_text(web)).toContain("no saved session");
});

// ── event dispatch ───────────────────────────────────────────────

test("test_handle_message_event_dm", async () => {
  const db = new StubDB();
  const { channel, scheduler } = _make_channel(db);
  await with_resolved_dir("~", () =>
    channel._handle_message_event({
      channel_type: "im",
      user: "U1",
      text: "do something",
      channel: "D1",
      ts: "10.1",
    }),
  );
  expect(scheduler.submitted.length).toBe(1);
});

test("test_handle_message_event_skips_non_dm_and_bot", async () => {
  const { channel, scheduler } = _make_channel();
  await channel._handle_message_event({ channel_type: "channel", text: "x" });
  await channel._handle_message_event({
    channel_type: "im",
    bot_id: "B1",
    text: "x",
  });
  await channel._handle_message_event({
    channel_type: "im",
    user: "UBOT",
    text: "x",
    channel: "D1",
    ts: "1",
  });
  expect(scheduler.submitted.length).toBe(0);
});

test("test_handle_mention_event_strips_prefix", async () => {
  const { channel, scheduler } = _make_channel();
  await with_resolved_dir("~", () =>
    channel._handle_mention_event({
      user: "U1",
      text: "<@UBOT> build the thing",
      channel: "C9",
      ts: "50.1",
    }),
  );
  const task = scheduler.submitted[0]!;
  expect(task.prompt).toBe("build the thing");
});

test("test_handle_mention_event_skips_bot", async () => {
  const { channel, scheduler } = _make_channel();
  await channel._handle_mention_event({ bot_id: "B1", text: "x" });
  await channel._handle_mention_event({ user: "UBOT", text: "x" });
  expect(scheduler.submitted.length).toBe(0);
});

test("test_app_home_opened_sends_help", async () => {
  const { channel, web } = _make_channel();
  web.conversations_open.mockImplementation(async () => ({
    channel: { id: "D5" },
  }));
  await channel._handle_app_home_opened({ user: "U7", tab: "home" });
  expect(last_text(web)).toContain("AgentForge Bot");
});

test("test_app_home_opened_ignores_non_home_tab", async () => {
  const { channel, web } = _make_channel();
  await channel._handle_app_home_opened({ user: "U7", tab: "messages" });
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_handle_socket_request_dispatches_message", async () => {
  const { channel, scheduler } = _make_channel();
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "events_api",
    envelope_id: "envelope-1234567890",
    payload: {
      event: {
        type: "message",
        channel_type: "im",
        user: "U1",
        text: "hello there",
        channel: "D1",
        ts: "9.9",
      },
    },
  };

  await with_resolved_dir("~", () =>
    channel._handle_socket_request(client, req),
  );
  expect(client.send_socket_mode_response).toHaveBeenCalledTimes(1);
  expect(scheduler.submitted.length).toBe(1);
});

test("test_handle_socket_request_ignores_non_events_api", async () => {
  const { channel, scheduler } = _make_channel();
  const client = { send_socket_mode_response: mock((_resp: any) => {}) };

  const req = {
    type: "hello",
    envelope_id: "envelope-abcdefghijkl",
    payload: {},
  };

  await channel._handle_socket_request(client, req);
  expect(client.send_socket_mode_response).toHaveBeenCalledTimes(1);
  expect(scheduler.submitted.length).toBe(0);
});

// ── outbound send ────────────────────────────────────────────────

test("test_send_completion_to_origin", async () => {
  const db = new StubDB();
  const { channel, web } = _make_channel(db);
  channel._task_origin.set(3, ["C1", "100.1", "100.1"]);

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 3,
      payload: { title: "Fix login", result: "all done" },
    }),
  );
  await _wait_threads();
  // Reaction added + reply posted with the result text.
  const react_names = web.reactions_add.mock.calls.map(
    (c) => (c[0] as any).name,
  );
  expect(react_names).toContain("white_check_mark");
  const posted = all_texts(web);
  expect(posted.some((t) => t.includes("all done"))).toBe(true);
  // Notification ts mapped to task and origin freed.
  expect(channel._notification_map.get("1700.0001")).toBe(3);
  expect(channel._task_origin.has(3)).toBe(false);
});

test("test_send_failure_to_origin_adds_x_reaction", async () => {
  const db = new StubDB();
  const { channel, web } = _make_channel(db);
  channel._task_origin.set(4, ["C1", "100.1", "100.1"]);

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_FAILED,
      task_id: 4,
      payload: { title: "Broke", error: "boom" },
    }),
  );
  await _wait_threads();
  const react_names = web.reactions_add.mock.calls.map(
    (c) => (c[0] as any).name,
  );
  expect(react_names).toContain("x");
  const posted = all_texts(web);
  expect(posted.some((t) => t.includes("boom"))).toBe(true);
});

test("test_send_ignores_non_terminal_types", async () => {
  const { channel, web } = _make_channel();
  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_STARTED,
      task_id: 1,
      payload: {},
    }),
  );
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_send_fallback_to_default_channel", async () => {
  const db = new StubDB();
  db.settings["slack_default_channel"] = "C-DEFAULT";
  const { channel, web } = _make_channel(db);

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 11,
      payload: { title: "Job", result: "ok" },
    }),
  );
  await _wait_threads();
  const call = web.chat_postMessage.mock.calls.at(-1)![0] as any;
  expect(call.channel).toBe("C-DEFAULT");
  expect(call.text).not.toStartWith(":white_check_mark:");
  expect(call.text).toBe("ok");
  expect(call.text).toContain("ok");
  expect(call.text).not.toContain("Job");
  expect(call.text).not.toContain("Task #");
  expect(call.text).not.toContain("[Slack]");
});

test("test_send_fallback_to_dm_user", async () => {
  const db = new StubDB();
  db.settings["slack_default_user"] = "U-DM";
  const { channel, web } = _make_channel(db);
  web.conversations_open.mockImplementation(async () => ({
    channel: { id: "D-DM" },
  }));

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 12,
      payload: { title: "Job", result: "ok" },
    }),
  );
  await _wait_threads();
  const call = web.chat_postMessage.mock.calls.at(-1)![0] as any;
  expect(call.channel).toBe("D-DM");
  expect(call.text).not.toStartWith(":white_check_mark:");
  expect(call.text).toBe("ok");
  expect(call.text).toContain("ok");
  expect(call.text).not.toContain("Job");
  expect(call.text).not.toContain("Task #");
  expect(call.text).not.toContain("[Slack]");
});

test("test_send_no_origin_no_default_skips", async () => {
  const { channel, web } = _make_channel();
  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 13,
      payload: { title: "Job", result: "ok" },
    }),
  );
  await _wait_threads();
  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

test("test_send_ignores_task_from_other_channel", async () => {
  const { channel, db, web } = _make_channel();
  db.set_setting("slack_default_channel", "C-default");

  channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 14,
      payload: { title: "Feishu task", result: "ok" },
      metadata: { source_channel: "feishu" },
    }),
  );
  await _wait_threads();

  expect(web.chat_postMessage).not.toHaveBeenCalled();
});

// ── low-level helpers ────────────────────────────────────────────

test("test_open_dm_channel_caches", async () => {
  const { channel, web } = _make_channel();
  web.conversations_open.mockImplementation(async () => ({
    channel: { id: "D1" },
  }));
  expect(await channel._open_dm_channel("U1")).toBe("D1");
  // Second call should hit the cache, not the API.
  web.conversations_open.mockClear();
  expect(await channel._open_dm_channel("U1")).toBe("D1");
  expect(web.conversations_open).not.toHaveBeenCalled();
});

test("test_open_dm_channel_handles_error", async () => {
  const { channel, web } = _make_channel();
  web.conversations_open.mockImplementation(async () => {
    throw new Error("nope");
  });
  expect(await channel._open_dm_channel("U2")).toBeNull();
});

test("test_reply_return_ts", async () => {
  const { channel, web } = _make_channel();
  web.chat_postMessage.mockImplementation(async () => ({ ts: "999.1" }));
  expect(await channel._reply_return_ts("C1", null, "hi")).toBe("999.1");

  web.chat_postMessage.mockImplementation(async () => {
    throw new Error("fail");
  });
  expect(await channel._reply_return_ts("C1", null, "hi")).toBeNull();
});

test("test_stop_unsubscribes", () => {
  const { channel, bus } = _make_channel();
  const disconnect = mock(() => {});
  channel._socket_client = {
    socket_mode_request_listeners: [],
    connect: () => {},
    disconnect,
  };
  channel.stop();
  expect(channel._running).toBe(false);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect((bus as any)._outbound_listeners).not.toContain(channel._on_outbound);
});
