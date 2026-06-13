// Ported from tests/test_telegram_more.py (bun:test).
//
// Additional Telegram channel coverage:
//   - the import-availability guard
//   - start()/_run_bot/_start_app bootstrap (SDK bootstrap → polling bootstrap)
//   - _send_text helper (success + failure)
//   - send() early-exit + reaction/send error branches and default-chat-id path
//   - _format_forwarded_text "unknown chat type" fallback
//   - reaction-failure print branches in resume/create
//   - command edge cases (status error-only render, cancel unauthorised,
//     resume reaction failure)
//
// Python's threading/event-loop assertions (run_coroutine_threadsafe call
// counts, loop.is_closed) map onto the TS port's _poll_promise/_ready seam.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import {
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
} from "../src/bus.ts";
import { _hooks } from "../src/channels/dir_utils.ts";
import {
  make_fetch_api,
  TELEGRAM_AVAILABLE,
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

  get_task_runs(_task_id: number, _limit?: number): unknown {
    return [];
  }

  get_run_output_events(_run_id: number, _limit?: number): unknown {
    return [];
  }
}

class StubScheduler {
  submitted: Task[] = [];

  submit_task(task: Task): number {
    this.submitted.push(task);
    return this.submitted.length;
  }
}

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

const _original_extract = _hooks.extract_working_dir_with_claude;
beforeEach(() => {
  _hooks.extract_working_dir_with_claude = async () => null;
});
afterEach(() => {
  _hooks.extract_working_dir_with_claude = _original_extract;
});

// ── import-availability guard ────────────────────────────────────

test("test_telegram_available_flag_is_boolean", () => {
  // The module imported fine; the flag reflects whether the transport is usable.
  expect(typeof TELEGRAM_AVAILABLE).toBe("boolean");
});

// ── stop() lifecycle ─────────────────────────────────────────────

test("test_stop_shuts_down_app_and_joins_thread", async () => {
  const { channel } = _make_channel();
  channel._running = true;
  // Real polling loop present → stop() must let it terminate (≙ thread join).
  let finished = false;
  channel._poll_promise = (async () => {
    while (channel._running) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    finished = true;
  })();

  const log = captureLog();
  try {
    channel.stop();
  } finally {
    log.restore();
  }
  await channel._poll_promise; // ≙ channel._thread.join()

  expect(channel._running).toBe(false);
  expect(finished).toBe(true);
  // Outbound subscription removed.
  const listeners = (
    channel.bus as unknown as { _outbound_listeners: unknown[] }
  )._outbound_listeners;
  expect(listeners.includes(channel._on_outbound)).toBe(false);
});

test("test_stop_without_loop_is_safe", () => {
  const { channel } = _make_channel();
  channel._poll_promise = null;
  channel._api = null;
  const log = captureLog();
  try {
    channel.stop(); // no polling loop running, nothing to join
  } finally {
    log.restore();
  }
  expect(channel._running).toBe(false);
});

// ── start() / _run_bot / _start_app bootstrap ────────────────────

test("test_start_spawns_thread_and_runs_loop", async () => {
  // Drive start() with _start_app stubbed so nothing connects. The real bot
  // loop would block; the stub returns at once and we await the poll promise
  // (≙ joining the thread) to confirm it finishes cleanly.
  const { channel } = _make_channel();

  const started: Record<string, boolean> = {};
  channel._start_app = async () => {
    // Mimic real _start_app: mark ready, then return at once (no polling).
    started["ran"] = true;
  };

  const log = captureLog();
  try {
    channel.start();
  } finally {
    log.restore();
  }
  expect(channel._running).toBe(true);
  expect(channel._poll_promise).not.toBeNull();
  await channel._poll_promise; // ≙ thread.join(timeout=5)
  expect(started["ran"]).toBe(true);
  // _run_bot marked the loop ready and completed without error.
  expect(channel._ready).toBe(true);
});

