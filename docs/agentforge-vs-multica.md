# AgentForge vs Multica 深度对比报告

## 1. 一句话结论 (TL;DR)

**AgentForge 是一款本地优先、单人使用的 macOS 桌面 App，把 Claude Code/Codex 变成可调度、可串联(DAG)、可远程聊天触发的"个人自动化流水线"；Multica 是一个团队优先、可自托管的开源平台，把约 12 种 coding-agent CLI 变成有 profile、可被"派活"的"AI 队友",核心是人+Agent 混合团队的项目管理与协作层。** 一个解决"我一个人如何编排自己的 agent",另一个解决"一个团队如何协作管理一群 agent"。

---

## 2. 概览对比表

| 属性 | AgentForge | Multica |
|---|---|---|
| 一句话定位 | 本地 macOS 桌面 App，kanban 式编排 AI coding agent | 开源 managed-agents 平台，"把 coding agent 变成真正的队友" |
| 核心隐喻 | 看板/流水线 (Queue→Running→Done) | 队友/雇员 ("Your next 10 hires won't be human") |
| 目标用户 | macOS 上的个人开发者 / 技术 power user | 开发团队 / 技术组织 (多人多机协作) |
| 部署形态 | macOS DMG 桌面 App (Electron+Python) | 自托管 (Docker Compose / 单 Go 二进制 / K8s Helm) + 托管云 |
| 后端语言/栈 | Python (单文件 `http.server`) + Electron | Go (Chi + sqlc + gorilla/websocket) + Next.js 16 |
| 数据库 | SQLite (`~/.agentforge/tasks.db`) | PostgreSQL 17 + pgvector |
| 实时传输 | HTTP 轮询 (无 WebSocket) | WebSocket (gorilla/websocket) |
| 网络监听 | 仅本地回环 `127.0.0.1:9712` | 后端 8080 / 前端 3000 (可远程访问) |
| 支持的 Agent | Claude Code (默认) + OpenAI Codex | 约 12 种 CLI (Claude Code/Codex/Copilot/Cursor/Gemini 等) |
| 调度能力 | immediate / delayed / scheduled_at / cron + heartbeat watcher | Autopilots (cron / webhook / 手动) |
| 多 Agent 协作 | DAG 流水线 + 依赖注入 + "agent 派生 agent" | Squads (leader agent 委派) + 队友式分配 |
| 远程/聊天控制 | Telegram / Slack / Feishu / WeChat 聊天频道 | iOS App + Web 看板 (无聊天频道证据) |
| 团队/多租户 | ❌ 单人单机 | ✅ Workspace 级隔离、多成员 |
| 许可证 | MIT (纯开源) | 修改版 Apache 2.0 (source-available，限制 SaaS 转售) |
| 商业模式 | 自建/下载 DMG，无付费/账号/遥测 | 开源自托管 + 托管云 (云端定价未公开) |
| 成熟度信号 | 单仓库，作者驱动，有 pytest 套件 | 约 35k stars / 4.3k forks，v0.3.15 (2026-06-03) |

---

## 3. 四个维度逐项对比

### 3.1 产品定位与目标用户

**AgentForge** 定位为"本地优先的 agent 编排层":把 AI coding agent 变成一支"可管理、可调度的劳动力",但其使用单位是**单个开发者在自己 Mac 上**。README 标语是"Orchestrate AI coding agents from your Mac — schedule, monitor, and chain Claude Code tasks on a kanban board"。它的隐喻是**看板/流水线**,差异化卖点是"agents that spawn agents"(运行中的任务通过本地 REST API 创建子任务、搭建 DAG)。目标用户明确要求 macOS 12.0+、Python 3.12+、Node 18+、PATH 上有 Claude Code CLI。聊天频道(Telegram/Slack/Feishu/WeChat)服务的是"想从手机或团队群里触发/监控任务"的同一个个人用户。

**Multica** 定位为"开源 managed-agents 平台",隐喻是**队友/雇员**:你像给人类同事派活一样把 issue 指派给 agent,agent 有 profile、出现在 assignee 下拉里、在看板上、会评论、会创建 issue、会主动上报 blocker。其官方标语极具攻击性:"Your next 10 hires won't be human",落地页副标题是"Project Management for Human + Agent Teams"。目标用户是**有多 agent 协作痛点的开发团队/技术组织**(agent 跑在不同机器、不同 runtime,队友不知道哪些已被自动化),并强调自托管与数据主权。第三方分析明确指出"solo developers running occasional tasks may not need it yet"。

