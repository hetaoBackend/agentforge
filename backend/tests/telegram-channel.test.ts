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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  InboundMessageType,
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
  type InboundMessage,
} from "../src/bus.ts";
import { _hooks } from "../src/channels/dir_utils.ts";
import {
  _escape_md,
  _set_telegram_available,
  create_telegram_channel,
  TelegramChannel,
  type OutputListener,
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
  runs: unknown = [];
  events: unknown = [];

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

  get_task_runs(_task_id: number, _limit?: number): unknown {
    return this.runs;
  }

  get_run_output_events(_run_id: number, _limit?: number): unknown {
    return this.events;
  }
}

class StubScheduler {
  submitted: Task[] = [];
  inbound: InboundMessage[] = [];
  listeners: OutputListener[] = [];
  removed: OutputListener[] = [];
  nextBriefId = 1;

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }

  handle_inbound_message(msg: InboundMessage): Record<string, unknown> {
    this.inbound.push(msg);
    if (msg.type === InboundMessageType.CREATE_BRIEF) {
      return { brief_id: this.nextBriefId++, status: "draft" };
    }
    if (msg.type === InboundMessageType.CONFIRM_BRIEF) {
      return { task_id: this.submitted.length + 1, status: "created" };
    }
    if (msg.type === InboundMessageType.DISCARD_BRIEF) {
      return { brief_id: msg.payload["brief_id"], status: "discarded" };
    }
    if (msg.type === InboundMessageType.RUN_RUNBOOK) {
      if (msg.payload["name"] === "release-check") {
        return {
          brief_id: this.nextBriefId++,
          runbook: msg.payload["name"],
          status: "draft",
        };
      }
      return {
        runbook: msg.payload["name"],
        status: "created",
        task_id: this.submitted.length + 1,
      };
    }
    if (msg.type === InboundMessageType.SKILL_SUGGESTION_ACTION) {
      const action = String(msg.payload["action"]);
      if (action === "show") {
        return {
          pattern_id: msg.payload["pattern_id"],
          status: "ready",
          text: "Skill suggestion: fix-ci-investigation\n\nDraft preview:\n# Fix CI",
        };
      }
      return {
        pattern_id: msg.payload["pattern_id"],
        status:
          action === "draft"
            ? "drafting"
            : action === "approve"
              ? "approved"
              : "dismissed",
      };
    }
    return { status: "ignored" };
  }

  add_output_listener(cb: OutputListener): void {
    this.listeners.push(cb);
  }

  remove_output_listener(cb: OutputListener): void {
    this.removed.push(cb);
    this.listeners = this.listeners.filter((listener) => listener !== cb);
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
    if (method === "sendMessage") {
      return { message_id: 1000 + this.calls.length };
    }
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
  const { channel, api, scheduler } = _make_channel();
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
  expect(api.callsFor("sendMessage").length).toBe(1);
  expect(api.callsFor("sendMessage")[0]!.params["chat_id"]).toBe(10);
  expect(api.callsFor("sendMessage")[0]!.params).not.toHaveProperty(
    "reply_to_message_id",
  );
  expect(api.lastText()).toContain("Thinking");
  expect(scheduler.listeners).toHaveLength(1);
});

