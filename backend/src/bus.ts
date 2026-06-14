// AgentForge Message Bus — ported from taskboard_bus.py.
//
// MessageBus decouples message sources (channels) from the task scheduler:
//
//                     ┌─────────────────────────────────┐
//                     │           MessageBus             │
//                     │                                  │
//   FeishuChannel ──► │  inbound_queue (AsyncQueue)     │──► TaskScheduler
//   UIChannel     ──► │                                  │
//   SlackChannel  ──► │  outbound_queue (AsyncQueue)    │◄── TaskScheduler._notify()
//   ...           ──► │                                  │
//                     └──────────┬───────────────────────┘
//                                │ subscribe_outbound()
//                                ▼
//                     Channel.send(OutboundMessage)
//
// Naming follows the Python original exactly (snake_case methods/fields).
// Python's queue.Queue(timeout=...) is replaced by AsyncQueue: get() returns a
// Promise that resolves with the next message (resolving early when one is
// published) or null after the timeout / immediately when block=false. All
// production call sites either publish (non-blocking) or poll, so this is a
// faithful minimal equivalent. put_nowait preserves maxsize semantics by
// throwing when the queue is full, like Python's queue.Full.

// ──────────────────────────── Message Types ────────────────────────────

/** Inbound message action types (enum values identical to Python). */
export const InboundMessageType = {
  CREATE_TASK: "create_task", // create a new task
  RESUME_TASK: "resume_task", // resume an existing task (uses session_id)
  RESPOND_TASK: "respond_task", // answer a question a task is waiting on
  CANCEL_TASK: "cancel_task", // cancel a task
  STATUS_QUERY: "status_query", // query task status
  CREATE_BRIEF: "create_brief", // create a draft task brief
  CONFIRM_BRIEF: "confirm_brief", // convert a draft brief into a task
  DISCARD_BRIEF: "discard_brief", // discard a draft brief
  PREVIEW_RUNBOOK: "preview_runbook", // create a draft preview from an IM runbook
  RUN_RUNBOOK: "run_runbook", // run an IM runbook or create a confirmation draft
  TRIGGER_DIGEST: "trigger_digest", // preview or send an IM digest
} as const;
export type InboundMessageType =
  (typeof InboundMessageType)[keyof typeof InboundMessageType];

/** Outbound message event types (enum values identical to Python). */
export const OutboundMessageType = {
  TASK_COMPLETED: "task_completed",
  TASK_FAILED: "task_failed",
  TASK_STARTED: "task_started",
  TASK_UPDATED: "task_updated",
  STATUS_RESPONSE: "status_response",
} as const;
export type OutboundMessageType =
  (typeof OutboundMessageType)[keyof typeof OutboundMessageType];

/**
 * UTC-naive ISO timestamp, matching Python's `datetime.utcnow().isoformat()`
 * used by the dataclass defaults (note: NOT the local-naive nowIso() in
 * util.ts — the bus historically stamped messages in UTC).
 */
function utcNowIso(): string {
  // toISOString() → "YYYY-MM-DDTHH:MM:SS.mmmZ"; pad to 6 fractional digits.
  return new Date().toISOString().replace("Z", "000");
}

/**
 * Inbound message from a Channel to the MessageBus.
 *
 * payload contents depend on type:
 *   CREATE_TASK  -> {"title", "prompt", "working_dir", ...}
 *   RESUME_TASK  -> {"task_id", "message"}
 *   RESPOND_TASK -> {"task_id", "answer"}
 *   CANCEL_TASK  -> {"task_id"}
 *   STATUS_QUERY -> {"task_id"}
 *   CREATE_BRIEF -> {"title", "goal", "source_channel", "source_ref", ...}
 *   CONFIRM_BRIEF -> {"brief_id"}
 *   DISCARD_BRIEF -> {"brief_id"}
 *   PREVIEW_RUNBOOK -> {"name", "raw_args", "source_channel", "source_ref", ...}
 *   RUN_RUNBOOK -> {"name", "raw_args", "source_channel", "source_ref", ...}
 *   TRIGGER_DIGEST -> {"include_empty", "limit", "since"}
 * reply_to: optional reply target (e.g. Feishu chat_id / open_id).
 * metadata: channel-specific context (e.g. Feishu message_id).
 */
