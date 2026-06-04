# AgentForge TODO

## In Progress

- [x] **创建 GitHub draft PR** — 推送当前分支并基于 `main` 创建 draft pull request
  - ✅ PR：https://github.com/hetaoBackend/agentforge/pull/24

- [x] **整理当前改动并本地提交，删除大文件** — 审核本地改动范围，排除不该提交的产物，验证后创建本地提交
  - ✅ 已删除：排除两个未跟踪的大型 `openclaw-backup.tar.gz` 临时备份包
  - ✅ 验证：`git diff --check` 通过；`make check` 通过，`117 passed`；`node --check channels/weixin_bridge/index.mjs` 通过；`node --test taskboard-electron/src/renderer/traceSteps.test.mjs` 通过，`5 passed`；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过

- [x] **增强 Weixin channel 会话与图片能力** — 微信默认同一会话连续续聊，支持 `/new` 开启新 session，并打通微信图片上行到任务与生成图片下行到微信
  - ✅ 已实现：Weixin 按 `account_id:peer_id` 维护当前 task/session，普通消息默认续聊已有 session，`/new` 或 `/new <prompt>` 可清空并开启新 session
  - ✅ 已实现：微信图片上行由 bridge 下载/解密到本地，Python channel 写入任务 `image_paths` / `prompt_images`
  - ✅ 已实现：任务生成图片下行时收集 `generated_image` 事件和 markdown 本地图片引用，隐藏本地路径并让 bridge 上传/发送图片
  - ✅ 验证：`uv run pytest -q tests/test_weixin_channel.py` 通过，`11 passed`；`node --check channels/weixin_bridge/index.mjs` 通过；`make check` 通过，`116 passed`

- [x] **移除 Feishu 执行过程过长时退化为代码块的展示** — 保留飞书元素数量保护，但长执行历史使用普通 markdown 分块，不再渲染为带行号的代码块
  - ✅ 已确认：代码块 fallback 不是必须，只是此前用于规避飞书卡片元素数量上限的粗糙方案
  - ✅ 已修复：超过逐行元素上限时改为普通 markdown 分块，不再包裹三反引号代码块
  - ✅ 验证：`make check` 通过，`112 passed`；renderer node tests 通过，`11 passed`；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过

- [x] **将 Feishu 执行过程改为图标化步骤摘要并隐藏 JSON 细节** — 避免折叠面板把工具参数、搜索动作和命令输出渲染成 JSON/代码块墙，改为 Agentara 风格的可扫读步骤摘要
  - ✅ 已实现：Feishu trace 事件改为单行图标摘要，如 `⌕ 网页搜索 ...`、`▣ 调用工具 ...`、`$ 执行命令 ...`
  - ✅ 已实现：工具参数、搜索 action 和长命令输出只抽取可读摘要，不再直出 JSON/dict 或整段多行输出
  - ✅ 验证：`make check` 通过，`112 passed`；renderer node tests 通过，`11 passed`；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过

- [x] **将桌面端 Execution Events 升级为 Agentara 风格步骤时间线** — 把任务详情中的结构化执行事件聚合为可折叠步骤列表，展示 thinking、工具调用、命令执行、搜索、文件变更与最终结果摘要
  - ✅ 已实现：新增 `traceSteps.mjs` 聚合器，将 raw events 按时间排序、合并连续 thinking/assistant chunk，并格式化工具、命令、搜索、文件变更和生成图片事件
  - ✅ 已实现：桌面端任务详情的 `Execution Events` 改为 `Show N steps` 折叠时间线，保留工具参数、返回、命令输出等详情
  - ✅ 验证：renderer node tests 通过，`11 passed`；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过；本地 Chrome 视觉检查通过
- [x] **构建 DMG 分发包** ✅ — backend 经 PyInstaller 重建（29M），electron-forge 打包出 `.app`；因 `appdmg` 原生依赖在 Node 26 下编译失败，改用 `hdiutil` 从 `.app` 生成 DMG（含 /Applications 拖拽链接）
  - 产物：`taskboard-electron/out/make/dmg/AgentForge-1.0.0-arm64.dmg`（149M）
  - 验证：`hdiutil verify` 校验通过

