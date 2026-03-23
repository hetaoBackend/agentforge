# Weixin Channel MVP Design

**Goal**

为 AgentForge 增加一个 text-only 的 Weixin channel，支持收消息创建任务、回复结果消息续聊、任务完成后回发文本通知。

**Why this design**

当前仓库的 channel 体系运行在 Python 后端内，而 `@tencent-weixin/openclaw-weixin` 运行在 Node.js 环境中并封装了微信接入细节。最小风险方案是保持 Python 侧只负责接入 AgentForge 的 `MessageBus` / `TaskScheduler`，把微信侧协议处理放在一个独立的 Node sidecar 里。

**Architecture**

- `channels/weixin_channel.py`
  Python `Channel` 适配层，负责：
  - 启动/停止 Node bridge 子进程
  - 接收入站事件并创建/恢复任务
  - 维护 `task_id -> origin` 与 `notification_id -> task_id` 映射
  - 将任务完成/失败事件转发给 bridge
- `channels/weixin_bridge/`
  Node sidecar，负责：
  - 封装 `openclaw-weixin` 的生命周期
  - 统一输出 JSON 事件给 Python
  - 接收 Python 的发送命令并回发微信消息

**MVP scope**

- 支持文本消息
- 支持新建任务
- 支持“回复 bot 的结果消息”触发 resume
- 支持默认工作目录和默认 agent
- 不实现图片/文件/typing
- 不实现多账号 UI，先保留配置字段

**Data model**

- `task_origin[task_id] = { account_id, peer_id, context_token, message_id }`
- `notification_map[message_id] = task_id`

**Error handling**

- bridge 启动失败时记录日志并禁用 channel
- bridge 发送失败时不影响任务状态，只记录日志
- 输入事件缺字段时丢弃并记录日志

**Testing**

- Python 测试覆盖：
  - bridge 事件创建任务
  - bridge 事件触发 resume
  - outbound 结果转桥接发送命令
  - bridge 进程启动/停止行为

