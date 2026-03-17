# Vibe Kanban 深度调研报告

**生成日期：** 2026-03-06
**研究模式：** Deep（8 阶段，10+ 信息源）
**研究目的：** 为 AgentForge 产品策略提供直接竞品的深度情报

---

## 执行摘要

Vibe Kanban 是目前 AgentForge **最危险的直接竞品**，也是最值得深度学习的参照对象。它由 Y Combinator 支持的 BloopAI 出品，2025 年 7 月上线，截至 2026 年 1 月已积累超过 **18,000 GitHub Stars**，最新数据接近 **9,400**（不同来源因统计时间不同有差异，需直接查阅 GitHub 实时数据）[1][7]。

Vibe Kanban 的核心差异化是**多代理并行执行 + git worktree 隔离**，支持 10+ 个 AI 编码代理同时运行而不产生代码冲突。2026 年 2 月，它推出了 **Vibe Kanban Cloud**，从个人工具进化为团队协作平台，定价 $30/用户/月，完全开源可自托管（Apache 2.0）[5]。

对 AgentForge 而言，Vibe Kanban 的三个核心短板是最值得利用的战略窗口：**没有任何调度功能**（无 cron/定时触发）、**没有通知推送集成**（无 Telegram/Slack/飞书）、**UI 仅为 Web 非 macOS 原生**。此外，它的隐私问题（早期未经同意收集 GitHub 用户名和邮件地址）在开发者社区留下了信任伤疤，AgentForge 的"本地优先、零遥测"理念形成鲜明对比。

---

## 一、产品概览与公司背景

### 1.1 BloopAI 公司背景

BloopAI 是一家获 Y Combinator（S21 批次）投资的英国初创公司，早期产品 Bloop 专注于 AI 辅助代码搜索和补丁生成，使用现有代码库作为上下文 [2]。团队在代码智能领域深耕多年，Vibe Kanban 是其在 AI 代理编排浪潮中推出的全新产品线，代表公司战略的重大转型——从"搜索工具"转向"代理编排平台"。

公司具体估值和融资总额未公开披露，但 YC + Khosla Ventures 背书表明其具备持续运营能力 [2]。Vibe Kanban 的快速增长（7 个月内 18K Stars）进一步印证了 BloopAI 在这个赛道的势头。

### 1.2 产品定位与目标用户

Vibe Kanban 的核心叙事是：**AI 编码代理正在写越来越多的代码，人类工程师的角色正在从"写代码"转向"规划、审查和编排任务"**。产品官网的副标题直接点出了这一定位："Get 10X more out of Claude Code, Codex or any coding agent"[1]。

目标用户画像与 AgentForge 高度重叠：
- 已经在使用 Claude Code/Codex/Gemini CLI 等 AI 代理的开发者
- 希望同时运行多个代理任务而不产生冲突的个人开发者
- 2026 年推出云版本后，目标扩展至 3-10 人小团队

---

## 二、技术架构深度分析

### 2.1 技术栈选择

Vibe Kanban 的技术选型体现了 BloopAI 对性能和系统编程的重视 [3]：

**后端：Rust**
选择 Rust 而非 Python 或 Node.js 是经过深思熟虑的决策。文件系统管理、子进程生命周期控制、WebSocket 并发、多工作树并行操作——这些都是 Rust 相对于解释型语言有显著优势的场景。Rust 的内存安全保证和无 GC 的高性能使其成为管理多个并发 AI 代理进程的理想选择。这与 AgentForge 的 Python 后端形成鲜明对比：Rust 提供更高的并发性能和更低的资源占用，但开发迭代速度更慢。

**前端：TypeScript + React**
与 AgentForge 的前端技术栈相似，均使用 React 构建 SUI。主要区别在于部署模式：Vibe Kanban 是 Web 应用（浏览器访问），AgentForge 是 Electron 包装的原生桌面应用。

**数据库：SQLite + SQLx**
与 AgentForge 相同，均使用 SQLite 作为本地数据存储。一个有趣的架构哲学："代码状态由 Git 管理，工作流状态由 SQLite 管理"[3]——这与 AgentForge 的 `~/.agentforge/tasks.db` 设计理念一致。

**配置：TOML 文件系统**
所有看板、列和代理设置存储在仓库内的 `/.vk/config.toml` 文件中，支持版本控制——用户可以像管理代码一样管理 AI 工作流配置 [3]。