- [x] **修复图片生成 Feishu 实际展示** — 继续排查图片生成任务只发本地路径、缺少折叠执行过程的问题，确保 Feishu 最终消息可直接看到图片和执行过程
  - ✅ 已确认：`#320` 结构化卡片实际带了 `img_key`，但因执行过程面板拆成 334 个元素触发飞书 `element exceeds the limit`，随后 fallback 成 legacy markdown，只剩本地路径
  - ✅ 已修复：执行过程超过 80 行时改为折叠面板内 markdown/code block 分块，真实 `#320` 数据重建后卡片元素数降为 8
  - ✅ 已修复：图片上传成功时 Feishu 正文隐藏本地 generated_images 路径，只展示“已生成 N 张图片。”和图片元素
  - ✅ 验证：`make check` 通过，`109 passed`

- [x] **修复图片生成任务结果丢失** — 排查 Codex 图片生成 case 中最终回复被 Skill 读取内容替代的问题，确保生成结果正确落库并返回到 Feishu/前端
  - ✅ 已确认：任务 `#319` 的第二次 run 把整段 Codex JSONL 存成了 `result`，但图片实际生成在 `~/.codex/generated_images/019e6224-.../`
  - ✅ 已修复：Codex 空最终消息不再回退 raw JSONL；会按 thread id 查找 generated images，落 `generated_image` 与 `image_content` 事件，并把图片路径摘要写入结果
  - ✅ 已修复：Feishu 完成通知会读取生成图片事件、上传图片并在最终卡片中展示图片元素
  - ✅ 验证：`make check` 通过，`107 passed`

- [x] **实现中间工具调用与返回结果展示** — 新增 agent trace 事件归一化层，展示 Claude/Codex 的工具调用、命令输出、工具返回和文件/搜索等中间事件
  - ✅ 已实现：后端将 Claude `tool_use/tool_result` 和 Codex `command_execution/mcp_tool_call/web_search/file_change` 归一化为稳定事件类型，并对常见密钥字段脱敏
  - ✅ 已实现：Feishu running card 的折叠面板改为“执行过程”，实时追加 assistant、工具调用、工具返回、命令、文件变更、搜索和错误事件
  - ✅ 已实现：桌面端 Execution Events 可读化展示 trace JSON，并在任务运行时刷新；live raw stream 也能识别常见工具块
  - ✅ 验证：`make check` 通过，`103 passed`；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过

- [x] **调查中间工具调用与返回结果展示方案** — 对照当前 AgentForge/Feishu 流式事件链路，梳理可展示工具调用、命令输出和工具返回结果的实现路径
  - ✅ 已确认：后端当前只向实时 listener 推送 `assistant` 文本事件，Claude 的 `tool_use/tool_result` content block 会被忽略，Codex 的命令/MCP 工具事件只入库不流式推送
  - ✅ 已整理：可选方案包括前端 raw JSON 解析、后端归一化事件层、以及 raw trace 审计视图；推荐以后端归一化事件层为主

- [x] **补齐 Claude Code 模式飞书流式输出** — 开启 Claude CLI partial message chunks，并将 Claude partial/cumulative assistant 消息转成增量事件推送给飞书 running card
  - ✅ 已修复：所有 Claude stream-json 命令统一带 `--include-partial-messages`
  - ✅ 已修复：Claude assistant partial/cumulative 文本按 message id 去重，只向 Feishu writer 推送新增内容
  - ✅ 验证：`make check` 通过，`86 passed`

- [x] **修复流式输出链路问题** — 去掉飞书侧二次 token 拆分，串行化 Feishu PatchMessage 更新，并让任务完成后的 `/output` 接口回落到最新 run 的 `raw_output`
  - ✅ 已修复：飞书 streaming writer 现在按 agent 原始 assistant 事件追加内容，不再拆词做本地打字机效果
  - ✅ 已修复：Feishu PatchMessage 更新增加 in-flight/dirty 状态，避免并发 patch 乱序覆盖
  - ✅ 已修复：`/api/tasks/{id}/output` 在任务结束后回落读取最新 run 的 `raw_output`
  - ✅ 验证：`make check` 通过，`82 passed`