export interface InboundMessage {
  type: InboundMessageType;
  source: string;
  payload: Record<string, unknown>;
  reply_to: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Factory applying the Python dataclass defaults for InboundMessage. */
export function makeInboundMessage(
  partial: Pick<InboundMessage, "type" | "source"> & Partial<InboundMessage>,
): InboundMessage {
  return {
    payload: {},
    reply_to: null,
    metadata: {},
    created_at: utcNowIso(),
    ...partial,
  };
}

/**
 * Outbound message published by the scheduler after a task finishes.
 *
 * payload: event payload, e.g. {"status", "result", "error", "title"}.
 * source_msg: the InboundMessage that triggered this result (optional).
 */
export interface OutboundMessage {
  type: OutboundMessageType;
  task_id: number;
  payload: Record<string, unknown>;
  source_msg: InboundMessage | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/** Factory applying the Python dataclass defaults for OutboundMessage. */
export function makeOutboundMessage(
  partial: Pick<OutboundMessage, "type" | "task_id"> & Partial<OutboundMessage>,
): OutboundMessage {
  return {
    payload: {},
    source_msg: null,
    metadata: {},
    created_at: utcNowIso(),
    ...partial,
  };
}

// ──────────────────────────── TaskDB structural type ────────────────────────────

/**
 * Minimal structural view of TaskDB used by this module (so bus.ts does not
 * import db.ts). The bus code only ever calls get_task(). Exported for reuse
 * by channels/tests.
 */
export interface TaskDBLike {
  get_task(task_id: number): Record<string, unknown> | null | undefined;
}

// ──────────────────────────── Async Queue ────────────────────────────

/**
 * Async-friendly replacement for Python's queue.Queue.
 * - put_nowait throws when maxsize (> 0) is exceeded (≙ queue.Full).
 * - get(block, timeoutSeconds) resolves with the next item, resolving early
 *   when one is published; resolves null on timeout or when block=false and
 *   the queue is empty (the Python wrappers map queue.Empty → None).
 */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(value: T | null) => void> = [];

  constructor(private readonly maxsize: number = 0) {}

  put_nowait(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand off directly to a blocked getter (qsize stays 0, like Python).
      waiter(item);
      return;
    }
    if (this.maxsize > 0 && this.items.length >= this.maxsize) {
      throw new Error("queue full");
    }
    this.items.push(item);
  }

  get(block: boolean = true, timeout: number | null = null): Promise<T | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    if (!block) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (value: T | null): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
      if (timeout !== null) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve(null);
        }, timeout * 1000);
      }
    });
  }

  get size(): number {
    return this.items.length;
  }
}

// ──────────────────────────── Message Bus ────────────────────────────

export type OutboundListener = (msg: OutboundMessage) => void;

/**
 * AgentForge's message bus.
 *
 * Provides two queues:
 * - inbound_queue:  channels send task requests to the scheduler.
 * - outbound_queue: the scheduler publishes task result notifications.
 */
export class MessageBus {
  inbound_queue: AsyncQueue<InboundMessage>;
  outbound_queue: AsyncQueue<OutboundMessage>;
  private _outbound_listeners: OutboundListener[] = [];
  private _task_sources: Map<number, string> = new Map();

  /** maxsize: queue capacity limit; 0 means unbounded. */
  constructor(maxsize: number = 0) {
    this.inbound_queue = new AsyncQueue<InboundMessage>(maxsize);
    this.outbound_queue = new AsyncQueue<OutboundMessage>(maxsize);
  }

  // ── inbound helpers ──────────────────────────────────────────

  /** Channels call this to enqueue an inbound message. */
  publish_inbound(msg: InboundMessage): void {
    const task_id = Number(msg.payload["task_id"]);
    if (
      msg.source &&
      msg.source !== "ui" &&
      Number.isInteger(task_id) &&
      task_id > 0
    ) {
      this.register_task_source(task_id, msg.source);
    }
    this.inbound_queue.put_nowait(msg);
  }

  register_task_source(task_id: number, source: string): void {
    if (!Number.isInteger(task_id) || task_id <= 0 || !source) return;
    this._task_sources.set(task_id, source);
  }

  get_task_source(task_id: number): string | null {
    return this._task_sources.get(task_id) ?? null;
  }

  clear_task_source(task_id: number): void {
    this._task_sources.delete(task_id);
  }

  /** The scheduler calls this to take the next inbound message (optional). */
  get_inbound(
    block: boolean = true,
    timeout: number | null = null,
  ): Promise<InboundMessage | null> {
    return this.inbound_queue.get(block, timeout);
  }

  // ── outbound helpers ─────────────────────────────────────────

  /**
   * The scheduler calls this to publish a task result. The message is put on
   * outbound_queue and all registered listeners are invoked synchronously.
   */
  publish_outbound(msg: OutboundMessage): void {
    this.outbound_queue.put_nowait(msg);
    for (const listener of this._outbound_listeners) {
      try {
        listener(msg);
      } catch (e) {
        console.log(`[MessageBus] outbound listener error: ${e}`);
      }
    }
  }

  /** Register an outbound listener (e.g. FeishuChannel's notify function). */
  subscribe_outbound(listener: OutboundListener): void {
    this._outbound_listeners.push(listener);
  }

