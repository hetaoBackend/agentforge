# 实现计划：支持话题中转发聊天记录的处理

## 概述

用户在飞书/Telegram 等渠道中转发聊天记录给 AgentForge 时，需要能够解析转发内容并将其整合到任务上下文中。

## 现状分析

### 当前消息处理能力

| 消息类型 | 飞书 | Telegram |
|----------|------|----------|
| 纯文本 | ✅ | ✅ |
| 富文本(post) | ✅ | ❌ |
| 图片 | ✅ | ✅ |
| 转发消息 | ❌ | ❌ |
| 引用回复 | ✅ (通过 parent_id/root_id) | ✅ (通过 reply_to_message) |

### 相关代码位置

- `channels/feishu_channel.py:395-664` — Feishu 消息处理入口 `_handle_inbound`
- `channels/telegram_channel.py:242-332` — Telegram 消息处理入口 `_handle_text_message`

## 技术方案

### 方案 A: 扩展现有 Message 类型解析（推荐）

#### 核心思路
在各渠道的消息处理中，检测并解析转发类型的消息，提取其中的原始内容（发送者、时间戳、文本等），然后将其格式化后追加到任务的 prompt 中。

#### 实现步骤

##### 1. 飞书渠道转发消息支持

**飞书 API 中的转发消息格式:**
- 消息类型可能为 `forward` 或 `post` 类型中的特殊标记
- 需要解析 `content` 中的转发链结构

**实现:**
```python
# 在 feishu_channel.py 中新增
def _extract_forwarded_content(self, message) -> Optional[dict]:
    """解析飞书转发消息内容"""
    msg_type = message.message_type

    # 检查是否为转发消息
    # 1. 消息类型可能是 "forward"
    if msg_type == "forward":
        try:
            content = json.loads(message.content)
            return {
                "type": "forward",
                "sender_name": content.get("sender_name", "Unknown"),
                "sender_id": content.get("sender_id"),
                "timestamp": content.get("create_time"),
                "text": content.get("text", ""),
                "images": content.get("images", [])
            }
        except json.JSONDecodeError:
            pass

    # 2. post 类型中可能包含转发引用
    elif msg_type == "post":
        try:
            post_body = json.loads(message.content)
            lang_body = post_body.get("content", post_body.get("zh_cn", {}))

            # 检查是否有引用/转发标记
            for para in lang_body.get("content", []):
                for elem in para:
                    if elem.get("tag") == "quote":
                        # 引用消息
                        quote_text = elem.get("text", "")
                        quote_sender = elem.get("user", {}).get("name", "Unknown")
                        return {
                            "type": "quote",
                            "sender_name": quote_sender,
                            "text": quote_text
                        }

        except json.JSONDecodeError:
            pass

    return None


def _format_forwarded_prompt(self, original_content: str, forwarded: dict) -> str:
    """将转发内容格式化到 prompt 中"""
    if not forwarded:
        return original_content

    parts = []

    # 添加时间戳（如果有）
    if forwarded.get("timestamp"):
        from datetime import datetime
        ts = datetime.fromtimestamp(forwarded["timestamp"])
        parts.append(f"[转发于 {ts.strftime('%Y-%m-%d %H:%M')}]")

    # 添加发送者信息
    sender = forwarded.get("sender_name", "未知用户")
    parts.append(f"[转发自: {sender}]")

    parts.append("\n--- 转发内容 ---")
    parts.append(forwarded.get("text", ""))

    # 如果有原始内容，在转发内容之后添加
    if original_content.strip():
        parts.append("\n--- 用户附加消息 ---")
        parts.append(original_content)

    return "\n".join(parts)


def _handle_inbound(self, data) -> None:
    """修改后的消息处理入口"""
    # ... 前面代码不变 ...

    # 新增：检测转发消息
    forwarded = self._extract_forwarded_content(message)
    if forwarded:
        content = self._format_forwarded_prompt(content, forwarded)
        # 添加图片（如果有）
        if forwarded.get("images"):
            for img_info in forwarded["images"]:
                img_path = self._download_image(message.message_id, img_info.get("image_key"))
                if img_path:
                    image_paths.append(img_path)

    # ... 后续代码不变，使用更新后的 content 和 image_paths ...
```