- [x] **系统 review 流式输出链路** — 梳理后端 CLI 读取、事件持久化、前端轮询展示和 Feishu 卡片更新，确认 Feishu 本地打字机拆分是主要问题，并记录并发 patch 与输出保留风险
  - ✅ 验证：`uv run pytest -q tests/test_feishu_message_rendering.py tests/test_codex_streaming_events.py` 通过，`14 passed`

- [x] **飞书 channel 流式返回消息** — 任务运行时每 5 秒向飞书推送一次当前输出，用 PatchMessage 更新同一条卡片；任务完成/失败后将该卡片更新为最终结果
  - ✅ 已实现：新建任务和 resume 任务时发送初始运行卡片，启动后台轮询线程每 5 秒 patch 一次
  - ✅ 已实现：任务结束时 patch 同一条卡片为最终结果，减少回复消息数
  - ✅ 验证：`uv run pytest -q` 通过，73 passed

- [x] **修复 Feishu 卡片展开后仍显示 truncated 内容** — 排查折叠面板完整结果的组装逻辑，确保展开后显示完整正文而不是再次裁剪后的剩余片段
  - ✅ 已修复：长结果卡片改为”折叠态仅显示 summary，展开态显示完整正文”，不再在面板外额外渲染截断预览
  - ✅ 已修复：展开区按 chunk 承载完整正文，避免 `truncated` 出现在展开内容里，也避免预览与正文重复阅读
  - ✅ 验证：`pytest -q tests/test_feishu_message_rendering.py` 通过，`7 passed`
- [ ] **起草前后端大文件拆分 RFC** — 基于 `taskboard.py` 与 `taskboard-electron/src/renderer/App.jsx` 的现状，设计可渐进落地的重构方案、模块边界与迁移节奏
- [x] **修复 macOS App 中 scheduled_at 时间未按系统时区展示** — 统一 `scheduled_at` 在前端列表展示、详情展示、编辑弹窗回填的本地时区格式，避免 `toISOString()` 导致的 UTC 偏移
  - ✅ 已修复：新增 renderer 时间工具，统一解析 offset-aware/naive 时间；`scheduled_at` 编辑弹窗回填不再走 `toISOString()`
  - ✅ 已修复：任务卡片、任务详情、heartbeat 面板和事件时间展示统一走本地时区格式化
  - ✅ 验证：`TZ=Asia/Shanghai node --test taskboard-electron/src/renderer/dateTime.test.mjs` 通过；`cd taskboard-electron && npx vite build --config vite.renderer.config.mjs` 通过
- [x] **修复 scheduler 的 naive/aware datetime 比较崩溃** — 统一 `scheduled_at` 的 `next_run_at` 存储格式，并兼容旧数据中的 offset-aware ISO 时间，避免 scheduler tick 抛出 `can't compare offset-naive and offset-aware datetimes`
  - ✅ 已修复：后端会把 offset-aware 的 `next_run_at` 归一化为本地 naive 时间存储，`get_due_tasks()` / `get_due_heartbeats()` 改为 Python 层按规范化后的 datetime 判断 due
  - ✅ 已修复：scheduler tick 与 heartbeat dedupe cooldown 都兼容旧数据里的 offset-aware ISO 时间，不再触发 naive/aware 比较异常
  - ✅ 验证：`uv run pytest -q` 通过，`61 passed`（存在既有 warning：Telegram 测试里有一个未 awaited coroutine）