**关键对比**:两者都"管理 agent",但 AgentForge 的管理单位是**任务/流水线**(我编排我的活),Multica 的管理单位是**团队成员**(我们给队友派活)。AgentForge 是个人生产力工具;Multica 是团队协调平台。

### 3.2 架构与技术实现

**AgentForge** 是经典的两进程 Electron + Python 模型:
- Electron 主进程 (`main.js`) 启动时 spawn Python 后端、退出时 kill;dev 下跑 `uv run taskboard.py`,打包后跑 PyInstaller 单文件二进制 `taskboard`;spawn 前用 lsof 杀掉 9712 端口的残留进程;轮询 `/api/health` (15s 超时);调 `powerSaveBlocker` 防止长任务期间 Mac 休眠。
- Python 后端 (`taskboard.py`,约 4093 行) 是单文件 `http.server.BaseHTTPRequestHandler` REST API,**仅绑定 `127.0.0.1:9712`(回环,非 0.0.0.0)**。核心类:`TaskDB`(SQLite + `threading.RLock` + 启动恢复,把孤儿"running"任务标记为 failed)、`AgentExecutor`(跑 `claude -p` 或 `codex exec --json`)、`TaskScheduler`(每 2 秒轮询的守护线程,跟踪 process group,SIGTERM→SIGKILL 优雅关闭)。
- `MessageBus` (`taskboard_bus.py`) 用线程安全队列解耦聊天频道与调度器。React 19 渲染层**只通过 `fetch()` 轮询**,无 WebSocket。

**Multica** 是三层架构,作为已有 CLI 之上的**控制层**(非自身计算引擎):
- 前端 Next.js 16 (App Router);后端 **单个 Go 二进制**(Chi router + sqlc + gorilla/websocket),暴露 REST + WebSocket,自托管端口 8080;持久层 **PostgreSQL 17 + pgvector**。
- 真正的 agent 执行发生在 **Runtime** 上——最常见是用户机器上的 **本地 Go daemon**(`multica daemon start`,刻意**不**放进 Docker),自动探测 PATH 上的 CLI (`claude`/`codex`/`copilot`/`cursor-agent`/`gemini` 等) 并本地执行;另有云 Runtime(roadmap/waitlist)。
- 任务生命周期是显式状态机:`enqueue → claim → start → complete/fail`,进度通过 **WebSocket** 实时推送。

**关键对比**:
- **实时性**:Multica 用 WebSocket 推送,AgentForge 用 HTTP 轮询——Multica 在实时性上架构更现代。
- **网络边界**:AgentForge 后端只听本地回环,天然不可远程访问(远程能力靠聊天频道外联);Multica 后端设计为可被多机 daemon 和远程团队访问。
- **执行模型**:两者都不自己实现 agent,都调用外部 CLI;但 Multica 把"服务器协调状态 + 本地 daemon 执行代码"分离,AgentForge 是单机内 spawn 子进程。
- **可信度提示**:Multica 关于 pgvector "powers semantic search / skill matching" 的说法在源码中**未被证实**(详见第 7 节)。

### 3.3 功能特性对比

| 维度 | AgentForge | Multica |
|---|---|---|
| 任务看板 | Queue / Running / Done 三列,实时流式输出(解析 stream-json) | 看板上 agent 是一等 assignee,有 profile / 评论 / 活动时间线;具体列名未在公开来源记录 |
| 调度 | 4 种 ScheduleType (immediate/delayed/scheduled_at/cron) + max_runs | Autopilots:cron / webhook / 手动触发,每次自动建 issue 并路由 |
| 多 Agent 编排 | DAG (task_dependencies 表、BLOCKED 状态、级联执行、inject_result 注入上游输出) | Squads:leader agent 委派给成员,路由随团队增长保持稳定 |
| Agent 派生 Agent | ✅ 内置 Claude Code skill (`skills/agentforge/`),运行中任务调本地 REST API 建子任务/DAG | 通过 Squads/leader 委派,但非"任务内自发派生子任务"的等价机制 |
| 自主 watcher | ✅ Heartbeat (cron/interval,check_prompt 返回 JSON 决策 idle/trigger/resume/notify) | Autopilots 覆盖定时,但无 heartbeat 式"条件判断决策引擎"证据 |
| 技能复用 | 单个内置 skill(用于 API 调用) | ✅ 核心差异化:每个成功方案沉淀为团队可复用 Skill ("One person's skill is every agent's skill") |
| 远程聊天控制 | ✅ Telegram / Slack / Feishu/Lark / WeChat 四个频道 | ❌ 无聊天频道证据;有 iOS App |
| 团队协作 | ❌ 单人 | ✅ Workspace 隔离、人+agent 同列分配、统一活动 feed |

