// Ported from tests/test_taskboard_bus.py (bun:test).
// Python's blocking queue.get() calls become awaited promises; everything else
// is a 1:1 translation.

import { expect, test } from "bun:test";

import {
  BusAwareSchedulerMixin,
  Channel,
  InboundMessageType,
  MessageBus,
  makeOutboundMessage,
  OutboundMessageType,
  UIChannel,
  type InboundMessage,
  type OutboundMessage,
  type TaskDBLike,
} from "../src/bus.ts";

class StubDB implements TaskDBLike {
  tasks: Record<number, Record<string, unknown>>;

  constructor(tasks: Record<number, Record<string, unknown>> | null = null) {
    this.tasks = tasks ?? {};
  }

  get_task(task_id: number): Record<string, unknown> | null {
    return this.tasks[task_id] ?? null;
  }
}

class RecordingChannel extends Channel {
  sent: OutboundMessage[] = [];

  constructor(bus: MessageBus, db: TaskDBLike) {
    super("test", bus, db);
  }

  send(msg: OutboundMessage): void {
    this.sent.push(msg);
  }

  start(): void {
    this._running = true;
  }
}

class FakeScheduler extends BusAwareSchedulerMixin {
  db: TaskDBLike;

  constructor(db: TaskDBLike, bus: MessageBus | null = null) {
    super();
    this.db = db;
    this.bus = bus;
  }
}

test("test_message_bus_round_trips_inbound_and_outbound_messages", async () => {
  const bus = new MessageBus();
  const inbound = new RecordingChannel(bus, new StubDB())._make_inbound(
    InboundMessageType.CREATE_TASK,
    { title: "hello" },
    "chat-1",
    { source_message_id: "m1" },
  );
  const outbound = makeOutboundMessage({
    type: OutboundMessageType.TASK_COMPLETED,
    task_id: 1,
    payload: { status: "completed" },
  });

  bus.publish_inbound(inbound);
  bus.publish_outbound(outbound);

  expect(await bus.get_inbound()).toBe(inbound);
  expect(await bus.get_outbound()).toBe(outbound);
});

test("test_message_bus_round_trips_task_brief_inbound_messages", async () => {
  const bus = new MessageBus();
  const channel = new RecordingChannel(bus, new StubDB());

  const create = channel._make_inbound(InboundMessageType.CREATE_BRIEF, {
    title: "Fix auth",
    goal: "Fix login redirect",
    source_channel: "telegram",
    source_ref: "chat-1:msg-2",
  });
  const confirm = channel._make_inbound(InboundMessageType.CONFIRM_BRIEF, {
    brief_id: 1,
  });
  const discard = channel._make_inbound(InboundMessageType.DISCARD_BRIEF, {
    brief_id: 2,
  });

  bus.publish_inbound(create);
  bus.publish_inbound(confirm);
  bus.publish_inbound(discard);

  expect((await bus.get_inbound())!.type).toBe("create_brief");
  expect((await bus.get_inbound())!.type).toBe("confirm_brief");
  expect((await bus.get_inbound())!.type).toBe("discard_brief");
});

test("test_message_bus_returns_none_when_queue_is_empty", async () => {
  const bus = new MessageBus();

  expect(await bus.get_inbound(false)).toBeNull();
  expect(await bus.get_outbound(false)).toBeNull();
});

test("test_message_bus_notifies_and_unsubscribes_outbound_listeners", () => {
  const bus = new MessageBus();
  const seen: number[] = [];

  const listener = (msg: OutboundMessage): void => {
    seen.push(msg.task_id);
  };

  bus.subscribe_outbound(listener);
  bus.publish_outbound(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_STARTED,
      task_id: 7,
    }),
  );
  bus.unsubscribe_outbound(listener);
  bus.publish_outbound(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_COMPLETED,
      task_id: 8,
    }),
  );

  expect(seen).toEqual([7]);
});

test("test_message_bus_tolerates_listener_errors_and_missing_unsubscribe", async () => {
  const bus = new MessageBus();

  const bad_listener = (_msg: OutboundMessage): void => {
    throw new Error("boom");
  };

  bus.subscribe_outbound(bad_listener);
  bus.publish_outbound(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_UPDATED,
      task_id: 9,
    }),
  );
  bus.unsubscribe_outbound(bad_listener);
  bus.unsubscribe_outbound(bad_listener);

  expect((await bus.get_outbound())!.task_id).toBe(9);
});