test("test_run_bot_handles_start_app_exception", async () => {
  const { channel } = _make_channel();

  channel._start_app = async () => {
    throw new Error("startup failed");
  };

  const log = captureLog();
  try {
    await channel._run_bot();
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("Bot error");
  // The loop completed (≙ channel._loop.is_closed() is True).
  expect(channel._ready).toBe(true);
});

test("test_start_app_builds_application_and_registers_handlers", async () => {
  // Exercise _start_app: drop pending updates, start polling, exit loop.
  const { channel, api } = _make_channel();
  // _running starts False so the `while self._running` loop is skipped and
  // _start_app proceeds straight past the polling bootstrap — no hang.
  channel._running = false;

  const log = captureLog();
  try {
    await channel._start_app();
  } finally {
    log.restore();
  }

  // drop_pending_updates=True ≙ one initial getUpdates backlog fetch.
  expect(api.callsFor("getUpdates").length).toBe(1);
  expect(log.text()).toContain("Bot polling started");
  // Handlers were registered (5 commands; the message handler is the
  // _handle_update text fallthrough).
  expect(Object.keys(channel._command_handlers).length).toBe(5);
});

test("test_poll_once_tls_errors_are_deduplicated_and_backed_off", async () => {
  const { channel, api } = _make_channel();
  const delays: number[] = [];
  (channel as unknown as { _sleep: (ms: number) => Promise<void> })._sleep =
    async (ms: number) => {
      delays.push(ms);
    };
  api.errors.set(
    "getUpdates",
    new Error("unknown certificate verification error"),
  );

  const log = captureLog();
  try {
    await channel._poll_once();
    await channel._poll_once();
  } finally {
    log.restore();
  }

  expect(delays).toEqual([1000, 2000]);
  const text = log.text();
  expect(text).toContain("TLS certificate verification failed");
  expect(text.match(/Polling error/g) ?? []).toHaveLength(1);
});

test("test_fetch_api_respects_telegram_tls_reject_unauthorized_override", async () => {
  const saved = process.env.AGENTFORGE_TELEGRAM_TLS_REJECT_UNAUTHORIZED;
  process.env.AGENTFORGE_TELEGRAM_TLS_REJECT_UNAUTHORIZED = "false";
  const originalFetch = globalThis.fetch;
  type FetchArgs = Parameters<typeof fetch>;
  const fetchCalls: FetchArgs[] = [];
  globalThis.fetch = (async (input: FetchArgs[0], init?: FetchArgs[1]) => {
    fetchCalls.push([input, init]);
    return new Response(JSON.stringify({ ok: true, result: [] }));
  }) as typeof fetch;
  try {
    await make_fetch_api("123:ABC")("getUpdates", { timeout: 0 });
  } finally {
    globalThis.fetch = originalFetch;
    if (saved === undefined) {
      delete process.env.AGENTFORGE_TELEGRAM_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.AGENTFORGE_TELEGRAM_TLS_REJECT_UNAUTHORIZED = saved;
    }
  }

  expect(fetchCalls).toHaveLength(1);
  const init = fetchCalls[0]![1] as RequestInit & {
    tls?: { rejectUnauthorized?: boolean };
  };
  expect(init.tls?.rejectUnauthorized).toBe(false);
});

// ── _send_text helper ────────────────────────────────────────────

test("test_send_text_success", async () => {
  const { channel, api } = _make_channel();
  await channel._send_text(42, "hi there");
  const sends = api.callsFor("sendMessage");
  expect(sends.length).toBe(1);
  expect(sends[0]!.params).toEqual({ chat_id: 42, text: "hi there" });
});

test("test_send_text_logs_failure", async () => {
  const { channel, api } = _make_channel();
  api.errors.set("sendMessage", new Error("network"));
  const log = captureLog();
  try {
    await channel._send_text(42, "hi");
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("Failed to send message to 42");
});

// ── send() early-exit branches ───────────────────────────────────

test("test_send_drops_when_loop_not_ready", async () => {
  const { channel, api } = _make_channel();
  channel._running = true;
  // _ready never set → send() drops the message immediately.
  const log = captureLog();
  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 1,
        payload: {},
      }),
    );
  } finally {
    log.restore();
  }
  expect(api.calls.length).toBe(0);
  expect(log.text()).toContain("before event loop ready");
});

test("test_send_drops_when_app_or_loop_missing", async () => {
  const { channel, api } = _make_channel();
  channel._running = true;
  channel._ready = true;
  channel._api = null; // ≙ channel._app = None
  await channel.send(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 1,
      payload: {},
    }),
  );
  expect(api.calls.length).toBe(0);
});

// ── send() coroutine body: reaction + truncation + reaction failure ──

function _patch_loop(channel: TelegramChannel): void {
  channel._ready = true;
  channel._running = true;
}

test("test_send_completion_reaction_failure_still_sends", async () => {
  // When setMessageReaction rejects, the except branch logs and sending the
  // message proceeds.
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(5, [10, 100, 100]);

  api.errors.set("setMessageReaction", new Error("no react"));
  api.results.set("sendMessage", { message_id: 900 });

  const log = captureLog();
  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 5,
        payload: { title: "Job", result: "done" },
      }),
    );
  } finally {
    log.restore();
  }

  expect(log.text()).toContain("Failed to set reaction on message 100");
  expect(api.callsFor("sendMessage").length).toBe(1);
  expect(api.callsFor("sendMessage")[0]!.params).not.toHaveProperty(
    "reply_to_message_id",
  );
});

test("test_send_failure_default_chat_hides_task_label", async () => {
  // Default-chat-id failure path covers the no-origin branch and error body.
  const { channel, api, db } = _make_channel();
  db.settings.set("telegram_default_chat_id", "-100777");
  _patch_loop(channel);
  api.results.set("sendMessage", { message_id: 2 });

  const log = captureLog();
  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_FAILED,
        task_id: 8,
        payload: { title: "Broke", error: "x".repeat(1500) },
      }),
    );
  } finally {
    log.restore();
  }

  const text = api.lastText();
  expect(text).not.toContain("Task #");
  expect(text).not.toContain("Broke");
  expect(text).toContain("truncated"); // error > 800 → smart truncation
  expect(text).not.toContain("/status");
});