##### 2. Telegram 渠道转发消息支持

**Telegram API 中的转发消息:**
- `update.message.forward_from` — 原始发送者信息
- `update.message.forward_date` — 原始消息时间
- `update.message.forward_from_chat` — 如果是从频道/群组转发的

**实现:**
```python
# 在 telegram_channel.py 中修改 _handle_text_message
async def _handle_text_message(self, update: "Update", context: "ContextTypes.DEFAULT_TYPE") -> None:
    # ... 前面权限检查代码不变 ...

    text = (update.message.text or "").strip()
    chat_id = update.effective_chat.id

    # 新增：检测转发消息
    forwarded_content = None
    if update.message.forward_from or update.message.forward_date:
        sender_name = "未知用户"
        if update.message.forward_from:
            sender = update.message.forward_from
            sender_name = (
                f"@{sender.username}" if sender.username
                else f"{sender.first_name} {sender.last_name or ''}".strip()
            )
        elif update.message.forward_from_chat:
            chat = update.message.forward_from_chat
            sender_name = chat.title or chat.username or "未知频道"

        # 格式化时间
        from datetime import datetime
        ts = datetime.fromtimestamp(update.message.forward_date)
        time_str = ts.strftime('%Y-%m-%d %H:%M')

        forwarded_content = f"[转发自: {sender_name} | 时间: {time_str}]\n{text}"
        # 清空原始 text，避免重复
        text = forwarded_content

    # ... 后续代码不变，使用更新后的 text ...
```

##### 3. 数据模型更新（如需要）

当前 Task 数据类已支持 `prompt` 字段，转发内容可以通过格式化后的文本直接注入，无需修改数据库结构。

##### 4. 前端展示优化（可选）

在 `taskboard-electron/src/renderer/App.jsx` 中，可以展示转发来源标签：

```jsx
// 在任务详情中显示
{task.prompt?.includes('[转发自:') && (
  <div className="tag forwarded-tag">
    <span>📨 来自转发的消息</span>
  </div>
)}
```

### 方案 B: 独立的 forward 消息类型处理

为转发类型创建单独的处理路径，保留原始消息结构作为任务 metadata。

**优点:**
- 保留完整的转发链结构
- 支持未来扩展（如多级转发、图片附件等）
- 便于前端做专门展示

**缺点:**
- 需要修改数据模型，增加 `forward_metadata` 字段
- 实现更复杂

**推荐优先实现方案 A，如有高级需求再升级到方案 B。**

## 实施计划

### Phase 1: 飞书转发消息支持（优先）

1. 在 `feishu_channel.py` 实现 `_extract_forwarded_content` 方法
2. 实现 `_format_forwarded_prompt` 方法
3. 修改 `_handle_inbound` 集成转发检测
4. 测试转发场景（单条消息、多图片转发）

### Phase 2: Telegram 转发消息支持

1. 修改 `telegram_channel.py` 的 `_handle_text_message` 方法
2. 添加 `forward_from`/`forward_date` 检测逻辑
3. 测试转发场景（个人转发、频道转发）

### Phase 3: 优化与测试

1. 添加日志记录转发消息的解析详情
2. 更新 README.md 文档说明转发功能
3. 端到端测试：转发 → 创建任务 → Agent 收到完整上下文

## 风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| 飞书 API 转发格式可能变化 | 添加详细日志，记录原始 content 结构 |
| 转发内容过长导致 token 超限 | 限制转发内容长度（如 2000 字符） |
| 隐私问题（转发他人消息） | 在格式化时保留"[转发自: 用户名]"标注 |
| 频道/群组转发权限处理 | 检查 `forward_from_chat` 并显示频道名称 |

## 关键文件清单

- `channels/feishu_channel.py` — 飞书转发消息实现
- `channels/telegram_channel.py` — Telegram 转发消息实现
- `README.md` — 文档更新
- `todo.md` — 进度追踪

## 预估工作量

| 阶段 | 预估时间 |
|------|----------|
| Phase 1: 飞书支持 | 2-3 小时 |
| Phase 2: Telegram 支持 | 1-2 小时 |
| Phase 3: 测试与文档 | 1 小时 |
| **总计** | **4-6 小时** |
