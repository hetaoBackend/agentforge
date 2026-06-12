// Ported from tests/test_telegram_channel.py (bun:test).
//
// The pytest suite mocked python-telegram-bot objects (Application/Update,
// AsyncMock bot). Here the channel talks to the raw Bot API through the
// injectable `_api` seam, so tests install a recording FakeApi and build plain
// Bot-API-shaped JSON update objects. `update.message.reply_text` assertions
// become assertions on recorded `sendMessage` calls; the patched
// `asyncio.run_coroutine_threadsafe` plumbing disappears because the TS port
// simply awaits its API calls.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
} from "../src/bus.ts";
import { _hooks } from "../src/channels/dir_utils.ts";
import {
  _escape_md,
  _set_telegram_available,
  create_telegram_channel,
  TelegramChannel,
  type TelegramApi,
  type TgContext,
  type TgMessage,
  type TgUpdate,
} from "../src/channels/telegram.ts";
import type { Task } from "../src/types.ts";

// ── stubs (≙ the pytest StubDB / StubScheduler) ──────────────────

class StubDB {
  settings = new Map<string, string>();
  tasks = new Map<number, Record<string, unknown>>();
  updated: Array<[number, Record<string, unknown>]> = [];

  get_setting(key: string, defaultValue: string | null = null): string | null {
    return this.settings.get(key) ?? defaultValue;
  }

  set_setting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  get_task(task_id: number): Record<string, unknown> | null {
    return this.tasks.get(task_id) ?? null;
  }

  update_task(task_id: number, updates: Record<string, unknown>): void {
    this.updated.push([task_id, updates]);
    const task = this.tasks.get(task_id) ?? { id: task_id };
    Object.assign(task, updates);
    this.tasks.set(task_id, task);
  }
}

class StubScheduler {
  submitted: Task[] = [];

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }
}

// ── FakeApi: recording stand-in for the fetch seam (≙ AsyncMock bot) ──

interface ApiCall {
  method: string;
  params: Record<string, unknown>;
}

class FakeApi {
  calls: ApiCall[] = [];
  results = new Map<string, unknown>();
  errors = new Map<string, Error>();

  fn: TelegramApi = async (method, params = {}) => {
    this.calls.push({ method, params });
    const err = this.errors.get(method);
    if (err) throw err;
    if (this.results.has(method)) return this.results.get(method);
    if (method === "getUpdates") return [];
    return null;
  };

  callsFor(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  lastText(method: string = "sendMessage"): string {
    const calls = this.callsFor(method);
    expect(calls.length).toBeGreaterThan(0);
    return String(calls[calls.length - 1]!.params["text"]);
  }
}

// ── helpers ──────────────────────────────────────────────────────

function _make_channel(
  opts: {
    db?: StubDB;
    scheduler?: StubScheduler;
    allowed_users?: number[] | null;
  } = {},
) {
  const db = opts.db ?? new StubDB();
  const scheduler = opts.scheduler ?? new StubScheduler();
  const channel = new TelegramChannel(
    new MessageBus(),
    db,
    scheduler,
    "123:ABC",
    opts.allowed_users ?? null,
  );
  // Give it a fake API so async helpers can run without a real bot.
  const api = new FakeApi();
  channel._api = api.fn;
  return { channel, api, db, scheduler };
}

type FakeUpdate = TgUpdate & { message: TgMessage };

function _fake_update(
  opts: {
    text?: string;
    user_id?: number;
    chat_id?: number;
    message_id?: number;
    reply?: { message_id: number } | null;
  } = {},
): FakeUpdate {
  const {
    text = "hello",
    user_id = 1,
    chat_id = 10,
    message_id = 100,
    reply = null,
  } = opts;
  return {
    message: {
      message_id,
      text,
      chat: { id: chat_id },
      from: { id: user_id },
      reply_to_message: reply,
      forward_from: null,
      forward_from_chat: null,
      forward_date: null,
    },
  };
}

function _ctx(args: string[] = []): TgContext {
  return { args };
}

function captureLog() {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    text: () => lines.join("\n"),
    restore: () => spy.mockRestore(),
  };
}