### 3.4 商业模式与生态

**AgentForge**:纯开源 **MIT** 许可。以**自建/可下载的 macOS DMG** 形式分发,**无支付、无 license key、无遥测、无账号/认证代码**(后端回环 only,远程仅 CSRF)。打包用 electron-forge(maker-dmg ULFO + maker-zip),ad-hoc 代码签名,Electron fuses 加固;Python 后端打成 PyInstaller 单文件二进制嵌入 `.app`。有一个营销落地页 (vercel)。仓库内无任何闭源组件或商业层级。

**Multica**:**开源核心(open-core)混合模式**。全栈 source-available 在 GitHub(约 35k stars / 4.3k forks),可免费自托管(Docker Compose / 单 Go 二进制 / K8s Helm);另有托管云 multica.ai,**定价未公开**(仅"Start free trial"和"Talk to sales" CTA)。许可证是**修改版 Apache 2.0**:组织内部使用免费,但未经授权**不得作为托管服务转售给第三方或嵌入商业分发产品**——因此是 source-available open-core,而非纯 OSI Apache。核心隐私卖点:"Code never passes through Multica servers",本地 daemon 执行、服务器只协调任务状态和广播事件。最新 release v0.3.15 (2026-06-03)。

**关键对比**:AgentForge 是真正的宽松开源(MIT)、无商业化痕迹的个人工具;Multica 是带商业意图的 open-core(修改版 Apache + 托管云 + sales 通道),许可证刻意限制 SaaS 转售。生态广度上 Multica 明显更大(12+ agent、K8s、iOS、约 35k stars),但其成熟度证据多来自营销文案与近期第三方文章,而非使用数据。

---

## 4. 功能矩阵

| 功能 | AgentForge | Multica |
|---|---|---|
| Kanban 看板 | ✅ Queue/Running/Done | ✅ (列名未公开记录) |
| 实时输出流 | 部分 (HTTP 轮询,非 WebSocket) | ✅ WebSocket 推送 |
| 立即执行 | ✅ immediate | ✅ 手动触发 |
| 延迟执行 (N 秒后) | ✅ delayed | ❌ 无明确证据 |
| 定时单次 (datetime) | ✅ scheduled_at | 部分 (autopilot 可建一次性,但以 cron 为主) |
| Cron 周期任务 | ✅ cron (+ max_runs) | ✅ Autopilots cron |
| Webhook 触发 | ❌ | ✅ Autopilots webhook |
| DAG / 依赖编排 | ✅ task_dependencies + BLOCKED + inject_result | 部分 (Squads leader 委派,非显式 DAG) |
| 上游输出注入下游 | ✅ inject_result | ❌ 无明确证据 |
| Agent 派生子 Agent | ✅ 内置 skill 调 REST API | 部分 (leader→member 委派) |
| 自主条件 watcher | ✅ Heartbeat 决策引擎 | ❌ (仅定时 Autopilot) |
| 可复用团队 Skill 库 | ❌ (仅单个 API skill) | ✅ 核心特性 |
| 多 Agent 后端 | ✅ Claude Code + Codex (2) | ✅ ~12 种 CLI |
| 团队/多成员协作 | ❌ | ✅ |
| Workspace 多租户隔离 | ❌ | ✅ |
| Agent 作为一等 assignee | ❌ (任务无"指派人"概念) | ✅ |
| Agent 主动评论/建 issue/报 blocker | ❌ | ✅ |
| 交互式任务 Q&A | ✅ /respond + session resume | 部分 (blocker 上报给人) |
| 图片输入提示 | ✅ prompt_images / `claude -i` | ❌ 无明确证据 |
| Telegram 控制 | ✅ | ❌ |
| Slack 控制 | ✅ Socket Mode | ❌ |
| Feishu/Lark 控制 | ✅ 交互卡片/流式/图片 | ❌ |
| WeChat 控制 | ✅ (实验性,Node sidecar) | ❌ |
| iOS 移动端 | ❌ | ✅ apps/mobile |
| CSRF 防护 | ✅ | 未知 |
| 远程网络访问 | ❌ (仅回环,靠聊天频道外联) | ✅ (8080/3000,多机 daemon) |
| 持久化历史/可重放输出 | ✅ task_output_events | ✅ (run/session 数据) |
| Docker / K8s 部署 | ❌ (macOS App only) | ✅ Compose / 单二进制 / Helm |
| 托管云选项 | ❌ | ✅ (定价未公开) |
| 自动化测试套件 | ✅ pytest + Node 测试 | 未知 (有 open issue) |
| 纯 OSI 开源许可 | ✅ MIT | ❌ (修改版 Apache,限制 SaaS) |