- [ ] **修复 Feishu 默认通知接收人 `open_id cross app`** — 排查默认通知 fallback 使用 `open_id` 发送时的跨应用问题，并补充更安全的接收人解析与提示文案
- [x] **优化 Feishu 结果展示** — 参考 `agentara` 的消息渲染实现，梳理当前 Feishu 输出格式并改进可读性与结构化展示
  - ✅ 已完成：`channels/feishu_channel.py` 改为生成更简洁的结构化 Feishu 卡片，成功时直接展示最终结果，长文本使用折叠面板承载完整内容
  - ✅ 已完成：发送/回复链路增加 legacy markdown 卡片回退，避免新卡片不兼容时通知直接失败
  - ✅ 验证：`uv run pytest tests/test_feishu_message_rendering.py tests/test_feishu_forwarded_messages.py -q` 通过，`19 passed`
- [x] **修复转发消息时间格式测试失败** — 统一 Feishu / Telegram 转发时间按北京时间 `UTC+8` 格式化
  - ✅ 已修复：`channels/feishu_channel.py` 与 `channels/telegram_channel.py` 不再依赖进程本地时区
  - ✅ 验证：相关 3 个失败用例通过；`tests/test_feishu_forwarded_messages.py` 和 `tests/test_telegram_forwarded_messages.py` 全部通过
- [x] **rebase `codex/backend-quality-and-heartbeat` onto latest `origin/main`** — 解决 PR #6 的文本冲突并保留 heartbeat + backend quality baseline 改动
  - ✅ 已完成：`git rebase origin/main` 成功，`9ae1cdd` 被自动识别为已在上游并 dropped
  - ✅ 已确认：`git merge-base HEAD origin/main` 与 `origin/main` 均为 `6aeb72e`
  - ✅ 验证：`make check` 通过，`54 passed`
- [x] **检查并处理当前分支的 merge conflicts** — 核对 git merge/rebase 状态、未合并文件以及与 `main` 的分叉点
  - ✅ 已确认：当前无进行中的 merge/rebase，`git diff --name-only --diff-filter=U` 为空
  - ✅ 已确认：`HEAD`、`main`、`merge-base` 均为 `626f16b`，当前工作树 clean
- [x] **建立后端 lint/test/CI 基线** — 为 Python 后端接入 `ruff`、`pytest` 覆盖率和 GitHub Actions 质量门禁
  - ✅ 已完成：`pyproject.toml` 新增 `ruff` / `pytest-cov` 与 lint、pytest、coverage 配置
  - ✅ 已完成：`Makefile` 新增 `lint` / `format` / `format-check` / `test` / `test-cov` / `check`
  - ✅ 已完成：新增 `.github/workflows/ci.yml`，在 `pull_request` 和 `main` push 时执行 `make check`
  - ✅ 已完成：补充 `tests/test_channel_utils.py` 和 `tests/test_taskboard_bus.py`，提升后端基线覆盖率
  - ✅ 验证：`make check` 通过，`54 passed`，总覆盖率 `20.02%`
- [x] **Install superpowers for Codex** — followed `https://raw.githubusercontent.com/obra/superpowers/refs/heads/main/.codex/INSTALL.md`
  - ✅ Cloned `obra/superpowers` to `~/.codex/superpowers`
  - ✅ Created `~/.agents/skills/superpowers` symlink to `~/.codex/superpowers/skills`
  - ✅ Verified symlink with `ls -la ~/.agents/skills/superpowers`
- [x] **起草 Heartbeat RFC** — 明确 heartbeat 与现有 cron task 的边界、数据模型、调度行为和第一版实现范围
  - ✅ 已完成：新增 `docs/rfc-heartbeat.md`，覆盖目标/非目标、cron vs heartbeat、数据模型、决策协议、调度与去重、API/UI 草案和 rollout plan
- [x] **实现 Heartbeat MVP** — 提供后端调度、decision tick、REST API 和 macOS App 管理界面
  - ✅ 后端：新增 heartbeat schema、ticks、dedupe、scheduler decision tick 和 `/api/heartbeats*` 端点
  - ✅ 前端：新增 Tasks / Heartbeats 双视图、Heartbeat 创建/编辑 modal、run/pause/resume/delete 操作和 tick detail panel
  - ✅ 验证：`uv run pytest tests/test_heartbeat.py -q` 通过，renderer `vite build` 通过