function withEnvUnset<T>(keys: string[], fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
}

// Never let resolve_working_dir hit the real Anthropic extractor
// (≙ pytest patching channels.dir_utils.resolve_working_dir).
const _original_extract = _hooks.extract_working_dir_with_claude;
beforeEach(() => {
  _hooks.extract_working_dir_with_claude = async () => null;
});
afterEach(() => {
  _hooks.extract_working_dir_with_claude = _original_extract;
  _set_telegram_available(true);
});

// ── construction / factory ───────────────────────────────────────

test("test_init_sets_allowed_users", () => {
  const { channel } = _make_channel({ allowed_users: [1, 2] });
  expect(channel._allowed_users).toEqual(new Set([1, 2]));
  expect(channel.name).toBe("telegram");
  const listeners = (
    channel.bus as unknown as { _outbound_listeners: unknown[] }
  )._outbound_listeners;
  expect(listeners.includes(channel._on_outbound)).toBe(true);
});

test("test_create_telegram_channel_no_token_returns_none", () => {
  withEnvUnset(["TELEGRAM_BOT_TOKEN"], () => {
    expect(
      create_telegram_channel(new StubDB(), new StubScheduler(), null, ""),
    ).toBeNull();
  });
});

test("test_create_telegram_channel_parses_allowed_users", () => {
  const channel = create_telegram_channel(
    new StubDB(),
    new StubScheduler(),
    null,
    "123:ABC",
    "10, 20 , bad, 30",
  );
  expect(channel).not.toBeNull();
  expect(channel!._allowed_users).toEqual(new Set([10, 20, 30]));
});

test("test_create_telegram_channel_empty_allowed_users", () => {
  withEnvUnset(["TELEGRAM_ALLOWED_USERS"], () => {
    const channel = create_telegram_channel(
      new StubDB(),
      new StubScheduler(),
      null,
      "123:ABC",
      "",
    );
    expect(channel!._allowed_users).toEqual(new Set());
  });
});