---

## 5. 核心差异提炼 (按重要性排序)

1. **使用单位:个人 vs 团队。** AgentForge 是单人单机桌面工具(无成员、无多租户、回环监听);Multica 是人+Agent 混合团队的协作平台(workspace 隔离、agent 作一等 assignee、统一活动 feed)。这是决定一切的根本差异。

2. **隐喻:流水线 vs 队友。** AgentForge 把 agent 当"看板上的任务/DAG 节点"来编排;Multica 把 agent 当"有 profile、被派活、会主动评论报障的队友"。前者偏自动化管线,后者偏组织协作。

3. **部署与网络边界:本地 App vs 可自托管服务。** AgentForge 是 macOS DMG、后端只听 `127.0.0.1`,远程能力完全靠 Telegram/Slack/Feishu/WeChat 外联;Multica 提供 Docker/单二进制/K8s 自托管 + 托管云,后端面向多机 daemon 和远程团队开放(8080/3000)。

4. **差异化能力侧重:DAG+Heartbeat+聊天频道 vs Skill 复用+Squads+多 CLI。** AgentForge 独有显式 DAG(含 inject_result 依赖注入)、heartbeat 条件决策引擎、四个 IM 聊天频道;Multica 独有团队级可复用 Skill 库、Squads leader 委派、约 12 种 agent CLI 与 webhook 触发。

5. **许可证与商业模式:纯 MIT 个人工具 vs open-core 商业平台。** AgentForge 是 MIT、零商业化痕迹;Multica 是修改版 Apache 2.0(限制 SaaS 转售)+ 托管云 + sales 通道,带明确商业意图。

6. **技术现代度与实时性:HTTP 轮询/SQLite/Python 单文件 vs WebSocket/PostgreSQL+pgvector/Go 单二进制。** Multica 的栈在实时性与水平扩展上更现代;AgentForge 的栈更轻、更易在单机本地跑起来。

---

## 6. 选型建议

**选择 AgentForge,如果你:**
- 是 **macOS 上的个人开发者**,想为自己的 Claude Code/Codex 任务做调度、批处理、串联,而不是给团队用。
- 需要**本地优先、零外发、零账号**的方案(后端只听回环,MIT 许可,无遥测)——对数据隐私和"零依赖云"有强诉求。
- 需要**显式 DAG 流水线**(依赖注入上游输出)、**条件触发的 heartbeat watcher**,以及"agent 在运行中派生子 agent"。
- 想**从手机/团队群(Telegram/Slack/Feishu/WeChat)远程触发和监控**自己的 agent 任务。
- 只想下载一个 DMG 双击即用,不想搭服务器。

**选择 Multica,如果你:**
- 是一个**开发团队/技术组织**,有多人、多机、多 runtime 的 agent 协调痛点,需要让人和 agent 在同一看板上协作。
- 想把 agent 当"队友"来派活——让它自主认领 issue、评论、建 issue、主动报 blocker。
- 需要**广泛的 agent 中立性**(约 12 种 CLI:Claude Code/Codex/Copilot/Cursor/Gemini 等),不想被单一 vendor 锁定。
- 需要**可自托管的服务端**(Docker/K8s/单二进制)、WebSocket 实时性、workspace 多租户隔离,以及**团队级可复用 Skill 库**。
- 接受 source-available(修改版 Apache,内部使用免费、对外 SaaS 转售受限),并可能考虑其托管云。

**简言之**:一个人编排自己的 agent → AgentForge;一个团队协作管理一群 agent → Multica。

---

## 7. 证据可信度说明