test("test_brief_command_creates_draft_without_submitting_task", async () => {
  const { channel, api, db, scheduler } = _make_channel();
  _hooks.extract_working_dir_with_claude = async () => "~/repo";
  db.settings.set("default_agent", "codex");
  db.tasks.set(5, { id: 5, status: "completed", session_id: "s5" });
  channel._set_chat_current_task(10, 5);

  await channel._handle_text_message(
    _fake_update({
      text: "/brief fix the login redirect",
      chat_id: 10,
      message_id: 222,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.submitted).toHaveLength(0);
  expect(db.updated).toEqual([]);
  expect(scheduler.inbound).toHaveLength(1);
  expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.CREATE_BRIEF);
  expect(scheduler.inbound[0]!.payload["goal"]).toBe("fix the login redirect");
  expect(scheduler.inbound[0]!.payload["working_dir"]).toBe("~/repo");
  expect(scheduler.inbound[0]!.payload["source_ref"]).toBe("10:222");
  expect(scheduler.inbound[0]!.payload["source_metadata"]).toEqual({
    chat_id: 10,
    message_id: 222,
    user_id: 7,
  });
  expect(api.lastText()).toContain("Draft task brief #1");
  expect(api.lastText()).toContain("/confirm-brief 1");
  expect(scheduler.listeners).toHaveLength(0);
});

test("test_confirm_and_discard_brief_commands_use_text_fallback", async () => {
  const { channel, api, scheduler } = _make_channel();

  await channel._handle_text_message(
    _fake_update({
      text: "/confirm-brief 4",
      chat_id: 10,
      message_id: 333,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.CONFIRM_BRIEF);
  expect(scheduler.inbound[0]!.payload["brief_id"]).toBe(4);
  expect(channel._task_origin.get(1)).toEqual([10, 333, 333]);
  expect(channel._get_chat_current_task(10)).toBe(1);
  expect(channel.bus.get_task_source(1)).toBe("telegram");
  expect(api.lastText()).toContain("Task #1");
  expect(api.lastText()).toContain("Thinking");
  expect(scheduler.listeners).toHaveLength(1);

  await channel._handle_text_message(
    _fake_update({
      text: "/discard-brief #4",
      chat_id: 10,
      message_id: 334,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.inbound[1]!.type).toBe(InboundMessageType.DISCARD_BRIEF);
  expect(scheduler.inbound[1]!.payload["brief_id"]).toBe(4);
  expect(api.lastText()).toContain("discarded");
});

test("test_runbook_commands_use_text_fallback", async () => {
  const { channel, api, scheduler } = _make_channel();
  _hooks.extract_working_dir_with_claude = async () => "~/repo";

  await channel._handle_text_message(
    _fake_update({
      text: "/review-pr https://github.com/acme/app/pull/42",
      chat_id: 10,
      message_id: 335,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.inbound[0]!.type).toBe(InboundMessageType.RUN_RUNBOOK);
  expect(scheduler.inbound[0]!.payload["name"]).toBe("review-pr");
  expect(scheduler.inbound[0]!.payload["raw_args"]).toBe(
    "https://github.com/acme/app/pull/42",
  );
  expect(scheduler.inbound[0]!.payload["working_dir"]).toBe("~/repo");
  expect(channel._task_origin.get(1)).toEqual([10, 335, 335]);
  expect(channel._get_chat_current_task(10)).toBe(1);
  expect(channel.bus.get_task_source(1)).toBe("telegram");
  expect(api.lastText()).toContain("Runbook /review-pr");
  expect(api.lastText()).toContain("Task #1");
  expect(scheduler.listeners).toHaveLength(1);

  await channel._handle_text_message(
    _fake_update({
      text: "/release-check",
      chat_id: 10,
      message_id: 336,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.inbound[1]!.type).toBe(InboundMessageType.RUN_RUNBOOK);
  expect(scheduler.inbound[1]!.payload["name"]).toBe("release-check");
  expect(api.lastText()).toContain("Draft task brief #1");
  expect(api.lastText()).toContain("/confirm-brief 1");
});

test("test_skill_suggestion_commands_use_text_fallback", async () => {
  const { channel, api, scheduler } = _make_channel();

  await channel._handle_text_message(
    _fake_update({
      text: "/draft-skill 4",
      chat_id: 10,
      message_id: 337,
      user_id: 7,
    }),
    _ctx(),
  );

  expect(scheduler.inbound[0]!.type).toBe(
    InboundMessageType.SKILL_SUGGESTION_ACTION,
  );
  expect(scheduler.inbound[0]!.payload["action"]).toBe("draft");
  expect(scheduler.inbound[0]!.payload["pattern_id"]).toBe(4);
  expect(scheduler.inbound[0]!.payload["source_channel"]).toBe("telegram");
  expect(scheduler.inbound[0]!.payload["target"]).toBe("10");
  expect(api.lastText()).toContain("Skill draft");

  await channel._handle_text_message(
    _fake_update({ text: "/show-skill #4", chat_id: 10, message_id: 338 }),
    _ctx(),
  );
  expect(scheduler.inbound[1]!.payload["action"]).toBe("show");
  expect(api.lastText()).toContain("Draft preview");

  await channel._handle_text_message(
    _fake_update({ text: "/approve-skill 4", chat_id: 10, message_id: 339 }),
    _ctx(),
  );
  expect(scheduler.inbound[2]!.payload["action"]).toBe("approve");
  expect(api.lastText()).toContain("approved");

  await channel._handle_text_message(
    _fake_update({ text: "/dismiss-skill 4", chat_id: 10, message_id: 340 }),
    _ctx(),
  );
  expect(scheduler.inbound[3]!.payload["action"]).toBe("dismiss");
  expect(api.lastText()).toContain("dismissed");
});

test("test_handle_text_message_resumes_current_chat_session", async () => {
  const { channel, api, db, scheduler } = _make_channel();

  await channel._handle_text_message(
    _fake_update({ text: "first", chat_id: 10, message_id: 100 }),
    _ctx(),
  );
  db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });
  await channel._handle_text_message(
    _fake_update({ text: "follow up", chat_id: 10, message_id: 101 }),
    _ctx(),
  );

  expect(scheduler.submitted.length).toBe(1);
  expect(db.updated.at(-1)).toEqual([
    1,
    {
      status: "pending",
      prompt: "follow up",
      result: null,
      error: null,
      question: null,
    },
  ]);
  expect(channel._task_origin.get(1)).toEqual([10, 101, 101]);
  expect(api.callsFor("sendMessage").length).toBe(2);
  expect(api.callsFor("sendMessage")[1]!.params["chat_id"]).toBe(10);
  expect(api.callsFor("sendMessage")[1]!.params).not.toHaveProperty(
    "reply_to_message_id",
  );
});

test("test_handle_text_message_resumes_persisted_chat_session_after_restart", async () => {
  const db = new StubDB();
  const firstScheduler = new StubScheduler();
  const { channel } = _make_channel({ db, scheduler: firstScheduler });

  await channel._handle_text_message(
    _fake_update({ text: "first", chat_id: 10, message_id: 100 }),
    _ctx(),
  );
  db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });

  const restartedScheduler = new StubScheduler();
  const { channel: restarted } = _make_channel({
    db,
    scheduler: restartedScheduler,
  });
  await restarted._handle_text_message(
    _fake_update({ text: "after restart", chat_id: 10, message_id: 101 }),
    _ctx(),
  );

  expect(restartedScheduler.submitted.length).toBe(0);
  expect(db.updated.at(-1)).toEqual([
    1,
    {
      status: "pending",
      prompt: "after restart",
      result: null,
      error: null,
      question: null,
    },
  ]);
  expect(restarted._task_origin.get(1)).toEqual([10, 101, 101]);
  expect(restartedScheduler.listeners).toHaveLength(1);
});

test("test_handle_text_message_new_command_starts_new_chat_session", async () => {
  const { channel, db, scheduler } = _make_channel();

  await channel._handle_text_message(
    _fake_update({ text: "first", chat_id: 10, message_id: 100 }),
    _ctx(),
  );
  db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });
  await channel._handle_text_message(
    _fake_update({ text: "/new fresh start", chat_id: 10, message_id: 101 }),
    _ctx(),
  );

  expect(scheduler.submitted.length).toBe(2);
  expect(scheduler.submitted[1]!.prompt).toBe("fresh start");
  expect(channel._task_origin.get(2)).toEqual([10, 101, 101]);
});

test("test_handle_text_message_reply_does_not_switch_chat_session", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(1, { id: 1, status: "completed", session_id: "s1" });
  db.tasks.set(5, { id: 5, status: "completed", session_id: "s5" });
  channel._set_chat_current_task(10, 1);
  const update = _fake_update({
    text: "continue",
    message_id: 300,
    reply: { message_id: 200 },
  });
  await channel._handle_text_message(update, _ctx());
  expect(db.updated[db.updated.length - 1]![0]).toBe(1);
  expect(db.updated[db.updated.length - 1]![1]["prompt"]).toBe("continue");
  expect(channel._task_origin.get(1)).toEqual([10, 300, 300]);
  expect(api.callsFor("setMessageReaction").length).toBeGreaterThan(0);
  expect(api.callsFor("sendMessage").length).toBe(1);
});

test("test_handle_text_message_reply_without_current_session_creates_task", async () => {
  const { channel, api, db, scheduler } = _make_channel();
  db.tasks.set(6, { id: 6, status: "completed" }); // no session_id
  const update = _fake_update({ text: "continue", reply: { message_id: 201 } });
  await channel._handle_text_message(update, _ctx());
  expect(db.updated).toEqual([]);
  expect(scheduler.submitted).toHaveLength(1);
  expect(scheduler.submitted[0]!.prompt).toBe("continue");
  expect(api.callsFor("setMessageReaction").length).toBe(1);
  expect(api.callsFor("sendMessage").length).toBe(1);
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

test("test_streams_only_assistant_text_into_thinking_message", async () => {
  const { channel, api, scheduler } = _make_channel();
  _patch_loop(channel);
  api.results.set("sendMessage", { message_id: 700 });

  await channel._handle_text_message(
    _fake_update({ text: "stream this", chat_id: 10, message_id: 100 }),
    _ctx(),
  );

  const runningMessage = api.callsFor("sendMessage")[0]!;
  expect(runningMessage.params).not.toHaveProperty("reply_to_message_id");
  expect(scheduler.listeners).toHaveLength(1);
  expect(api.callsFor("editMessageText")).toHaveLength(0);

  scheduler.listeners[0]!(1, 9, "tool_call", JSON.stringify({ name: "rg" }));
  expect(api.callsFor("editMessageText")).toHaveLength(0);

  scheduler.listeners[0]!(1, 9, "assistant", "hello");
  await new Promise((resolve) => setTimeout(resolve, 0));

  let edits = api.callsFor("editMessageText");
  expect(edits).toHaveLength(1);
  expect(edits[0]!.params["chat_id"]).toBe(10);
  expect(edits[0]!.params["message_id"]).toBe(700);
  expect(edits[0]!.params["text"]).toBe("hello");
  expect(edits[0]!.params["parse_mode"]).toBe("HTML");

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 1,
      payload: { title: "stream this", result: "done" },
    }),
  );

  edits = api.callsFor("editMessageText");
  const finalEdits = edits;
  expect(finalEdits).toHaveLength(2);
  expect(finalEdits.at(-1)!.params["message_id"]).toBe(700);
  expect(finalEdits.at(-1)!.params["text"]).toBe("done");
  expect(finalEdits.at(-1)!.params["parse_mode"]).toBe("HTML");
  expect(api.callsFor("sendMessage")).toHaveLength(1);
  expect(scheduler.removed).toHaveLength(1);
  expect(channel._task_origin.has(1)).toBe(false);
});

// ── command handlers ─────────────────────────────────────────────

test("test_cmd_help_authorised_and_not", async () => {
  const { channel, api } = _make_channel({ allowed_users: [1] });
  const ok = _fake_update({ user_id: 1 });
  await channel._cmd_help(ok, _ctx());
  expect(api.lastText()).not.toContain("task");
  expect(api.lastText()).toContain("/new");
  expect(api.lastText()).not.toContain("\\.");
  expect(api.lastText()).toContain("current session");
  expect(api.callsFor("sendMessage").length).toBe(1);
  expect(api.callsFor("sendMessage")[0]!.params).not.toHaveProperty(
    "parse_mode",
  );

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

  const replies_before_success = api.callsFor("sendMessage").length;
  await channel._cmd_resume(
    _fake_update({ message_id: 555 }),
    _ctx(["#1", "keep", "going"]),
  );
  expect(db.updated[db.updated.length - 1]![0]).toBe(1);
  expect(db.updated[db.updated.length - 1]![1]["prompt"]).toBe("keep going");
  expect(channel._task_origin.get(1)).toEqual([10, 555, 555]);
  expect(api.callsFor("sendMessage").length).toBe(replies_before_success + 1);
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
  expect(text).not.toContain("Task #");
  expect(text).not.toContain("[Telegram]");
  expect(text).not.toContain("Fix login");
  expect(text).toContain("done");
  expect(text).not.toStartWith("✅");
  expect(api.callsFor("sendMessage")[0]!.params).not.toHaveProperty(
    "reply_to_message_id",
  );
  expect(channel._task_origin.has(3)).toBe(false);
});

test("test_send_completion_renders_markdown_as_telegram_html", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(30, [10, 100, 100]);

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 30,
      payload: {
        title: "Render",
        result: "**Done**\n\n```ts\nconst ok = 1 < 2;\n```",
      },
    }),
  );

  const params = api.callsFor("sendMessage")[0]!.params;
  expect(params["parse_mode"]).toBe("HTML");
  expect(params["text"]).toContain("<b>Done</b>");
  expect(params["text"]).toContain(
    '<pre><code class="language-ts">const ok = 1 &lt; 2;</code></pre>',
  );
});