- [x] **增加 Heartbeat Tick 日志观测性** — 支持查看 running/completed heartbeat tick 的实时输出与历史日志
  - ✅ 后端：heartbeat tick 新增 `raw_output` 持久化和 live output cache，提供 `/api/heartbeats/:id/ticks/:tick_id/output`
  - ✅ 前端：Heartbeat detail 新增 Tick Log 面板，可查看选中 tick 的实时日志和历史输出
  - ✅ 验证：`uv run pytest tests/test_heartbeat.py -q` 通过，renderer `vite build` 通过

## Critical - Security

- [x] **SQL 注入防护** — `taskboard.py:319` `update_task` 方法中 kwargs key 直接拼入 SQL，需对列名做白名单校验
  - ✅ 已修复：增加了 `ALLOWED_TASK_COLUMNS` frozenset 白名单，非法列名抛 ValueError
- [~] **API 敏感信息泄露** — `taskboard.py:1259-1283` `/api/channels/status` 返回了 bot_token 等敏感凭据，应改为只返回 `configured: true/false`
  - ✅ `/api/channels/status` 已修复，仅返回 `bool(token)`
- [x] **CORS 过于宽松 + 无 CSRF 防护** — `Access-Control-Allow-Origin: *` 允许任意来源，恶意本地网页可直接调用后端 API，需限制来源并添加 CSRF token
  - ✅ 已修复：CORS 限制为 `null`（Electron）+ `http://localhost:*`，不再使用 `*`
- [x] **任意文件读取** — `taskboard.py:706-744` `image_paths` 接受任意路径并读取文件内容，需做路径白名单/沙箱校验
  - ✅ 已修复：增加 `_is_safe_image_path()` 用 realpath 解析后验证只允许 `~` 和 `/tmp` 下的路径

## Important - Stability & Correctness

- [x] **热重载后 running 任务卡死** — 进程重启后 SQLite 中仍有 `running` 状态任务，新进程不会拾取，永远卡住
  - ✅ 已修复：`_init_db()` 末尾新增启动时清理逻辑，将残留 `running` 任务重置为 `failed` 并关闭未完成的 `task_runs` 记录


- [x] **数据库线程安全** — `taskboard.py:126` 使用 `check_same_thread=False` 但部分 DB 操作（~305, 346, 350 行）缺少 `self.lock` 保护
  - ✅ 已修复：所有 DB 方法均用 `with self.lock:` 保护
- [x] **任务调度竞态条件** — `taskboard.py:620-627` `_spawn_task` 先更新 DB 状态再加入 `_active_tasks`，线程立即崩溃时可能被重复拾取
  - ✅ 已修复：现在先加入 `_active_tasks` 再更新 DB 状态
- [x] **事件缓存内存泄漏** — `taskboard_bus.py:285` `_outbound_cache` 只增不减，长时间运行后内存持续增长，需加大小限制或 TTL 清理
  - ✅ 已修复：增加 `_CACHE_MAX_TASKS = 1000` 上限，超出时淘汰最旧条目
- [x] **进程退出直接 SIGKILL** — `taskboard.py:564-575` 关闭时直接 SIGKILL 子进程，应先 SIGTERM 等待优雅退出再 fallback 到 SIGKILL
  - ✅ 已修复：先发 SIGTERM，等待最多 5 秒，超时再 SIGKILL
- [~] **前端 API 错误静默吞掉** — `App.jsx:268-280` 请求失败时返回空数组无任何提示，需添加错误通知机制
  - ✅ `poll()` 已有 try/catch + 底部 toast 通知
  - ❌ **遗漏**：`handleCreate()`、`handleAction()`、`handleRespond()` 等操作函数仍无错误处理，需补全
- [x] **缺少事务回滚** — 多步 DB 操作未使用事务，部分失败时数据可能不一致
  - ✅ 已修复：增加 `transaction()` context manager，`finish_run_and_update_task`、`delete_task`、`add_dependencies_batch` 等均已使用

## AgentForge Skill 修复