**AgentForge(高可信度):** 本报告中所有 AgentForge 事实均来自**对其源代码的直接核验**(`taskboard.py` ~4093 行、`App.jsx` ~3605 行、`main.js`、`pyproject.toml`、`package.json`、`LICENSE` 等),可信度高。需特别注意:其 `CLAUDE.md` 文档已**过时/失真**——文档称后端监听 `0.0.0.0` 实际为 `127.0.0.1` 回环;文档称 `--permission-mode acceptEdits` 实际代码用 `bypassPermissions`;文档称"无自动化测试"实际有完整 pytest 套件。本报告采信**代码**而非该文档。

**Multica(中/低可信度,以下逐条标注):** Multica 事实主要来自其 GitHub 仓库 README、官方文档、官网营销文案,以及部分源码文件(`go.mod`、`docker-compose.yml`、migrations、`LICENSE`),可信度低于源码级核验。需明确标注的核验问题:

- **【uncertain — 关键能力存疑】pgvector "powers semantic search / skill matching":** 核验结论为 *uncertain*。核心持久化(PostgreSQL 17 + pgvector 镜像)已由 `docker-compose.yml`(`pgvector/pgvector:pg17`)证实;但对全部 888 个 server 源文件和 147 个 migration 的穷举 grep **未发现任何 vector 列类型、embedding、pgvector 操作符 (`<=>`)、ivfflat/hnsw 索引**。`skill` 表以纯 TEXT/JSONB 存储,`agent_skill` 是普通多对多 join。即:pgvector 扩展随镜像分发但 schema/查询**并未实际使用**它。"语义搜索/技能匹配由 pgvector 驱动"这一**载荷性能力说法缺乏源码支撑、并被 schema 缺失所反证**。本报告对该点保持保留。

- **【uncertain — 竞品/定位叙事】"lightweight / Linear-style minimalism / 常与 Anthropic Managed Agents 对比":** 核验结论为 *uncertain*。Multica 自身 README/docs **未做任何与 Tulsk 或 Anthropic Managed Agents 的对比**,这些是第三方/竞品叙事而非一手自我定位。星数(35.1k)/forks(4.3k)等定量数据已由仓库页证实。

- **【nuance — 许可证标签】** 部分第三方将其描述为纯 Apache 2.0,核验证实实为**修改版 Apache 2.0**(含 SaaS/嵌入限制),非 OSI 纯开源。本报告已按修改版表述。

- **【已知缺陷】** Open issue #1911 显示自主完成转换在实践中**并非完全可靠**(agent 完成后 run 记录可能卡在 `running`、`completed_at: null`),这削弱了"每个状态转换都被追踪和广播"的保证。

- **未解开问题(影响选型判断):** Multica 托管云定价完全未公开;Squad leader 委派的路由机制(启发式/LLM/规则)未知;daemon↔后端通信的鉴权细节未知;agent 进程隔离/沙箱方式未知。

- **聊天频道对比的不对称性:** 报告中标 Multica 聊天频道为"❌/无证据",这是基于现有 findings 中**未出现**相关证据,而非已证实其不存在;读者应理解为"未发现",而非"确认无"。

---

## 8. 参考来源

Multica 相关事实引用的真实来源 URL:

- https://github.com/multica-ai/multica
- https://raw.githubusercontent.com/multica-ai/multica/main/README.md
- https://github.com/multica-ai/multica/blob/main/README.md
- https://github.com/multica-ai/multica/blob/main/SELF_HOSTING.md
- https://raw.githubusercontent.com/multica-ai/multica/main/SELF_HOSTING.md
- https://github.com/multica-ai/multica/blob/main/LICENSE
- https://raw.githubusercontent.com/multica-ai/multica/main/LICENSE
- https://github.com/multica-ai/multica/blob/main/CLI_AND_DAEMON.md
- https://github.com/multica-ai/multica/blob/main/server/go.mod
- https://github.com/multica-ai/multica/blob/main/docker-compose.yml
- https://multica.ai/
- https://multica.ai/docs/agents
- https://multica.ai/docs/autopilots
- https://multica.ai/docs/tasks
- https://multica.ai/changelog
- https://dev.to/arshtechpro/multica-an-open-source-platform-for-managing-ai-coding-agents-like-teammates-2469
- https://www.arunbaby.com/ai-agents/0089-multica-agents-as-teammates/
- https://agentconn.com/blog/multica-open-source-managed-agents-platform-review/
- https://tulsk.io/compare/multica

(AgentForge 事实来自其本地源码仓库,非公开 URL。)