### 2.2 Git Worktree 隔离机制

这是 Vibe Kanban 最核心的技术创新，也是与 AgentForge 最大的差异化点 [3][4]。

每个工作空间（任务尝试）获得一个独立的 git worktree，运行在唯一的分支上，防止并发操作互相干扰。系统采用**双后端策略**：使用 `git2` Rust 库处理高频操作（性能优先），使用 Git CLI 处理稀疏检出等兼容性场景。

实际效果：开发者可以同时让 5 个代理运行，每个都在自己的隔离分支上做代码修改，最终通过 PR 合并。这解决了 AgentForge 目前没有解决的"多任务并发文件冲突"问题。

**已知局限：** git worktree 解决了文件级冲突，但无法解决**语义冲突**——如果两个代理同时修改认证逻辑的不同部分，合并时仍需要人工干预 [8]。

### 2.3 MCP 协议双向集成

Vibe Kanban 实现了 MCP（Model Context Protocol）的双向支持 [3]：
- **作为 MCP 客户端**：连接外部工具服务器（文件系统、数据库、API 等）
- **作为 MCP 服务器**：将自身能力暴露给外部 MCP 客户端（如 Claude Desktop）

任何支持 stdin/stdout JSON 协议的代理都可以通过在 TOML 配置中添加一行来集成，无需重新编译。这使得 Vibe Kanban 成为开放生态的中枢，而不是封闭的工具集。

### 2.4 进程与端口管理

Vibe Kanban 包含一个专用守护进程 `dev-manager-mcp`，管理端口池。当代理需要端口时，守护进程分配一个空闲端口，启动进程并返回 URL [3]。这为每个代理的预览服务（本地 Web 服务器）提供了有序的端口管理，是内置浏览器预览功能的基础设施支撑。

---

## 三、功能特性全面清单

### 3.1 核心功能

**看板任务管理：**
Vibe Kanban 提供完整的看板体验：规划（Planning）→ 进行中（In Progress）→ 审查中（In Review）→ 完成（Done）。每个问题（Issue）支持优先级设置、标签分类、负责人分配、评论、子任务、阻断关系（blockers）[5]。2026 年 2 月推出云版本后，支持多人实时协作，所有更改对团队成员即时可见，无需刷新。

**工作空间（Workspace）管理：**
每个任务可以创建多个"尝试"（Attempts），每个尝试对应一个独立的 git worktree 分支。开发者可以尝试不同的代理或不同的提示词，比较不同尝试的结果，最终选择最优方案合并 [4]。

**代理交互（Live Agent Interaction）：**
代理运行时，开发者可以实时观察执行过程，直接在 UI 中向代理发送反馈，相当于一个实时对话界面嵌入在看板流程中 [8]。

### 3.2 代码审查功能（差异化亮点）

Vibe Kanban 内置了一个类 GitHub PR 的 **diff 查看器**，展示代理修改的每一行代码变更 [8][4]。这是 AgentForge 目前完全缺失的功能：

开发者可以：
- 查看 side-by-side 或 unified diff 格式的代码变更
- 留下内联评论（Inline Comments），直接告诉代理"这里改错了，重新实现"
- 从 UI 直接创建 Pull Request，附带 AI 生成的 PR 描述
- 审批后一键合并到主分支

这将 Vibe Kanban 从"任务执行工具"升级为"完整代码审查流程平台"。

### 3.3 内置浏览器预览

对于 Web 开发任务，Vibe Kanban 内置了一个嵌入式浏览器，代理完成修改后可以直接在 UI 中预览效果 [11]。更进一步，通过安装 `vibe-kanban-web-companion` NPM 包，开发者可以在预览浏览器中**点击界面元素**，Vibe Kanban 自动识别对应的 React 组件，并将修改反馈精确定向到对应代码——将"我想改这个按钮的颜色"的用户意图直接转化为代理任务。

### 3.4 支持的 AI 代理（完整列表）

截至 2026 年 3 月，Vibe Kanban 官方支持的代理包括 [9]：
- Claude Code（Anthropic）
- OpenAI Codex
- Gemini CLI（Google）
- GitHub Copilot
- Amp
- Cursor Agent CLI
- OpenCode
- Factory Droid
- CCR（Claude Code Router）
- Qwen Code
- Qoder AI（最新 PR 新增 [12]）