- [x] **P0: 添加 `retry`、`delete` 方法到 CLI 和 SKILL.md**
  - ✅ 已修复：CLI 新增 `--method retry` 和 `--method delete`，SKILL.md 同步更新文档
- [x] **P0: 解决 `requests` 依赖问题** — 改用标准库 `urllib.request`
  - ✅ 已修复：`import requests` 替换为 `urllib.request`/`urllib.error`/`urllib.parse`，零外部依赖
- [x] **清理 `__pycache__` 中的旧 pyc 文件** — `taskforge_api.cpython-312.pyc` 残留
  - ✅ 已修复：删除整个 `__pycache__` 目录
- [x] **改进错误提示** — 区分网络错误 vs API 错误
  - ✅ 已修复：Connection refused 显示 AgentForge 未运行提示，HTTP 错误显示状态码+服务端详情，其他网络错误单独提示
- [x] **改进路径处理** — CLI 脚本路径使用绝对路径
  - ✅ 已修复：SKILL.md 新增 Script Path 章节，说明绝对路径用法和 `$SKILL_DIR` 解析方式
- [x] **版本标注** — 添加版本号和 Last Verified 日期
  - ✅ 已修复：SKILL.md frontmatter 新增 `version: 1.1.0` 和 `last_verified: "2026-02-13"`

## Landing Page

- [x] **创建 AgentForge 落地页** — 在项目根目录创建 `index.html`，包含完整的深色主题营销页面
  - ✅ 已完成：单文件 HTML，内联 CSS/JS，无外部依赖，9 个区段（导航/Hero/特性/架构/编排/集成/API/快速开始/页脚）
  - ✅ 响应式设计（768px/480px 断点），滚动动画，代码复制按钮，平滑滚动

## Minor - Quality of Life

- [x] **Create PR for current branch changes** — open a GitHub PR from the current branch into `main`
  - ✅ PR opened: #5
- [x] **移动端错误通知不清晰** — Telegram 通知的错误消息是原始 CLI 输出，无标题无结构
  - ✅ 已修复：`taskboard.py` 新增 `_extract_error_summary()` 解析 stream-json 提取清晰错误摘要，`task.error` 改存 clean summary（原始输出保留在 `run.raw_output`）
  - ✅ Telegram 通知格式改为：`❌ Task #N: <title>\n<error>\n\n/status N`，origin 任务也包含标题
- [ ] **轮询效率低** — `App.jsx:911` 前端每 1-3 秒轮询，可考虑 SSE 或 WebSocket 替代
- [x] **日志使用 print** — 整个后端用 `print()` 输出日志，应改为 `logging` 模块，支持分级过滤
- [x] **请求体大小无限制** — `taskboard.py:1627` `_read_body` 未校验 Content-Length 上限，可被超大请求耗尽内存
  - ✅ 已修复：`MAX_BODY_SIZE = 10MB`，超出返回 413
- [x] **前端日期输入无校验** — `App.jsx:616` `scheduled_at` 未验证 `new Date()` 返回值是否有效
  - ✅ 已修复：使用 `isNaN(localDate.getTime())` 校验，无效日期显示错误提示

---

## 新功能需求

- [x] **飞书 `/ccu` 用量统计命令** ✅
  - 使用 claude-monitor 库的 `analyze_usage()` + P90 动态限额
  - 显示 Cost%、Token%、Messages% 三个进度条，与 claude-monitor CLI 对齐
  - Token 统计排除 cache tokens（仅 input+output），与官方一致



- [ ] **支持话题中转发聊天记录的处理**
  - 需要设计并实现一个功能，让系统可以处理在话题中用户转发的聊天记录
  - 考虑点：
    - 如何解析转发的消息格式
    - 如何将转发内容整合到当前话题的上下文中
    - 是否需要保留原始发送者和时间戳信息
  - 📋 已生成实现计划: `docs/forwarded-message-support-plan.md`
  - ✅ 已实现代码：
    - `channels/feishu_channel.py`: 添加 `_extract_forwarded_content()` 和 `_format_forwarded_prompt()`
    - `channels/telegram_channel.py`: 添加 `_format_forwarded_text()`
  - ✅ 已编写测试用例：
    - `tests/test_feishu_forwarded_messages.py`
    - `tests/test_telegram_forwarded_messages.py`
  - ✅ 已更新文档：README.md 中说明转发消息功能