test("test_send_completion_sends_generated_images_as_photos", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentforge-tg-"));
  const image = path.join(tmpDir, "generated.png");
  fs.writeFileSync(
    image,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const { channel, api, db } = _make_channel();
  _patch_loop(channel);
  db.tasks.set(32, { id: 32, title: "Render", working_dir: tmpDir });
  db.runs = [{ id: 320 }];
  db.events = [
    { event_type: "generated_image", content: "{bad json" },
    {
      event_type: "generated_image",
      content: JSON.stringify({ path: image }),
    },
  ];
  channel._task_origin.set(32, [10, 100, 100]);

  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 32,
        payload: {
          title: "Render",
          result: `Done\n- ${image}\n![out](generated.png)`,
        },
      }),
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const send = api.callsFor("sendMessage")[0]!;
  expect(send.params["chat_id"]).toBe(10);
  expect(send.params["text"]).toContain("Done");
  expect(String(send.params["text"])).not.toContain(image);
  expect(String(send.params["text"])).not.toContain("generated.png");
  expect(String(send.params["text"])).not.toStartWith("✅");

  const photos = api.callsFor("sendPhoto");
  expect(photos).toHaveLength(1);
  expect(photos[0]!.params["chat_id"]).toBe(10);
  expect(photos[0]!.params["photo"]).toBeInstanceOf(Blob);
});