共计 **11 个代理**，且通过 TOML 配置的插件机制，理论上任何支持 stdin/stdout JSON 的代理都可以集成。

---

## 四、商业模式与定价

### 4.1 定价结构

Vibe Kanban 采用**开放核心（Open Core）**商业模式 [5]：

- **个人用户：完全免费**，所有单人功能（看板、工作空间、代理执行、diff 审查、内置浏览器）均免费使用，无使用限制
- **团队 Pro：$30/用户/月**（2026 年 2 月推出），解锁组织管理、团队成员邀请、实时协作、项目管理

所有功能，包括团队和云功能，均**完全开源（Apache 2.0）**，支持自托管，规避了"付费墙锁定"的信任问题 [5]。这是一个对开发者极其友好的商业策略：如果不愿意付费，自己部署一份即可，但大多数团队会选择 $30/人/月 的便利性。

### 4.2 与 AgentForge 定价对比

AgentForge 目前完全免费且开源。Vibe Kanban 的团队版定价 $30/用户/月 表明市场对 AI 代理编排工具的付费意愿是真实存在的——当工具能提升个人/团队生产力时，开发者愿意为此付费。这为 AgentForge 未来的商业化提供了参考定价锚点。

---

## 五、用户反馈与社区口碑

### 5.1 Hacker News 社区反应

Vibe Kanban 在 HN 上的 Show HN 帖子（ID: 44533004）获得了活跃讨论 [8]。积极反馈集中在 git worktree 并行执行的技术优雅性和内置 diff 审查的实用性：

> "This is really cool. I used Vibe Kanban with Amp to update some of our docs and it worked surprisingly well." [13]

一位 BloopAI 联合创始人在 HN 上直接参与技术讨论，回应关于代理直接交互功能的问题 [14]。这表明团队保持了与社区的积极沟通，这是开源工具维持口碑的重要因素。

### 5.2 批评性反馈

**并行执行的逻辑问题：** 最尖锐的批评来自 HN 社区：git worktree 防止了文件级冲突，但对于有深度相互依赖的功能特性，多代理并行执行可能引入语义冲突，最终反而增加了协调成本 [8]。正如一位用户所说："对于真正独立的任务，这个工具很有价值；但如果任务之间有逻辑依赖，Vibe Kanban 并没有魔法解决方案。"

**性能问题：** 在 MacBook 上同时运行 4 个以上代理任务时，用户反映出现系统卡顿。每个 AI 代理（尤其是 Claude Code）本身就是资源密集型进程，加上 Vibe Kanban 的 Rust 后端开销，4+ 并发代理对个人设备压力较大 [8]。

**安全默认值的争议：** Vibe Kanban 默认以 `--dangerously-skip-permissions`（Claude Code）或 `--yolo`（其他代理）标志运行代理，允许代理无需确认直接执行命令。这显著降低了操作摩擦，但多个用户（尤其是 DevOps 背景）担忧在生产相关任务中代理拥有过高权限 [8]。

**隐私事件：** 早期版本默认开启 PostHog 遥测，收集包括邮件地址和 GitHub 用户名在内的可识别信息，未经用户明确同意。这在 HN 引发了强烈批评，BloopAI 随后改为 opt-in 模式，但这一事件在开发者社区的信任层面留下了负面印记 [8][6]。相比之下，AgentForge 的"本地优先、无遥测"立场在隐私敏感的开发者群体中具有天然的信任优势。

### 5.3 正面用户案例

中型团队（3-5 人）用于并行处理真正独立的任务——如同时推进多个微服务的开发、不同模块的文档更新、并行的 bug 修复——反馈良好。一个典型案例：5 个代理同时运行，每个负责一个独立模块，总开发时间从 2 天压缩到 4 小时 [8]。

---

## 六、产品发展动态（近期）

### 6.1 版本发布节奏

Vibe Kanban 维持了极高的发布频率，2026 年 2-3 月间每隔 2-3 天一个版本 [10]：

- **v0.1.24**（2026-03-05，npm 最新）：持续 Bug 修复和 UI 打磨
- **v0.1.19**（2026-02-25）：Relay 隧道部署、预览代理重定向修复
- **v0.1.18**（2026-02-21）：审查注释宽度修复、路由迁移至 TanStack Router
- **v0.1.11**（2026-02-23）：类型提示菜单跳动修复、内联代码键盘快捷键
- **Cloud 发布**（2026-02-03）：团队协作、组织管理、实时同步