test("test_send_coroutine_swallows_send_failure", async () => {
  const { channel, api } = _make_channel();
  _patch_loop(channel);
  channel._task_origin.set(9, [10, 100, 100]);

  api.errors.set("sendMessage", new Error("send down"));

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
  expect(log.text()).toContain("Failed to send notification");
});

test("test_send_default_chat_id_non_numeric_string", async () => {
  const { channel, api, db } = _make_channel();
  db.settings.set("telegram_default_chat_id", "@mychannel");
  _patch_loop(channel);
  api.results.set("sendMessage", { message_id: 3 });

  const log = captureLog();
  try {
    await channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_COMPLETED,
        task_id: 11,
        payload: { title: "Job", result: "ok" },
      }),
    );
  } finally {
    log.restore();
  }
  // Non-numeric chat id stays a string (not int-cast).
  const sends = api.callsFor("sendMessage");
  expect(sends[sends.length - 1]!.params["chat_id"]).toBe("@mychannel");
});

// ── _format_forwarded_text unknown chat type ─────────────────────

test("test_format_forwarded_from_unknown_chat_type", () => {
  const { channel } = _make_channel();
  const update = _fake_update();
  update.message.forward_date = 1700000000;
  update.message.forward_from_chat = {
    id: -1,
    title: "Mystery",
    username: null,
    type: "private",
  };
  const out = channel._format_forwarded_text("body", update);
  // type not channel/group/supergroup → generic "转发自:" line.
  expect(out).toContain("转发自: Mystery");
});

// ── current-session resume reaction failure branch ───────────────

test("test_current_session_resume_reaction_failure_logged", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(5, { id: 5, status: "completed", session_id: "s5" });
  channel._set_chat_current_task(10, 5);
  api.errors.set("setMessageReaction", new Error("no react"));
  const update = _fake_update({
    text: "continue",
    message_id: 300,
    reply: { message_id: 200 },
  });

  const log = captureLog();
  try {
    await channel._handle_text_message(update, _ctx());
  } finally {
    log.restore();
  }

  expect(db.updated[db.updated.length - 1]![0]).toBe(5);
  expect(log.text()).toContain("Failed to set resume reaction");
  expect(api.callsFor("sendMessage").length).toBe(0);
});

// ── _create_task react coroutine ─────────────────────────────────

test("test_create_task_react_coroutine_runs", async () => {
  const { channel, api } = _make_channel();
  const update = _fake_update({
    text: "build it",
    chat_id: 10,
    message_id: 100,
  });

  const log = captureLog();
  try {
    await channel._create_task("build it", 10, update);
  } finally {
    log.restore();
  }

  expect(api.callsFor("setMessageReaction").length).toBe(1);
  expect(api.callsFor("sendMessage").length).toBe(0);
});

test("test_create_task_react_coroutine_logs_failure", async () => {
  const { channel, api } = _make_channel();
  const update = _fake_update({ text: "build it" });
  api.errors.set("setMessageReaction", new Error("nope"));

  const log = captureLog();
  try {
    await channel._create_task("build it", 10, update);
  } finally {
    log.restore();
  }
  expect(log.text()).toContain("Failed to set reaction");
});

// ── _cmd_status error-only render ────────────────────────────────

test("test_cmd_status_renders_error_only", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(7, {
    id: 7,
    title: "Broke",
    status: "failed",
    created_at: "2026-01-01T10:00:00",
    last_run_at: null,
    error: "stack trace",
    result: null,
  });
  const u = _fake_update();
  await channel._cmd_status(u, _ctx(["7"]));
  const text = api.lastText();
  expect(text).toContain("Error: stack trace");
  expect(text).not.toContain("Result:");
});

// ── _cmd_cancel unauthorised ─────────────────────────────────────

test("test_cmd_cancel_unauthorised", async () => {
  const { channel, api } = _make_channel({ allowed_users: [1] });
  const u = _fake_update({ user_id: 2 });
  await channel._cmd_cancel(u, _ctx(["1"]));
  expect(api.lastText()).toContain("Not authorised");
});

// ── _cmd_resume reaction failure branch ──────────────────────────

test("test_cmd_resume_reaction_failure_logged", async () => {
  const { channel, api, db } = _make_channel();
  db.tasks.set(1, { id: 1, title: "t", status: "completed", session_id: "s1" });
  api.errors.set("setMessageReaction", new Error("no react"));
  const u = _fake_update({ message_id: 555 });

  const log = captureLog();
  try {
    await channel._cmd_resume(u, _ctx(["#1", "keep", "going"]));
  } finally {
    log.restore();
  }

  expect(db.updated[db.updated.length - 1]![0]).toBe(1);
  expect(db.updated[db.updated.length - 1]![1]["prompt"]).toBe("keep going");
  expect(log.text()).toContain("Failed to set resume reaction");
  expect(api.callsFor("sendMessage").length).toBe(0);
});
