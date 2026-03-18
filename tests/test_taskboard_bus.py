from taskboard_bus import (
    BusAwareSchedulerMixin,
    Channel,
    InboundMessageType,
    MessageBus,
    OutboundMessage,
    OutboundMessageType,
    UIChannel,
)


class StubDB:
    def __init__(self, tasks=None):
        self.tasks = tasks or {}

    def get_task(self, task_id):
        return self.tasks.get(task_id)


class RecordingChannel(Channel):
    def __init__(self, bus, db):
        super().__init__("test", bus, db)
        self.sent = []

    def send(self, msg):
        self.sent.append(msg)

    def start(self):
        self._running = True


class FakeScheduler(BusAwareSchedulerMixin):
    def __init__(self, db, bus=None):
        self.db = db
        self.bus = bus


def test_message_bus_round_trips_inbound_and_outbound_messages():
    bus = MessageBus()
    inbound = RecordingChannel(bus, StubDB())._make_inbound(
        InboundMessageType.CREATE_TASK,
        {"title": "hello"},
        reply_to="chat-1",
        metadata={"source_message_id": "m1"},
    )
    outbound = OutboundMessage(
        type=OutboundMessageType.TASK_COMPLETED,
        task_id=1,
        payload={"status": "completed"},
    )

    bus.publish_inbound(inbound)
    bus.publish_outbound(outbound)

    assert bus.get_inbound() == inbound
    assert bus.get_outbound() == outbound


def test_message_bus_returns_none_when_queue_is_empty():
    bus = MessageBus()

    assert bus.get_inbound(block=False) is None
    assert bus.get_outbound(block=False) is None


def test_message_bus_notifies_and_unsubscribes_outbound_listeners():
    bus = MessageBus()
    seen = []

    def listener(msg):
        seen.append(msg.task_id)

    bus.subscribe_outbound(listener)
    bus.publish_outbound(
        OutboundMessage(
            type=OutboundMessageType.TASK_STARTED,
            task_id=7,
        )
    )
    bus.unsubscribe_outbound(listener)
    bus.publish_outbound(
        OutboundMessage(
            type=OutboundMessageType.TASK_COMPLETED,
            task_id=8,
        )
    )

    assert seen == [7]


def test_message_bus_tolerates_listener_errors_and_missing_unsubscribe():
    bus = MessageBus()

    def bad_listener(msg):
        raise RuntimeError("boom")

    bus.subscribe_outbound(bad_listener)
    bus.publish_outbound(
        OutboundMessage(
            type=OutboundMessageType.TASK_UPDATED,
            task_id=9,
        )
    )
    bus.unsubscribe_outbound(bad_listener)
    bus.unsubscribe_outbound(bad_listener)

    assert bus.get_outbound().task_id == 9


def test_channel_notify_task_maps_task_status_to_outbound_type():
    bus = MessageBus()
    db = StubDB(
        {
            1: {"status": "completed", "result": "ok", "error": None, "title": "done"},
            2: {"status": "failed", "result": None, "error": "boom", "title": "bad"},
        }
    )
    channel = RecordingChannel(bus, db)

    channel.notify_task(1)
    channel.notify_task(2)
    channel.notify_task(999)

    assert [msg.type for msg in channel.sent] == [
        OutboundMessageType.TASK_COMPLETED,
        OutboundMessageType.TASK_FAILED,
    ]
    assert channel.sent[0].payload["result"] == "ok"
    assert channel.sent[1].payload["error"] == "boom"


def test_channel_stop_marks_channel_as_not_running():
    channel = RecordingChannel(MessageBus(), StubDB())
    channel.start()

    channel.stop()

    assert channel._running is False


def test_ui_channel_caches_outbound_messages_and_inbound_notifications():
    bus = MessageBus()
    db = StubDB()
    channel = UIChannel(bus, db)

    channel.start()
    created = channel._make_inbound(
        InboundMessageType.CREATE_TASK,
        {"task_id": 1, "prompt": "hello"},
    )
    bus.publish_inbound(created)
    channel.notify_task_created(1, "hello", "~/repo", tags="ops")
    channel.notify_task_resumed(1, "continue")
    bus.publish_outbound(
        OutboundMessage(
            type=OutboundMessageType.TASK_UPDATED,
            task_id=1,
            payload={"status": "running"},
        )
    )

    inbound_messages = [bus.get_inbound(), bus.get_inbound(), bus.get_inbound()]
    cached = channel.get_cached_outbound(1)

    assert channel._running is True
    assert [msg.type for msg in inbound_messages] == [
        InboundMessageType.CREATE_TASK,
        InboundMessageType.CREATE_TASK,
        InboundMessageType.RESUME_TASK,
    ]
    assert inbound_messages[1].payload["working_dir"] == "~/repo"
    assert inbound_messages[1].payload["tags"] == "ops"
    assert inbound_messages[2].payload["message"] == "continue"
    assert len(cached) == 1
    assert cached[0].payload["status"] == "running"


def test_ui_channel_evicts_oldest_task_cache_entries():
    bus = MessageBus()
    channel = UIChannel(bus, StubDB())
    channel._CACHE_MAX_TASKS = 2

    for task_id in (1, 2, 3):
        channel.send(
            OutboundMessage(
                type=OutboundMessageType.TASK_UPDATED,
                task_id=task_id,
            )
        )

    assert sorted(channel._outbound_cache) == [2, 3]


def test_bus_aware_scheduler_mixin_publishes_task_updates():
    bus = MessageBus()
    db = StubDB(
        {
            1: {"status": "completed", "result": "ok", "error": None, "title": "done"},
            2: {"status": "running", "result": None, "error": None, "title": "work"},
        }
    )
    scheduler = FakeScheduler(db, bus)

    scheduler._bus_notify(1)
    scheduler._bus_notify(2, override_type=OutboundMessageType.STATUS_RESPONSE)
    scheduler._bus_notify(999)

    first = bus.get_outbound()
    second = bus.get_outbound()

    assert first.type == OutboundMessageType.TASK_COMPLETED
    assert first.payload["title"] == "done"
    assert second.type == OutboundMessageType.STATUS_RESPONSE
    assert second.payload["status"] == "running"


def test_bus_aware_scheduler_mixin_noops_without_bus():
    scheduler = FakeScheduler(StubDB({1: {"status": "completed"}}), bus=None)

    scheduler._bus_notify(1)


def test_bus_aware_scheduler_mixin_tolerates_db_errors():
    class BrokenDB:
        def get_task(self, task_id):
            raise RuntimeError("db down")

    scheduler = FakeScheduler(BrokenDB(), MessageBus())

    scheduler._bus_notify(1)