每日/每两日一次发布的节奏表明这是一个高度活跃的项目，也说明团队规模较小（小团队往往能做到高频发布，大团队反而因为 PR 审查和稳定性要求而降低发布频率）。

### 6.2 调度功能：目前没有，但有社区讨论

在对 GitHub Discussions 和 Issues 的搜索中，**未发现任何关于 cron 调度或定时触发的官方路线图条目**。这证实了 AgentForge 在调度领域的独特性——目前没有直接竞品覆盖这个功能维度。

值得注意的是，也没有强烈的社区需求表明调度是 Vibe Kanban 用户的高频痛点。这可能说明两件事：(1) Vibe Kanban 的核心用户更倾向于手动触发任务（因为需要监督代理执行）；(2) 或者需要调度功能的用户压根没有选择 Vibe Kanban，而是在使用 AgentForge 等工具。

---

## 七、深度 SWOT 分析（从 AgentForge 视角）

### 7.1 Vibe Kanban 的优势（对 AgentForge 的威胁来源）

**技术深度（Rust 后端）：** Rust 的性能优势在多代理并发场景下是真实的，尤其是在 CPU/内存密集的代理执行管理上。长期来看，如果 AgentForge 的 Python 后端在并发代理数量上遇到瓶颈，将面临技术架构上的挑战。

**Git worktree 隔离：** 这是竞品中目前最优雅的并发隔离方案。对于需要同时运行多个相互独立代理任务的用户，Vibe Kanban 提供了 AgentForge 目前没有的核心体验。

**代码审查工作流：** 内置 diff 查看器 + 内联评论 + 一键 PR 将整个"代理执行 → 代码审查 → 合并"流程集中在一个工具中。这是一个高价值的工作流闭环，AgentForge 目前缺失。

**多代理支持：** 11+ 个代理的支持使 Vibe Kanban 不依赖于任何单一 AI 提供商。如果 Claude Code 出现问题（涨价、API 变化、质量下降），用户可以无缝切换到 Codex 或 Gemini CLI。而 AgentForge 目前仅支持 Claude Code，存在单点依赖风险。

**YC 背景与资金支持：** BloopAI 有持续的资金保障和知名度背书，社区获取成本远低于独立项目。

### 7.2 Vibe Kanban 的弱点（AgentForge 的机会窗口）

**零调度能力（Critical Gap）：** 这是 AgentForge 最重要的护城河。Vibe Kanban 完全依赖手动触发，没有任何形式的定时/周期性任务执行。对于需要"每天晚上 2 点自动扫描依赖漏洞"或"每小时检查 API 响应时间"的用户，Vibe Kanban 无法满足需求。

**零通知集成：** 代理任务可能运行 30-60 分钟甚至更长。Vibe Kanban 没有任何机制在任务完成时通知用户（无 Telegram、Slack、邮件、系统通知）。用户只能盯着屏幕等待或频繁手动刷新。AgentForge 的 Telegram/Slack/飞书通知解决了这个真实痛点。

**Web 界面的平台限制：** 浏览器应用无法访问本地文件系统选择器、系统托盘、原生通知、macOS 键盘快捷键等 OS 级功能。对于重度 macOS 用户，Electron 原生应用在体验上有结构性优势。

**隐私信任危机：** 早期的遥测事件在开发者社区留下了"BloopAI 会偷偷收集你的数据"的印象。部分对隐私高度敏感的开发者（尤其是处理私有代码库的企业开发者）会主动回避 Vibe Kanban。

**DAG 流水线缺失：** Vibe Kanban 的任务是扁平的，没有依赖关系建模。AgentForge 支持 DAG（有向无环图）任务流水线，允许"任务 B 等待任务 A 完成后才执行"，这在复杂工程自动化场景中是关键能力。

---

## 八、综合对比：AgentForge vs Vibe Kanban

