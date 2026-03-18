"""
AgentForge Message Bus
=====================

架构设计
--------
MessageBus 是 AgentForge 的消息中枢，解耦消息来源（channels）与任务执行器。

                    ┌─────────────────────────────────┐
                    │           MessageBus             │
                    │                                  │
  FeishuChannel ──► │  inbound_queue (Queue)          │──► TaskScheduler
  UIChannel     ──► │                                  │
  SlackChannel  ──► │  outbound_queue (Queue)         │◄── TaskScheduler._notify()
  ...           ──► │                                  │
                    └──────────┬───────────────────────┘
                               │ subscribe_outbound()
                               ▼
                    Channel.send(OutboundMessage)

核心概念：
- InboundMessage: 任何来源（Feishu、HTTP UI、Slack 等）发向 bus 的消息，
  触发新建任务或恢复现有任务。
- OutboundMessage: 任务执行完毕后由 Scheduler 发布到 bus 的结果通知，
  由各注册的 Channel 分发给对应来源（Feishu 卡片、UI 轮询等）。
- Channel (ABC): 代表一个通信通道。
  - send(OutboundMessage): 将结果推送回外部系统。
  - start(): 开启后台监听（如 WebSocket 长连接）。
  - stop(): 关闭连接。
  - notify_task(task_id): 兼容旧式直接回调接口（调用 send）。
- UIChannel:  包装现有 HTTP REST API，保持向后兼容。

线程模型：
- MessageBus 使用 threading.Queue（与现有同步线程代码兼容）。
- 各 Channel 在自己的线程内调用 bus.publish_inbound()。
- TaskScheduler._notify() 调用 bus.publish_outbound()，同步触发所有
  subscribe_outbound() 注册的回调。

向后兼容：
- Channel.notify_task(task_id) 默认实现通过 db 读取任务并调用 send()，
  保持与旧式 feishu_bridge.notify_task() 相同的调用约定。
- UIChannel 封装原有 HTTP handler + TaskScheduler，对外暴露相同接口。
"""

import queue
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    from taskboard import TaskDB


# ──────────────────────────── Message Types ────────────────────────────


class InboundMessageType(str, Enum):
    """Inbound message 的动作类型。"""

    CREATE_TASK = "create_task"  # 创建新任务
    RESUME_TASK = "resume_task"  # 恢复已有任务（使用 session_id）
    RESPOND_TASK = "respond_task"  # 回答任务等待的问题
    CANCEL_TASK = "cancel_task"  # 取消任务
    STATUS_QUERY = "status_query"  # 查询任务状态


class OutboundMessageType(str, Enum):
    """Outbound message 的事件类型。"""

    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"
    TASK_STARTED = "task_started"
    TASK_UPDATED = "task_updated"
    STATUS_RESPONSE = "status_response"


@dataclass
class InboundMessage:
    """从某个 Channel 发往 MessageBus 的入站消息。

    Attributes:
        type:        消息动作，见 InboundMessageType。
        source:      来源 channel 名称，如 "feishu"、"ui"、"slack"。
        payload:     消息载荷，内容依 type 而定：
                       CREATE_TASK  -> {"title", "prompt", "working_dir", ...}
                       RESUME_TASK  -> {"task_id", "message"}
                       RESPOND_TASK -> {"task_id", "answer"}
                       CANCEL_TASK  -> {"task_id"}
                       STATUS_QUERY -> {"task_id"}
        reply_to:    可选回复目标（如 Feishu chat_id / open_id），Channel 自行解释。
        metadata:    扩展字段，Channel 可存放任意上下文（如 Feishu message_id）。
        created_at:  消息创建时间（UTC ISO 格式）。
    """

    type: InboundMessageType
    source: str
    payload: dict = field(default_factory=dict)
    reply_to: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


@dataclass
class OutboundMessage:
    """Scheduler 完成任务后发布到 MessageBus 的出站消息。

    Attributes:
        type:        事件类型，见 OutboundMessageType。
        task_id:     关联任务 ID。
        payload:     事件载荷，如 {"status", "result", "error", "title"}。
        source_msg:  触发此结果的原始 InboundMessage（可选，用于关联回复）。
        metadata:    扩展字段。
        created_at:  消息创建时间（UTC ISO 格式）。
    """

    type: OutboundMessageType
    task_id: int
    payload: dict = field(default_factory=dict)
    source_msg: Optional[InboundMessage] = None
    metadata: dict = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())


# ──────────────────────────── Message Bus ────────────────────────────