test("test_channel_notify_task_maps_task_status_to_outbound_type", () => {
  const bus = new MessageBus();
  const db = new StubDB({
    1: { status: "completed", result: "ok", error: null, title: "done" },
    2: { status: "failed", result: null, error: "boom", title: "bad" },
  });
  const channel = new RecordingChannel(bus, db);

  channel.notify_task(1);
  channel.notify_task(2);
  channel.notify_task(999);

  expect(channel.sent.map((msg) => msg.type)).toEqual([
    OutboundMessageType.TASK_COMPLETED,
    OutboundMessageType.TASK_FAILED,
  ]);
  expect(channel.sent[0]!.payload["result"]).toBe("ok");
  expect(channel.sent[1]!.payload["error"]).toBe("boom");
});

test("test_channel_stop_marks_channel_as_not_running", () => {
  const channel = new RecordingChannel(new MessageBus(), new StubDB());
  channel.start();

  channel.stop();

  expect(channel._running).toBe(false);
});

test("test_ui_channel_caches_outbound_messages_and_inbound_notifications", async () => {
  const bus = new MessageBus();
  const db = new StubDB();
  const channel = new UIChannel(bus, db);

  channel.start();
  const created = channel._make_inbound(InboundMessageType.CREATE_TASK, {
    task_id: 1,
    prompt: "hello",
  });
  bus.publish_inbound(created);
  channel.notify_task_created(1, "hello", "~/repo", { tags: "ops" });
  channel.notify_task_resumed(1, "continue");
  bus.publish_outbound(
    makeOutboundMessage({
      type: OutboundMessageType.TASK_UPDATED,
      task_id: 1,
      payload: { status: "running" },
    }),
  );

  const inbound_messages: Array<InboundMessage | null> = [
    await bus.get_inbound(),
    await bus.get_inbound(),
    await bus.get_inbound(),
  ];
  const cached = channel.get_cached_outbound(1);

  expect(channel._running).toBe(true);
  expect(inbound_messages.map((msg) => msg!.type)).toEqual([
    InboundMessageType.CREATE_TASK,
    InboundMessageType.CREATE_TASK,
    InboundMessageType.RESUME_TASK,
  ]);
  expect(inbound_messages[1]!.payload["working_dir"]).toBe("~/repo");
  expect(inbound_messages[1]!.payload["tags"]).toBe("ops");
  expect(inbound_messages[2]!.payload["message"]).toBe("continue");
  expect(cached.length).toBe(1);
  expect(cached[0]!.payload["status"]).toBe("running");
});

test("test_ui_channel_evicts_oldest_task_cache_entries", () => {
  const bus = new MessageBus();
  const channel = new UIChannel(bus, new StubDB());
  channel._CACHE_MAX_TASKS = 2;

  for (const task_id of [1, 2, 3]) {
    channel.send(
      makeOutboundMessage({
        type: OutboundMessageType.TASK_UPDATED,
        task_id,
      }),
    );
  }

  expect([...channel._outbound_cache.keys()].sort()).toEqual([2, 3]);
});

test("test_bus_aware_scheduler_mixin_publishes_task_updates", async () => {
  const bus = new MessageBus();
  const db = new StubDB({
    1: { status: "completed", result: "ok", error: null, title: "done" },
    2: { status: "running", result: null, error: null, title: "work" },
  });
  const scheduler = new FakeScheduler(db, bus);

  scheduler._bus_notify(1);
  scheduler._bus_notify(2, OutboundMessageType.STATUS_RESPONSE);
  scheduler._bus_notify(999);

  const first = await bus.get_outbound();
  const second = await bus.get_outbound();

  expect(first!.type).toBe(OutboundMessageType.TASK_COMPLETED);
  expect(first!.payload["title"]).toBe("done");
  expect(second!.type).toBe(OutboundMessageType.STATUS_RESPONSE);
  expect(second!.payload["status"]).toBe("running");
});

test("test_bus_aware_scheduler_mixin_includes_inbound_task_source", async () => {
  const bus = new MessageBus();
  const db = new StubDB({
    1: { status: "completed", result: "ok", error: null, title: "done" },
  });
  const scheduler = new FakeScheduler(db, bus);
  bus.publish_inbound({
    type: InboundMessageType.CREATE_TASK,
    source: "feishu",
    payload: { task_id: 1 },
    reply_to: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000000",
  });

  scheduler._bus_notify(1);

  const msg = await bus.get_outbound();
  expect(msg!.metadata["source_channel"]).toBe("feishu");
});

test("test_bus_aware_scheduler_mixin_noops_without_bus", () => {
  const scheduler = new FakeScheduler(
    new StubDB({ 1: { status: "completed" } }),
    null,
  );

  scheduler._bus_notify(1);
});

test("test_bus_aware_scheduler_mixin_tolerates_db_errors", () => {
  class BrokenDB implements TaskDBLike {
    get_task(_task_id: number): Record<string, unknown> | null {
      throw new Error("db down");
    }
  }

  const scheduler = new FakeScheduler(new BrokenDB(), new MessageBus());

  scheduler._bus_notify(1);
});