| 功能维度 | AgentForge | Vibe Kanban |
|---------|-----------|------------|
| **核心定位** | Claude Code 任务调度看板 | 多代理并行执行看板 |
| **看板界面** | ✅（Queue/Running/Done 三列） | ✅（Planning/In Progress/Review/Done 四列） |
| **代理支持** | Claude Code（专一） | 11+ 个代理（多元） |
| **调度：立即执行** | ✅ | ✅（手动触发） |
| **调度：延迟执行** | ✅（N 秒后） | ❌ |
| **调度：定时执行** | ✅（指定时间点） | ❌ |
| **调度：cron 周期** | ✅（cron 表达式） | ❌ |
| **DAG 任务依赖** | ✅ | ❌ |
| **git worktree 隔离** | ❌ | ✅（每任务独立分支） |
| **内置 diff 查看器** | ❌ | ✅（类 GitHub PR 界面） |
| **内联代码评论** | ❌ | ✅ |
| **内置浏览器预览** | ❌ | ✅ |
| **Telegram 通知** | ✅ | ❌ |
| **Slack 通知** | ✅ | ❌ |
| **飞书通知** | ✅ | ❌ |
| **macOS 原生桌面** | ✅（Electron） | ❌（Web 浏览器） |
| **后端语言** | Python（快速迭代） | Rust（高性能） |
| **本地数据存储** | ✅（SQLite） | ✅（SQLite） |
| **MCP 支持** | ❌ | ✅（双向） |
| **隐私/零遥测** | ✅（完全本地） | ⚠️（opt-in 后改善） |
| **开源协议** | 开源 | Apache 2.0 |
| **团队协作** | ❌ | ✅（Cloud，$30/人/月） |
| **自托管** | ✅（本地运行） | ✅（开源可自托管） |
| **GitHub/PR 集成** | ❌ | ✅（直接从 UI 创建 PR） |
| **定价** | 完全免费 | 个人免费，团队 $30/人/月 |

---

## 九、对 AgentForge 产品路线图的战略建议

### 9.1 守住护城河（立即优先）

**调度 UX 必须打磨到极致。** 调度是当前唯一真正的差异化功能，但必须在体验上超越竞品。具体建议：
- 添加 cron 表达式智能解析器（自然语言输入"每天下午 3 点"→ 自动生成 `0 15 * * *`）
- "下次执行时间"预览（让用户在保存前确认时间表是否正确）
- 调度历史仪表盘（哪些任务按时触发，哪些失败，失败原因是什么）
- 任务完成通知的延迟容忍设置（如"任务超过 30 分钟未完成则发送提醒"）

### 9.2 补齐高价值缺口（1-3 月）

**内置 diff 查看器是高优先级功能。** Vibe Kanban 的 diff 查看器是其口碑最好的功能之一，帮助开发者"信任但验证"代理的输出。AgentForge 目前只展示原始流输出（NDJSON 事件流），没有代码变更的可视化。在 `FormattedOutput` 组件中集成 `git diff` 展示，开发成本相对可控，但用户体验增益显著。

**MCP 协议支持是生态站位。** MCP 正在成为 AI 代理领域的标准协议，Claude Code、Vibe Kanban、Cursor 均已支持。AgentForge 添加 MCP 服务器能力后，可以接收来自 Claude Desktop、其他 MCP 客户端的任务创建请求，将 AgentForge 从"独立工具"升级为"AI 代理生态枢纽"。

### 9.3 中期差异化深化（3-6 月）

**git worktree 隔离执行。** 这是 Vibe Kanban 最具技术含量的功能，但实现难度对 Python 后端来说也是可控的。`gitpython` 或直接调用 `git worktree` 命令均可实现。一旦 AgentForge 支持 worktree 隔离，每个调度任务可以在独立分支上执行，任务完成后自动创建 PR，形成从"调度触发"到"代码交付"的完整自动化流水线。

**不要追求多代理支持（差异化而非追赶）。** Vibe Kanban 的多代理支持是其核心壁垒，AgentForge 不应该用有限资源去复制这一功能。相反，应该把对 Claude Code 的支持做到极致深度——完整支持 CLAUDE.md 配置、hooks 机制、`--permission-mode` 精细控制、MCP 工具集成——打造"Claude Code 最佳伴侣"的不可替代定位。

---

## 十、局限性与信息空白

本次调研存在以下已知局限：