class MessageBus:
    """AgentForge 的消息总线。

    提供两个线程安全的队列：
    - inbound_queue:  各 Channel 向 Scheduler 发送任务请求。
    - outbound_queue: Scheduler 向各 Channel 发布任务结果通知。

    使用 threading.Queue 以便与现有同步线程代码无缝集成。
    """

    def __init__(self, maxsize: int = 0):
        """
        Args:
            maxsize: 队列容量上限，0 表示无限制。
        """
        self.inbound_queue: queue.Queue[InboundMessage] = queue.Queue(maxsize=maxsize)
        self.outbound_queue: queue.Queue[OutboundMessage] = queue.Queue(maxsize=maxsize)
        self._outbound_listeners: list[Callable[[OutboundMessage], None]] = []

    # ── inbound helpers ──────────────────────────────────────────

    def publish_inbound(self, msg: InboundMessage) -> None:
        """Channel 调用此方法将入站消息放入队列。"""
        self.inbound_queue.put_nowait(msg)

    def get_inbound(
        self, block: bool = True, timeout: Optional[float] = None
    ) -> Optional[InboundMessage]:
        """Scheduler 调用此方法取出下一条入站消息（可选使用）。"""
        try:
            return self.inbound_queue.get(block=block, timeout=timeout)
        except queue.Empty:
            return None

    # ── outbound helpers ─────────────────────────────────────────

    def publish_outbound(self, msg: OutboundMessage) -> None:
        """Scheduler 调用此方法发布任务结果。
        消息放入 outbound_queue 并同步触发所有注册的监听回调。
        """
        self.outbound_queue.put_nowait(msg)
        for listener in self._outbound_listeners:
            try:
                listener(msg)
            except Exception as e:
                print(f"[MessageBus] outbound listener error: {e}")

    def subscribe_outbound(self, listener: Callable[[OutboundMessage], None]) -> None:
        """注册 outbound 监听器（如 FeishuChannel 的通知函数）。"""
        self._outbound_listeners.append(listener)

    def unsubscribe_outbound(self, listener: Callable[[OutboundMessage], None]) -> None:
        """移除 outbound 监听器。"""
        try:
            self._outbound_listeners.remove(listener)
        except ValueError:
            pass

    def get_outbound(
        self, block: bool = True, timeout: Optional[float] = None
    ) -> Optional[OutboundMessage]:
        """Channel 轮询模式下调用此方法取出出站消息。"""
        try:
            return self.outbound_queue.get(block=block, timeout=timeout)
        except queue.Empty:
            return None


# ──────────────────────────── Channel ABC ────────────────────────────