- [x] **移动端工作目录切换** ✅
  - 新增 `channels/dir_utils.py`，实现两种切换方式：
    - **方案一**：`/dir <path>` 或 `/cd <path>` 指令，持久化到 DB，立即回复确认
    - **方案二**：Claude (claude-haiku) 自动从 prompt 中提取显式路径，无需用户输入指令
  - Telegram/Slack/Feishu 三个 channel 均已接入

- [x] **IM 侧切换 coding agent** ✅
  - 新增 `channels/agent_utils.py`，支持 `/agent claude` / `/agent codex` 命令
  - Feishu/Telegram/Slack 三个 channel 均已接入，创建任务时自动使用当前 default agent
  - 写入全局 `default_agent` setting，Forge App 前端 Settings 面板自动同步显示
  - 修复 API 层 `POST /api/tasks` 和 DAG 创建时 agent 字段也使用 `default_agent` 作为 fallback


  - 设计一个持久化的记忆系统，可以记录和检索：
    - ronny (用户) 的个人信息、偏好、历史交互
    - 小白 (Claude Agent) 的信息、能力、上下文记忆
  - 考虑点：
    - 记忆的数据结构设计
    - 长期记忆的存储格式：用户画像、对话摘要、重要决策等
    - 如何检索和更新长期记忆

- [x] **支持编辑 scheduled task + fork completed/cancelled/failed task** ✅
  - 编辑：对 pending/scheduled/blocked 状态的任务，支持修改 prompt、schedule 等字段
  - Fork：对 completed/cancelled/failed 状态的任务，支持克隆为新任务并可修改后提交
  - 后端：修复 ALLOWED_TASK_COLUMNS，新增 `clear_dependencies()`，新增 `PUT /api/tasks/{id}` 端点
  - 前端：扩展 NewTaskModal 支持 edit/fork 模式，TaskCard 新增编辑和 fork 按钮

- [x] **实现 Electron 应用热更新功能** ✅
  - 目标：在 `npm start` 开发模式下实现代码修改自动热更新
  - 实现方案：
    - **前端热更新**：Vite 已支持 React HMR，基本就绪
    - **Python后端热重载**：添加文件监听，自动重启 Python 进程
    - **主进程热更新**：配置 Vite 监听主进程文件变化
  - 技术要点：
    - 使用 `chokidar` 监听 Python 文件变化
    - 实现优雅的进程重启机制
    - 配置 Vite 开发服务器监听主进程文件
  - 实现状态：✅ 已完成
    - 安装 `chokidar` 依赖
    - 修改 `main.js` 添加热重载功能
    - 配置 `vite.main.config.mjs` 和 `vite.renderer.config.mjs`
    - 测试验证：Python 进程 PID 变化确认热重载工作正常
  - 预计工作量：2-3小时（实际完成时间：约30分钟）
  - 难度评估：⭐⭐⭐☆☆（中等偏易）

- [x] **修复 macOS App 创建任务的 Feishu 卡片通知** — 排查 UI 创建任务的结果通知是否绕过当前 Feishu 渲染链路，并统一到优化后的卡片发送逻辑
  - ✅ 已完成：Electron `package/make` 现在会在打包前自动重建 `taskboard-electron/resources/taskboard`，避免 macOS App 继续携带旧的 Python backend
  - ✅ 已完成：新增 `taskboard-electron/scripts/build-backend.mjs`，统一复用 `make build-backend` 构建 bundled backend；`Makefile` 同步避免重复构建
  - ✅ 验证：`uv run pytest tests/test_feishu_message_rendering.py tests/test_feishu_forwarded_messages.py -q` 通过，`19 passed`
  - ✅ 验证：`node taskboard-electron/scripts/build-backend.mjs` 通过，并生成新的 `taskboard-electron/resources/taskboard`