Vibe Kanban 的 GitHub Stars 数量在不同来源之间存在差异（一处报告 9.4K，另一处报告截至 2026 年 1 月超过 18K）。这可能由于统计时间不同，需要直接访问 [GitHub 仓库](https://github.com/BloopAI/vibe-kanban) 获取实时数据。BloopAI 的具体融资金额、团队规模和估值未公开披露，PitchBook 等数据库可能有更详细信息但未能在本次搜索中获取。Vibe Kanban 的公开路线图文件未找到，关于"调度功能是否在计划中"的结论基于 GitHub Issues/Discussions 搜索结果为空的间接推断，非直接确认。

---

## 参考资料

[1] GitHub - BloopAI/vibe-kanban. https://github.com/BloopAI/vibe-kanban

[2] BloopAI Company Background. Y Combinator S21. https://www.ycombinator.com/companies/bloop

[3] vibe-kanban — a Kanban board for AI agents. VirtusLab Technical Blog. https://virtuslab.com/blog/ai/vibe-kanban

[4] Git Worktree Management. DeepWiki. https://deepwiki.com/BloopAI/vibe-kanban/2.4-github-integration-and-pr-workflow

[5] Introducing Vibe Kanban Cloud. https://www.vibekanban.com/blog/introducing-vibe-kanban-cloud

[6] Vibe Kanban Pricing Page. https://www.vibekanban.com/pricing

[7] Vibe Kanban: Manage AI Coding Agents in Parallel. ByteIota. https://byteiota.com/vibe-kanban-manage-ai-coding-agents-in-parallel/

[8] Show HN: Vibe Kanban – Kanban board to manage your AI coding agents. Hacker News. https://news.ycombinator.com/item?id=44533004

[9] Supported Agents - Vibe Kanban Documentation. https://vibe-kb.com/docs/agents/

[10] Releases · BloopAI/vibe-kanban. https://github.com/BloopAI/vibe-kanban/releases

[11] Testing Your Application - Vibe Kanban. https://vibekanban.com/docs/core-features/testing-your-application

[12] feat: Add Qoder AI coding agent integration. PR #1759. https://github.com/BloopAI/vibe-kanban/pull/1759

[13] HN Comment on Vibe Kanban + Amp usage. https://news.ycombinator.com/item?id=44536928

[14] HN Comment by BloopAI co-author. https://news.ycombinator.com/item?id=44533271

[15] Vibe Kanban: Revolutionary Orchestration or Overhyped Complexity? Solved By Code. https://solvedbycode.ai/blog/vibe-kanban-honest-review

[16] Vibe Kanban Tool Review. Eleanor Berger. https://elite-ai-assisted-coding.dev/p/vibe-kanban-tool-review

[17] I'm About to Try Vibe Kanban. Gokul Suresh, Medium. https://medium.com/@gokulofficial18602/im-about-to-try-vibe-kanban-the-ai-agent-orchestration-platform-that-might-change-how-we-code-ed25f79ba262

[18] Stop Watching AI Code Scroll by: Vibe Kanban Turns Coding Agents into a Team. Towards Explainable AI, Medium. https://medium.com/towards-explainable-ai/stop-watching-ai-code-scroll-by-vibe-kanban-turns-coding-agents-into-a-team-you-can-actually-9f7923d6f14b

[19] BloopAI/vibe-kanban-web-companion: Edit websites in Vibe Kanban. https://github.com/BloopAI/vibe-kanban-web-companion

[20] vibe-kanban npm package. https://www.npmjs.com/package/vibe-kanban

---

## 方法论附录

**研究模式：** Deep（8 阶段流程）

**搜索角度分解（Phase 3 并行执行）：**
1. GitHub Stars + 基础概览
2. 技术架构（Rust、git worktree、MCP 协议细节）
3. 用户评价（Reddit、HN、批评性反馈）
4. BloopAI 公司背景（YC、资金、团队）
5. 定价与云功能（Cloud 发布详情）
6. 近期版本发布（Changelog，过去 30 天）
7. GitHub 仓库活跃度（Issues、PR、Contributors）
8. 完整代理支持列表
9. 调度/cron 功能路线图调研
10. 隐私问题专项调查

**信息来源类型：** GitHub 官方仓库 × 5、产品官网 × 3、技术博客（VirtusLab、Medium）× 4、Hacker News 社区讨论 × 3、npm 包页面 × 1、产品评测文章 × 2

**置信度评估：** 技术架构描述（高，来自代码库和官方文档）；定价信息（高，官网直接引用）；GitHub Stars（中，数据有差异待验证）；用户痛点（中高，基于 HN 真实评论的质化分析）；公司财务信息（低，无公开披露）