test("test_create_telegram_channel_from_env", () => {
  const saved_token = process.env.TELEGRAM_BOT_TOKEN;
  const saved_users = process.env.TELEGRAM_ALLOWED_USERS;
  process.env.TELEGRAM_BOT_TOKEN = "999:ZZZ";
  process.env.TELEGRAM_ALLOWED_USERS = "5,6";
  try {
    const channel = create_telegram_channel(new StubDB(), new StubScheduler());
    expect(channel).not.toBeNull();
    expect(channel!._token).toBe("999:ZZZ");
    expect(channel!._allowed_users).toEqual(new Set([5, 6]));
  } finally {
    if (saved_token !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved_token;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (saved_users !== undefined)
      process.env.TELEGRAM_ALLOWED_USERS = saved_users;
    else delete process.env.TELEGRAM_ALLOWED_USERS;
  }
});

test("test_create_telegram_channel_makes_bus_when_none", () => {
  const channel = create_telegram_channel(
    new StubDB(),
    new StubScheduler(),
    null,
    "123:ABC",
  );
  expect(channel!.bus).not.toBeNull();
  expect(channel!.bus).toBeInstanceOf(MessageBus);
});

// ── allowed-user check ───────────────────────────────────────────

test("test_is_allowed", () => {
  const { channel: open_channel } = _make_channel();
  expect(open_channel._is_allowed(999)).toBe(true); // no allowlist → all allowed

  const { channel: restricted } = _make_channel({ allowed_users: [42] });
  expect(restricted._is_allowed(42)).toBe(true);
  expect(restricted._is_allowed(7)).toBe(false);
});

// ── escape helper ────────────────────────────────────────────────

test("test_escape_md", () => {
  expect(_escape_md("a.b-c!")).toBe("a\\.b\\-c\\!");
  expect(_escape_md("plain")).toBe("plain");
});

// ── forwarded-message formatting ─────────────────────────────────

test("test_format_forwarded_not_forwarded_returns_text", () => {
  const { channel } = _make_channel();
  const update = _fake_update({ text: "just text" });
  expect(channel._format_forwarded_text("just text", update)).toBe("just text");
});

test("test_format_forwarded_from_user_with_username", () => {
  const { channel } = _make_channel();
  const update = _fake_update();
  update.message.forward_from = {
    id: 1,
    username: "alice",
    first_name: "Alice",
    last_name: null,
  };
  update.message.forward_date = 1700000000;
  const out = channel._format_forwarded_text("body", update);
  expect(out).toContain("📨 [转发消息]");
  expect(out).toContain("转发自: @alice");
  expect(out).toContain("--- 转发内容 ---");
  expect(out.endsWith("body")).toBe(true);
  expect(out).toContain("时间:");
});

test("test_format_forwarded_from_user_without_username", () => {
  const { channel } = _make_channel();
  const update = _fake_update();
  update.message.forward_from = {
    id: 1,
    username: null,
    first_name: "Bob",
    last_name: "Lee",
  };
  update.message.forward_date = null;
  const out = channel._format_forwarded_text("body", update);
  expect(out).toContain("转发自: Bob Lee");
});

test("test_format_forwarded_from_channel_chat", () => {
  const { channel } = _make_channel();
  const update = _fake_update();
  update.message.forward_from = null;
  update.message.forward_date = 1700000000;
  update.message.forward_from_chat = {
    id: -1,
    title: "News",
    username: "news",
    type: "channel",
  };
  const out = channel._format_forwarded_text("body", update);
  expect(out).toContain("转发自频道: News");
});

test("test_format_forwarded_from_group_chat", () => {
  const { channel } = _make_channel();
  const update = _fake_update();
  update.message.forward_from = null;
  update.message.forward_date = 1700000000;
  update.message.forward_from_chat = {
    id: -1,
    title: "Devs",
    username: null,
    type: "supergroup",
  };
  const out = channel._format_forwarded_text("body", update);
  expect(out).toContain("转发自群组: Devs");
});

// ── text message handler ─────────────────────────────────────────

test("test_handle_text_message_unauthorised", async () => {
  const { channel, api } = _make_channel({ allowed_users: [42] });
  const update = _fake_update({ user_id: 7 });
  await channel._handle_text_message(update, _ctx());
  expect(api.callsFor("sendMessage").length).toBe(1);
  expect(api.lastText()).toContain("not authorised");
});

test("test_handle_text_message_empty_ignored", async () => {
  const { channel, api, scheduler } = _make_channel();
  const update = _fake_update({ text: "   " });
  await channel._handle_text_message(update, _ctx());
  expect(scheduler.submitted.length).toBe(0);
  expect(api.callsFor("sendMessage").length).toBe(0);
});

test("test_handle_text_message_dir_command", async () => {
  const { channel, api, db } = _make_channel();
  const update = _fake_update({ text: "/dir ~/proj" });
  await channel._handle_text_message(update, _ctx());
  expect(db.get_setting("telegram_default_working_dir")).toBe("~/proj");
  expect(api.callsFor("sendMessage").length).toBe(1);
});

test("test_handle_text_message_agent_command", async () => {
  const { channel, db } = _make_channel();
  const update = _fake_update({ text: "/agent codex" });
  await channel._handle_text_message(update, _ctx());
  expect(db.get_setting("default_agent")).toBe("codex");
});

test("test_handle_text_message_creates_task", async () => {
  const { channel, scheduler } = _make_channel();
  _hooks.extract_working_dir_with_claude = async () => "~/app";
  const update = _fake_update({ text: "fix the bug" });
  await channel._handle_text_message(update, _ctx());
  expect(scheduler.submitted.length).toBe(1);
  const task = scheduler.submitted[0]!;
  expect(task.prompt).toBe("fix the bug");
  expect(task.title).toBe("[Telegram] fix the bug");
  expect(task.tags).toBe("telegram");
  expect(task.working_dir).toBe("~/app");
  expect(channel._task_origin.get(1)).toEqual([10, 100, 100]);
});

test("test_handle_text_message_resume_by_reply", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(5, { id: 5, status: "completed", session_id: "s5" });
  channel._notification_map.set(200, 5);
  const update = _fake_update({
    text: "continue",
    message_id: 300,
    reply: { message_id: 200 },
  });
  await channel._handle_text_message(update, _ctx());
  expect(db.updated[db.updated.length - 1]![0]).toBe(5);
  expect(db.updated[db.updated.length - 1]![1]["prompt"]).toBe("continue");
  expect(channel._task_origin.get(5)).toEqual([10, 300, 300]);
  expect(api.callsFor("setMessageReaction").length).toBeGreaterThan(0);
  expect(api.lastText()).toBe("▶️");
});

