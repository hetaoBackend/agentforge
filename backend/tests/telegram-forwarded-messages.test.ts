// Ported from tests/test_telegram_forwarded_messages.py (bun:test).
//
// Tests for Telegram forwarded message handling functionality.
//
// The pytest file built MockUser/MockChat/MockMessage dataclasses mimicking
// python-telegram-bot objects; here the equivalents are plain Bot-API-shaped
// JSON objects. Where Python patched the Task class to inspect constructor
// kwargs, the TS port asserts on the Task object handed to the scheduler stub.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MessageBus } from "../src/bus.ts";
import { _hooks } from "../src/channels/dir_utils.ts";
import {
  TelegramChannel,
  type TelegramApi,
  type TgChat,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "../src/channels/telegram.ts";
import type { Task } from "../src/types.ts";

// ── stubs ────────────────────────────────────────────────────────

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

const silentApi: TelegramApi = async () => null;

/** ≙ the mock_telegram_channel pytest fixture. */
function mock_telegram_channel() {
  const db = new StubDB();
  const scheduler = new StubScheduler();
  const channel = new TelegramChannel(
    new MessageBus(),
    db,
    scheduler,
    "fake_token",
    null,
  );
  // Mock the app and loop (≙ channel._app / channel._loop / _loop_ready mocks).
  channel._api = silentApi;
  channel._ready = true;
  return { channel, db, scheduler };
}

// ── Mock Telegram objects (≙ MockUser / MockChat / MockMessage) ──

function MockUser(o: {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}): TgUser {
  return {
    id: o.id,
    first_name: o.first_name,
    last_name: o.last_name ?? "",
    username: o.username ?? "",
  };
}

function MockChat(o: {
  id: number;
  type?: string;
  title?: string;
  username?: string;
}): TgChat {
  return {
    id: o.id,
    type: o.type ?? "private",
    title: o.title ?? "",
    username: o.username ?? "",
  };
}

function MockMessage(o: {
  message_id: number;
  text: string;
  from_user: TgUser;
  chat: TgChat;
  forward_from?: TgUser | null;
  forward_from_chat?: TgChat | null;
  forward_date?: number | null;
}): TgMessage {
  return {
    message_id: o.message_id,
    text: o.text,
    from: o.from_user,
    chat: o.chat,
    forward_from: o.forward_from ?? null,
    forward_from_chat: o.forward_from_chat ?? null,
    forward_date: o.forward_date ?? null,
    reply_to_message: null,
  };
}

function makeUpdate(message: TgMessage): TgUpdate & { message: TgMessage } {
  return { message };
}

// Keep resolve_working_dir off the network (≙ db.get_setting.return_value = "~").
const _original_extract = _hooks.extract_working_dir_with_claude;
beforeEach(() => {
  _hooks.extract_working_dir_with_claude = async () => null;
});
afterEach(() => {
  _hooks.extract_working_dir_with_claude = _original_extract;
});

// ── Test detection of forwarded messages in Telegram updates ────

describe("TestTelegramForwardMessageDetection", () => {
  test("test_format_forwarded_text_from_user", () => {
    // Test formatting a message forwarded from a user.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({
      id: 12345,
      first_name: "Alice",
      last_name: "Smith",
      username: "alice_smith",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Original message content",
      from_user: MockUser({ id: 999, first_name: "Bob" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text(
      "Original message content",
      makeUpdate(message),
    );

    expect(result).toContain("📨 [转发消息]");
    expect(result).toContain("转发自: @alice_smith");
    expect(result).toContain("时间: 2025-01-29 00:00");
    expect(result).toContain("--- 转发内容 ---");
    expect(result).toContain("Original message content");
  });

  test("test_format_forwarded_text_from_user_no_username", () => {
    // Test formatting when forwarded user has no username.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({
      id: 12345,
      first_name: "张三",
      last_name: "李四",
      username: "",
    });

    const message = MockMessage({
      message_id: 100,
      text: "测试消息",
      from_user: MockUser({ id: 999, first_name: "王五" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text(
      "测试消息",
      makeUpdate(message),
    );

    expect(result).toContain("转发自: 张三 李四");
  });

  test("test_format_forwarded_text_from_user_only_firstname", () => {
    // Test formatting when forwarded user has only first name.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({
      id: 12345,
      first_name: "Charlie",
      last_name: "",
      username: "",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Message",
      from_user: MockUser({ id: 999, first_name: "Dave" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text(
      "Message",
      makeUpdate(message),
    );

    expect(result).toContain("转发自: Charlie");
  });

  test("test_format_forwarded_text_from_channel", () => {
    // Test formatting a message forwarded from a channel.
    const { channel } = mock_telegram_channel();
    const forward_chat = MockChat({
      id: -100123456789,
      type: "channel",
      title: "Tech News",
      username: "technews",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Breaking news: API update",
      from_user: MockUser({ id: 999, first_name: "Reader" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from_chat: forward_chat,
      forward_date: 1738083600,
    });

    const result = channel._format_forwarded_text(
      "Breaking news: API update",
      makeUpdate(message),
    );

    expect(result).toContain("📨 [转发消息]");
    expect(result).toContain("转发自频道: Tech News");
  });

  test("test_format_forwarded_text_from_group", () => {
    // Test formatting a message forwarded from a group.
    const { channel } = mock_telegram_channel();
    const forward_chat = MockChat({
      id: -100987654321,
      type: "supergroup",
      title: "Python Developers",
      username: "",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Check this code snippet",
      from_user: MockUser({ id: 999, first_name: "Dev" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from_chat: forward_chat,
      forward_date: 1738087200,
    });

    const result = channel._format_forwarded_text(
      "Check this code snippet",
      makeUpdate(message),
    );

    expect(result).toContain("转发自群组: Python Developers");
  });

  test("test_format_forwarded_text_from_chat_no_title", () => {
    // Test formatting when forwarded chat has no title.
    const { channel } = mock_telegram_channel();
    const forward_chat = MockChat({
      id: -100111222333,
      type: "group",
      title: "",
      username: "unknown_group",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Message",
      from_user: MockUser({ id: 999, first_name: "User" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from_chat: forward_chat,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text(
      "Message",
      makeUpdate(message),
    );

    expect(result).toContain("转发自群组: unknown_group");
  });

  test("test_format_forwarded_text_no_timestamp", () => {
    // Test formatting when forward_date is missing.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({ id: 12345, first_name: "Sender" });

    const message = MockMessage({
      message_id: 100,
      text: "Message",
      from_user: MockUser({ id: 999, first_name: "User" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: null,
    });

    const result = channel._format_forwarded_text(
      "Message",
      makeUpdate(message),
    );

    expect(result).toContain("📨 [转发消息]");
    expect(result).toContain("转发自:");
    // Should not have time component
    expect(result).not.toContain("时间:");
  });

  test("test_format_forwarded_text_not_forwarded", () => {
    // Test that regular messages are unchanged.
    const { channel } = mock_telegram_channel();
    const message = MockMessage({
      message_id: 100,
      text: "Regular message",
      from_user: MockUser({ id: 999, first_name: "User" }),
      chat: MockChat({ id: 888, type: "private" }),
    });

    const result = channel._format_forwarded_text(
      "Regular message",
      makeUpdate(message),
    );

    expect(result).toBe("Regular message");
    expect(result).not.toContain("转发");
  });

  test("test_format_forwarded_text_fallback_to_generic_sender", () => {
    // Test formatting when forwarded info is incomplete.
    const { channel } = mock_telegram_channel();
    const message = MockMessage({
      message_id: 100,
      text: "Message",
      from_user: MockUser({ id: 999, first_name: "User" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: null,
      forward_from_chat: null,
      forward_date: 1738080000,
    });

    // The message has forward_date but no forward_from or forward_from_chat.
    // This is technically possible in Telegram API.
    const result = channel._format_forwarded_text(
      "Message",
      makeUpdate(message),
    );

    // Should still show it's forwarded with timestamp
    expect(result).toContain("📨 [转发消息]");
    expect(result).toContain("时间: 2025-01-29 00:00");
  });
});

// ── Test task creation from forwarded messages ───────────────────

describe("TestTelegramForwardedTaskCreation", () => {
  test("test_create_task_from_forwarded_message", async () => {
    // Test that forwarded messages create tasks with appropriate tags.
    const { channel, scheduler } = mock_telegram_channel();
    const forward_user = MockUser({
      id: 12345,
      first_name: "Alice",
      username: "alice",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Analyze this forwarded post",
      from_user: MockUser({ id: 999, first_name: "Bob" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738080000,
    });
    const update = makeUpdate(message);

    // Format the text first (as done in _handle_text_message)
    const formatted_text = channel._format_forwarded_text(
      message.text!,
      update,
    );

    // Call _create_task
    await channel._create_task(formatted_text, 888, update);

    // Verify Task was created with forwarded tag
    expect(scheduler.submitted.length).toBe(1);
    const task = scheduler.submitted[0]!;
    expect(task.tags).toContain(", forwarded");
    expect(task.title).toContain("📨 ");
  });

  test("test_create_task_from_normal_message", async () => {
    // Test that normal messages create tasks without forwarded tag.
    const { channel, scheduler } = mock_telegram_channel();
    const message = MockMessage({
      message_id: 100,
      text: "Regular task",
      from_user: MockUser({ id: 999, first_name: "Bob" }),
      chat: MockChat({ id: 888, type: "private" }),
    });
    const update = makeUpdate(message);

    // Call _create_task
    await channel._create_task("Regular task", 888, update);

    // Verify Task was created without forwarded tag
    expect(scheduler.submitted.length).toBe(1);
    const task = scheduler.submitted[0]!;
    expect(task.tags).toBe("telegram");
    expect(task.title).not.toContain("📨 ");
  });
});

// ── Test real-world scenarios of forwarded messages ──────────────

describe("TestTelegramForwardedMessageScenarios", () => {
  test("test_user_forwards_news_article", () => {
    // Simulate a user forwarding a news article from a channel.
    const { channel } = mock_telegram_channel();
    const forward_chat = MockChat({
      id: -100123456789,
      type: "channel",
      title: "Breaking News",
    });

    const message = MockMessage({
      message_id: 100,
      text: "Stock market hits all-time high amid tech rally...",
      from_user: MockUser({ id: 999, first_name: "Investor" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from_chat: forward_chat,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text(
      message.text!,
      makeUpdate(message),
    );

    expect(result).toContain("转发自频道: Breaking News");
    expect(result).toContain("Stock market hits all-time high");
  });

  test("test_user_forwards_another_users_code", () => {
    // Simulate forwarding code snippet from another user.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({
      id: 12345,
      first_name: "Dev",
      username: "cool_dev",
    });

    const message = MockMessage({
      message_id: 100,
      text: "```python\ndef hello():\n    print('world')\n```",
      from_user: MockUser({ id: 999, first_name: "Learner" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738083600,
    });

    const result = channel._format_forwarded_text(
      message.text!,
      makeUpdate(message),
    );

    expect(result).toContain("转发自: @cool_dev");
    expect(result).toContain("def hello():");
  });

  test("test_forwarded_multiline_message", () => {
    // Test handling of forwarded messages with multiple lines.
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({ id: 12345, first_name: "Announcer" });

    const text =
      "This is a forwarded message\n" +
      "with multiple lines\n" +
      "and some bullet points:\n" +
      "- Point 1\n" +
      "- Point 2\n" +
      "- Point 3";

    const message = MockMessage({
      message_id: 100,
      text,
      from_user: MockUser({ id: 999, first_name: "Receiver" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738087200,
    });

    const result = channel._format_forwarded_text(text, makeUpdate(message));

    expect(result).toContain("转发自: Announcer");
    expect(result).toContain("--- 转发内容 ---");
    expect(result).toContain("Point 1");
    expect(result).toContain("Point 3");
  });

  test("test_empty_text_with_forward", () => {
    // Test when forwarded message has no text (e.g., media-only).
    const { channel } = mock_telegram_channel();
    const forward_user = MockUser({ id: 12345, first_name: "Sender" });

    const message = MockMessage({
      message_id: 100,
      text: "", // Empty text, maybe just a photo
      from_user: MockUser({ id: 999, first_name: "User" }),
      chat: MockChat({ id: 888, type: "private" }),
      forward_from: forward_user,
      forward_date: 1738080000,
    });

    const result = channel._format_forwarded_text("", makeUpdate(message));

    expect(result).toContain("📨 [转发消息]");
    expect(result).toContain("转发自: Sender");
    expect(result).toContain("--- 转发内容 ---");
  });
});

// ── Integration tests for the complete forwarded message flow ────

describe("TestTelegramForwardedMessageIntegration", () => {
  test("test_complete_forwarded_message_flow", async () => {
    // Test the complete flow from forwarded message to task creation.
    const { channel, scheduler } = mock_telegram_channel();

    // Setup
    const forward_user = MockUser({
      id: 12345,
      first_name: "Alice",
      username: "alice",
    });
    const current_user = MockUser({ id: 999, first_name: "Bob" });
    const chat = MockChat({ id: 888, type: "private" });

    const message = MockMessage({
      message_id: 100,
      text: "Review this code",
      from_user: current_user,
      chat,
      forward_from: forward_user,
      forward_date: 1738080000,
    });
    const update = makeUpdate(message);

    // Execute text formatting
    // Note: We're simulating just the text processing part
    const formatted_text = channel._format_forwarded_text(
      message.text!,
      update,
    );

    // Verify formatting
    expect(formatted_text).toContain("📨 [转发消息]");
    expect(formatted_text).toContain("转发自: @alice");
    expect(formatted_text).toContain("Review this code");

    // Task creation would normally happen next
    await channel._create_task(formatted_text, 888, update);

    // Verify task was created with forwarded content
    expect(scheduler.submitted.length).toBe(1);
    expect(scheduler.submitted[0]!.prompt).toBe(formatted_text);
  });
});