  /** Remove an outbound listener (no-op when not registered). */
  unsubscribe_outbound(listener: OutboundListener): void {
    const idx = this._outbound_listeners.indexOf(listener);
    if (idx !== -1) this._outbound_listeners.splice(idx, 1);
  }

  /** Polling channels call this to take the next outbound message. */
  get_outbound(
    block: boolean = true,
    timeout: number | null = null,
  ): Promise<OutboundMessage | null> {
    return this.outbound_queue.get(block, timeout);
  }
}

// ──────────────────────────── Channel (abstract) ────────────────────────────

/**
 * Abstract message channel. Each concrete Channel represents an external
 * system (HTTP UI, Feishu, Slack, ...). A channel:
 * 1. Receives external messages, wraps them as InboundMessage onto the bus.
 * 2. Pushes task results back to the external system via send().
 *
 * Legacy compatibility: notify_task(task_id) reads the DB and calls send(),
 * matching the original FeishuBridge.notify_task() calling convention.
 */
export abstract class Channel {
  name: string;
  bus: MessageBus;
  db: TaskDBLike;
  _running: boolean = false;

  constructor(name: string, bus: MessageBus, db: TaskDBLike) {
    this.name = name;
    this.bus = bus;
    this.db = db;
  }

  /** Push an outbound message to this channel's external system. */
  abstract send(msg: OutboundMessage): void;

  /** Start the channel's background listener. */
  abstract start(): void;

  /** Stop the channel (optional override). */
  stop(): void {
    this._running = false;
  }

  /**
   * Legacy direct-callback interface: read the task's status, build an
   * OutboundMessage, and call send().
   */
  notify_task(task_id: number): void {
    const task = this.db.get_task(task_id);
    if (!task) return;
    const status = (task["status"] as string | undefined) ?? "";
    const type_map: Record<string, OutboundMessageType> = {
      running: OutboundMessageType.TASK_STARTED,
      completed: OutboundMessageType.TASK_COMPLETED,
      failed: OutboundMessageType.TASK_FAILED,
    };
    const msg_type = type_map[status] ?? OutboundMessageType.TASK_UPDATED;
    const outbound = makeOutboundMessage({
      type: msg_type,
      task_id,
      payload: {
        status,
        result: task["result"] ?? null,
        error: task["error"] ?? null,
        title: task["title"] ?? null,
      },
    });
    this.send(outbound);
  }

  /** Convenience factory that auto-fills the source field. */
  _make_inbound(
    msg_type: InboundMessageType,
    payload: Record<string, unknown>,
    reply_to: string | null = null,
    metadata: Record<string, unknown> | null = null,
  ): InboundMessage {
    return makeInboundMessage({
      type: msg_type,
      source: this.name,
      payload,
      reply_to,
      metadata: metadata ?? {},
    });
  }

  _remember_task_source(task_id: number): void {
    this.bus.register_task_source(task_id, this.name);
  }

  _outbound_source(msg: OutboundMessage): string | null {
    const metadata_source = msg.metadata["source_channel"];
    if (typeof metadata_source === "string" && metadata_source) {
      return metadata_source;
    }
    const source_msg = msg.source_msg;
    return source_msg?.source || null;
  }

  _should_handle_outbound(msg: OutboundMessage): boolean {
    const source = this._outbound_source(msg);
    return source === null || source === this.name;
  }
}

// ──────────────────────────── UIChannel ────────────────────────────

/**
 * HTTP REST API channel (wraps the existing HTTP handler + TaskScheduler).
 *
 * Converts browser/React HTTP requests into InboundMessages on the bus, and
 * caches outbound events in memory for the /api/tasks/{id}/events polling
 * endpoint. The HTTP handler still drives scheduler/db directly; this channel
 * mirrors those operations as InboundMessages for a complete event trail.
 */
export class UIChannel extends Channel {
  /** Outbound event cache: task_id -> OutboundMessage[] (insertion-ordered). */
  _outbound_cache: Map<number, OutboundMessage[]> = new Map();

  /** Max number of task IDs to keep in the outbound cache. */
  _CACHE_MAX_TASKS: number = 1000;

  constructor(bus: MessageBus, db: TaskDBLike) {
    super("ui", bus, db);
    bus.subscribe_outbound(this._on_outbound);
  }

  /** UI channel receives HTTP requests passively; no polling needed. */
  start(): void {
    this._running = true;
    console.log("[UIChannel] Ready (HTTP REST API)");
  }