test("test_handle_text_message_resume_no_session", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(6, { id: 6, status: "completed" }); // no session_id
  channel._notification_map.set(201, 6);
  const update = _fake_update({ text: "continue", reply: { message_id: 201 } });
  await channel._handle_text_message(update, _ctx());
  expect(db.updated).toEqual([]);
  expect(api.lastText()).toContain("no saved session");
});

test("test_handle_text_message_reply_unknown_notification_creates_task", async () => {
  const { channel, scheduler } = _make_channel();
  const update = _fake_update({
    text: "new task",
    reply: { message_id: 12345 },
  }); // not in notification_map
  await channel._handle_text_message(update, _ctx());
  expect(scheduler.submitted.length).toBe(1);
});

test("test_create_task_forwarded_tags", async () => {
  const { channel, scheduler } = _make_channel();
  const update = _fake_update({ text: "forwarded body" });
  update.message.forward_date = 1700000000;
  await channel._create_task("forwarded body", 10, update);
  const task = scheduler.submitted[0]!;
  expect(task.tags).toContain("forwarded");
  expect(task.title.startsWith("[Telegram] 📨")).toBe(true);
});

// ── command handlers ─────────────────────────────────────────────

test("test_cmd_help_authorised_and_not", async () => {
  const { channel, api } = _make_channel({ allowed_users: [1] });
  const ok = _fake_update({ user_id: 1 });
  await channel._cmd_help(ok, _ctx());
  expect(api.callsFor("sendMessage").length).toBe(1);

  const denied = _fake_update({ user_id: 99 });
  await channel._cmd_help(denied, _ctx());
  expect(api.lastText()).toContain("not authorised");
});

test("test_cmd_status_usage_and_not_found", async () => {
  const { channel, api } = _make_channel();
  const u = _fake_update();
  await channel._cmd_status(u, _ctx([]));
  expect(api.lastText()).toContain("Usage");

  const u2 = _fake_update();
  await channel._cmd_status(u2, _ctx(["99"]));
  expect(api.lastText()).toContain("not found");
});

test("test_cmd_status_renders", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(7, {
    id: 7,
    title: "Build it",
    status: "completed",
    created_at: "2026-01-01T10:00:00",
    last_run_at: "2026-01-02T11:00:00",
    result: "green",
    error: null,
  });
  const u = _fake_update();
  await channel._cmd_status(u, _ctx(["#7"]));
  const text = api.lastText();
  expect(text).toContain("✅");
  expect(text).toContain("Task #7");
  expect(text).toContain("green");
});

test("test_cmd_status_unauthorised", async () => {
  const { channel, api } = _make_channel({ allowed_users: [1] });
  const u = _fake_update({ user_id: 2 });
  await channel._cmd_status(u, _ctx(["1"]));
  expect(api.lastText()).toContain("Not authorised");
});

test("test_cmd_cancel_paths", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(1, { id: 1, title: "t", status: "running" });
  db.tasks.set(2, { id: 2, title: "t", status: "completed" });

  await channel._cmd_cancel(_fake_update(), _ctx([]));
  expect(api.lastText()).toContain("Usage");

  await channel._cmd_cancel(_fake_update(), _ctx(["99"]));
  expect(api.lastText()).toContain("not found");

  await channel._cmd_cancel(_fake_update(), _ctx(["2"]));
  expect(api.lastText()).toContain("already");

  await channel._cmd_cancel(_fake_update(), _ctx(["1"]));
  expect(db.updated[db.updated.length - 1]).toEqual([
    1,
    { status: "cancelled" },
  ]);
  expect(api.lastText()).toContain("cancelled");
});