class Channel(ABC):
    """消息通道抽象基类。

    每个具体 Channel 代表一个外部系统（HTTP UI、Feishu、Slack 等）。
    Channel 负责：
    1. 从外部系统接收消息，封装为 InboundMessage，放入 bus.inbound_queue。
    2. 通过 send() 将任务结果推送回外部系统。

    兼容旧式调用：notify_task(task_id) 读取 DB 并调用 send()，
    保持与原 FeishuBridge.notify_task() 相同的调用约定。
    """

    def __init__(self, name: str, bus: MessageBus, db: "TaskDB"):
        self.name = name
        self.bus = bus
        self.db = db
        self._running = False

    @abstractmethod
    def send(self, msg: OutboundMessage) -> None:
        """将出站消息推送给此 channel 对应的外部系统。

        例如 FeishuChannel.send() 向 Feishu 发送卡片通知；
        UIChannel.send() 写入内存缓存供轮询端点读取。
        """
        ...

    @abstractmethod
    def start(self) -> None:
        """启动 channel 的后台监听（开始接收外部消息）。"""
        ...

    def stop(self) -> None:
        """停止 channel（可选覆盖）。"""
        self._running = False

    def notify_task(self, task_id: int) -> None:
        """兼容旧式直接回调接口。

        TaskScheduler._notify() 或外部代码可继续调用此方法。
        默认实现：读取任务状态，构造 OutboundMessage，调用 send()。
        """
        task = self.db.get_task(task_id)
        if not task:
            return
        status = task.get("status", "")
        type_map = {
            "running": OutboundMessageType.TASK_STARTED,
            "completed": OutboundMessageType.TASK_COMPLETED,
            "failed": OutboundMessageType.TASK_FAILED,
        }
        msg_type = type_map.get(status, OutboundMessageType.TASK_UPDATED)
        outbound = OutboundMessage(
            type=msg_type,
            task_id=task_id,
            payload={
                "status": status,
                "result": task.get("result"),
                "error": task.get("error"),
                "title": task.get("title"),
            },
        )
        self.send(outbound)

    def _make_inbound(
        self,
        msg_type: InboundMessageType,
        payload: dict,
        reply_to: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> InboundMessage:
        """便捷工厂方法，自动填充 source 字段。"""
        return InboundMessage(
            type=msg_type,
            source=self.name,
            payload=payload,
            reply_to=reply_to,
            metadata=metadata or {},
        )


# ──────────────────────────── UIChannel ────────────────────────────


class UIChannel(Channel):
    """HTTP REST API channel（包装现有 TaskAPIHandler + TaskScheduler）。

    将来自浏览器 React UI 的 HTTP 请求转换为 InboundMessage 并放入 bus；
    同时将 outbound 事件缓存到内存，供 /api/tasks/{id}/events 轮询端点读取。

    当前为桥接层：HTTP handler 仍直接操作 scheduler/db，
    此 Channel 在操作后补发对应的 InboundMessage，完整记录事件流。
    """

    def __init__(self, bus: MessageBus, db: "TaskDB"):
        super().__init__("ui", bus, db)
        # outbound 事件缓存：task_id -> list[OutboundMessage]
        self._outbound_cache: dict[int, list[OutboundMessage]] = {}
        self._cache_lock = threading.Lock()
        bus.subscribe_outbound(self._on_outbound)

    def start(self) -> None:
        """UI channel 通过 HTTP server 被动接收请求，无需主动轮询。"""
        self._running = True
        print("[UIChannel] Ready (HTTP REST API)")

    _CACHE_MAX_TASKS = 1000  # max number of task IDs to keep in the outbound cache

    def send(self, msg: OutboundMessage) -> None:
        """缓存出站消息，供 HTTP 轮询端点读取。"""
        with self._cache_lock:
            self._outbound_cache.setdefault(msg.task_id, []).append(msg)
            # Evict oldest task entries when the cache grows too large
            while len(self._outbound_cache) > self._CACHE_MAX_TASKS:
                self._outbound_cache.pop(next(iter(self._outbound_cache)))

    def get_cached_outbound(self, task_id: int) -> list[OutboundMessage]:
        """返回指定任务的所有出站事件副本。"""
        with self._cache_lock:
            return list(self._outbound_cache.get(task_id, []))

    def notify_task_created(
        self, task_id: int, prompt: str, working_dir: str = ".", **kwargs
    ) -> None:
        """HTTP handler 创建任务后调用，发布 InboundMessage 到 bus。"""
        self.bus.publish_inbound(
            self._make_inbound(
                InboundMessageType.CREATE_TASK,
                payload={
                    "task_id": task_id,
                    "prompt": prompt,
                    "working_dir": working_dir,
                    **kwargs,
                },
            )
        )

    def notify_task_resumed(self, task_id: int, message: str) -> None:
        """HTTP handler 恢复任务后调用。"""
        self.bus.publish_inbound(
            self._make_inbound(
                InboundMessageType.RESUME_TASK,
                payload={"task_id": task_id, "message": message},
            )
        )

    def _on_outbound(self, msg: OutboundMessage) -> None:
        """订阅回调：将出站消息写入本地缓存。"""
        self.send(msg)


# ──────────────────────────── BusAwareSchedulerMixin ────────────────────────────


class BusAwareSchedulerMixin:
    """可混入 TaskScheduler 的工具方法，让 _notify() 同时发布到 MessageBus。

    使用方式（在 taskboard.py 中，在 TaskScheduler._notify() 末尾追加）：

        # 在 run_server() 中：
        bus = MessageBus()
        scheduler.bus = bus

        # 在 TaskScheduler._notify() 末尾：
        if hasattr(self, 'bus') and self.bus:
            self._bus_notify(task_id)
    """

    bus: Optional[MessageBus] = None

    def _bus_notify(
        self, task_id: int, override_type: "Optional[OutboundMessageType]" = None
    ) -> None:
        """根据任务状态向 bus 发布对应的 OutboundMessage。

        override_type: 强制使用指定消息类型（用于 cron 任务重调度场景，
        此时 DB 状态已变为 "scheduled"，但本次运行结果应通知为 TASK_COMPLETED）。
        """
        if not self.bus:
            return
        try:
            task = self.db.get_task(task_id)
            if not task:
                return
            status = task.get("status", "")
            if override_type is not None:
                msg_type = override_type
            else:
                type_map = {
                    "running": OutboundMessageType.TASK_STARTED,
                    "completed": OutboundMessageType.TASK_COMPLETED,
                    "failed": OutboundMessageType.TASK_FAILED,
                    "cancelled": OutboundMessageType.TASK_UPDATED,
                    "scheduled": OutboundMessageType.TASK_UPDATED,
                    "pending": OutboundMessageType.TASK_UPDATED,
                }
                msg_type = type_map.get(status, OutboundMessageType.TASK_UPDATED)
            outbound = OutboundMessage(
                type=msg_type,
                task_id=task_id,
                payload={
                    "status": status,
                    "result": task.get("result"),
                    "error": task.get("error"),
                    "title": task.get("title"),
                },
            )
            self.bus.publish_outbound(outbound)
        except Exception as e:
            print(f"[BusAwareSchedulerMixin] _bus_notify error: {e}")