  /** Cache the outbound message for HTTP polling endpoints. */
  send(msg: OutboundMessage): void {
    let entries = this._outbound_cache.get(msg.task_id);
    if (!entries) {
      entries = [];
      this._outbound_cache.set(msg.task_id, entries);
    }
    entries.push(msg);
    // Evict oldest task entries when the cache grows too large
    while (this._outbound_cache.size > this._CACHE_MAX_TASKS) {
      const oldest = this._outbound_cache.keys().next().value;
      if (oldest === undefined) break;
      this._outbound_cache.delete(oldest);
    }
  }

  /** Return a copy of all cached outbound events for a task. */
  get_cached_outbound(task_id: number): OutboundMessage[] {
    return [...(this._outbound_cache.get(task_id) ?? [])];
  }

  /**
   * Called by the HTTP handler after creating a task; publishes an
   * InboundMessage to the bus. kwargs (≙ Python **kwargs) are merged into
   * the payload.
   */
  notify_task_created(
    task_id: number,
    prompt: string,
    working_dir: string = ".",
    kwargs: Record<string, unknown> = {},
  ): void {
    this.bus.publish_inbound(
      this._make_inbound(InboundMessageType.CREATE_TASK, {
        task_id,
        prompt,
        working_dir,
        ...kwargs,
      }),
    );
  }

  /** Called by the HTTP handler after resuming a task. */
  notify_task_resumed(task_id: number, message: string): void {
    this.bus.publish_inbound(
      this._make_inbound(InboundMessageType.RESUME_TASK, {
        task_id,
        message,
      }),
    );
  }

  /**
   * Subscription callback: write the outbound message into the local cache.
   * Arrow-function property so the reference passed to subscribe_outbound is
   * stable and bound (≙ Python bound method).
   */
  _on_outbound = (msg: OutboundMessage): void => {
    this.send(msg);
  };
}

// ──────────────────────────── BusAwareSchedulerMixin ────────────────────────────

/**
 * Publish an OutboundMessage to the bus based on the task's current status.
 *
 * override_type forces a specific message type (used when a cron task has
 * already been rescheduled: the DB status is back to "scheduled" but this
 * run's result should be announced as TASK_COMPLETED).
 *
 * Porting note: Python's BusAwareSchedulerMixin is a mixin class consumed via
 * `class TaskScheduler(BusAwareSchedulerMixin)`, and taskboard.py calls
 * `self._bus_notify(task_id[, override_type])` (it relies only on `self.bus`
 * and `self.db`). TS has no Python-style mixins, so the logic lives in this
 * standalone helper, and the small BusAwareSchedulerMixin base class below
 * preserves the `extends` + `this._bus_notify(...)` ergonomics for the
 * TaskScheduler port.
 */
export function bus_notify(
  bus: MessageBus | null | undefined,
  db: TaskDBLike,
  task_id: number,
  override_type: OutboundMessageType | null = null,
): void {
  if (!bus) return;
  try {
    const task = db.get_task(task_id);
    if (!task) return;
    const status = (task["status"] as string | undefined) ?? "";
    let msg_type: OutboundMessageType;
    if (override_type !== null) {
      msg_type = override_type;
    } else {
      const type_map: Record<string, OutboundMessageType> = {
        running: OutboundMessageType.TASK_STARTED,
        completed: OutboundMessageType.TASK_COMPLETED,
        failed: OutboundMessageType.TASK_FAILED,
        cancelled: OutboundMessageType.TASK_UPDATED,
        scheduled: OutboundMessageType.TASK_UPDATED,
        pending: OutboundMessageType.TASK_UPDATED,
      };
      msg_type = type_map[status] ?? OutboundMessageType.TASK_UPDATED;
    }
    const outbound = makeOutboundMessage({
      type: msg_type,
      task_id,
      payload: {
        status,
        result: task["result"] ?? null,
        error: task["error"] ?? null,
        title: task["title"] ?? null,
      },
      metadata: Object.fromEntries(
        Object.entries({
          source_channel: bus.get_task_source(task_id),
        }).filter(([, value]) => value !== null),
      ),
    });
    bus.publish_outbound(outbound);
    if (
      msg_type === OutboundMessageType.TASK_COMPLETED ||
      msg_type === OutboundMessageType.TASK_FAILED
    ) {
      bus.clear_task_source(task_id);
    }
  } catch (e) {
    console.log(`[BusAwareSchedulerMixin] _bus_notify error: ${e}`);
  }
}

/**
 * Base class equivalent of the Python mixin: subclasses (TaskScheduler)
 * provide `db` and optionally set `bus`, then call `this._bus_notify(...)`
 * exactly as the Python code does.
 */
export abstract class BusAwareSchedulerMixin {
  bus: MessageBus | null = null;
  abstract db: TaskDBLike;

  _bus_notify(
    task_id: number,
    override_type: OutboundMessageType | null = null,
  ): void {
    bus_notify(this.bus, this.db, task_id, override_type);
  }
}