test("test_send_completion_escapes_html_when_rendering_markdown", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(31, [10, 100, 100]);

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 31,
      payload: { title: "Render", result: "**1 < 2 & 3 > 2**" },
    }),
  );

  const params = api.callsFor("sendMessage")[0]!.params;
  expect(params["parse_mode"]).toBe("HTML");
  expect(params["text"]).toBe("<b>1 &lt; 2 &amp; 3 &gt; 2</b>");
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
  expect(text).not.toContain("Task #");
  expect(text).not.toContain("Broke");
  expect(text).toContain("boom");
  expect(text).not.toContain("/status");
  expect(api.callsFor("sendMessage")[0]!.params).not.toHaveProperty(
    "reply_to_message_id",
  );
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
  expect(String(sends[0]!.params["text"])).not.toStartWith("✅");
  expect(sends[0]!.params["text"]).toBe("ok");
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

test("test_send_splits_long_result", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(10, [10, 100, 100]);
  const long = "x".repeat(8500);

  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 10,
      payload: { title: "Big", result: long },
    }),
  );

  const sends = api.callsFor("sendMessage");
  expect(sends.length).toBeGreaterThan(1);
  for (const send of sends) {
    expect(String(send.params["text"]).length).toBeLessThanOrEqual(4096);
  }
  expect(sends.map((send) => send.params["text"]).join("")).toBe(long);
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
  expect(log.text()).toContain("Telegram Bot API transport unavailable");
});