test("test_cmd_resume_paths", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(1, { id: 1, title: "t", status: "completed", session_id: "s1" });
  db.tasks.set(2, { id: 2, title: "t", status: "completed" });

  await channel._cmd_resume(_fake_update(), _ctx([]));
  expect(api.lastText()).toContain("Usage");

  await channel._cmd_resume(_fake_update(), _ctx(["1"]));
  expect(api.lastText()).toContain("provide a message");

  await channel._cmd_resume(_fake_update(), _ctx(["2", "go"]));
  expect(api.lastText()).toContain("no saved session");

  await channel._cmd_resume(
    _fake_update({ message_id: 555 }),
    _ctx(["#1", "keep", "going"]),
  );
  expect(db.updated[db.updated.length - 1]![0]).toBe(1);
  expect(db.updated[db.updated.length - 1]![1]["prompt"]).toBe("keep going");
  expect(channel._task_origin.get(1)).toEqual([10, 555, 555]);
  expect(api.lastText()).toBe("▶️");
});

test("test_cmd_resume_unauthorised", async () => {
  const { channel, api } = _make_channel({ allowed_users: [1] });
  const u = _fake_update({ user_id: 2 });
  await channel._cmd_resume(u, _ctx(["1", "x"]));
  expect(api.lastText()).toContain("Not authorised");
});

// ── outbound send ────────────────────────────────────────────────

function _patch_loop(channel: TelegramChannel): void {
  channel._ready = true; // ≙ channel._loop_ready.set()
  channel._running = true;
}

test("test_send_completion_to_origin", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(3, [10, 100, 100]);
  api.results.set("sendMessage", { message_id: 777 });

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 3,
      payload: { title: "Fix login", result: "done" },
    }),
  );

  expect(api.callsFor("sendMessage").length).toBe(1);
  const text = api.lastText();
  expect(text).toContain("✅ Task #3: Fix login");
  expect(text).toContain("done");
  expect(channel._notification_map.get(777)).toBe(3);
  expect(channel._task_origin.has(3)).toBe(false);
});

test("test_send_failure_to_origin", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(4, [10, 100, 100]);
  api.results.set("sendMessage", { message_id: 1 });

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_FAILED,
      task_id: 4,
      payload: { title: "Broke", error: "boom" },
    }),
  );

  const text = api.lastText();
  expect(text).toContain("❌ Task #4: Broke");
  expect(text).toContain("boom");
  expect(text).toContain("/status 4");
});

test("test_send_not_running_drops", async () => {
  const { channel, api } = _make_channel();
  channel._running = false;
  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 1,
      payload: {},
    }),
  );
  expect(api.calls.length).toBe(0);
});

test("test_send_ignores_non_terminal", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_STARTED,
      task_id: 1,
      payload: {},
    }),
  );
  expect(api.calls.length).toBe(0);
});

test("test_send_uses_default_chat_id", async () => {
  const { channel, api, db } = _make_channel();
  db.settings.set("telegram_default_chat_id", "-100123");
  _patch_loop(channel);
  api.results.set("sendMessage", { message_id: 2 });

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 8,
      payload: { title: "Job", result: "ok" },
    }),
  );

  const sends = api.callsFor("sendMessage");
  expect(sends.length).toBe(1);
  expect(sends[0]!.params["chat_id"]).toBe(-100123);
});

test("test_send_no_origin_no_default_skips", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  const log = captureLog();
  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 9,
        payload: { title: "Job", result: "ok" },
      }),
    );
  } finally {
    log.restore();
  }
  expect(api.calls.length).toBe(0);
});

test("test_send_truncates_long_result", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(10, [10, 100, 100]);
  api.results.set("sendMessage", { message_id: 3 });
  const long = "x".repeat(20000);

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 10,
      payload: { title: "Big", result: long },
    }),
  );

  expect(api.lastText()).toContain("(truncated)");
});

// ── lifecycle ────────────────────────────────────────────────────

test("test_start_without_telegram", () => {
  _set_telegram_available(false);
  const { channel } = _make_channel();
  const log = captureLog();
  try {
    channel.start();
  } finally {
    log.restore();
    _set_telegram_available(true);
  }
  expect(log.text()).toContain("not installed");
});
