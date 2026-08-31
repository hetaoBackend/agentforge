# AgentForge 可维护性诊断报告

日期：2026-08-31
范围：全项目只读扫描（backend / taskboard-electron / site / 工程基建）
约束：建议均控制在「可拆文件、可调模块边界，不改对外 REST API 与 SQLite schema」的尺度内
基线 commit：`46bbc72`

---

## 0. 体量基线

| 区域 | 文件数 | 行数 | 备注 |
|---|---|---|---|
| `backend/src` + `taskboard.ts` | 22 | 17,945 | |
| `backend/tests` | 19 | 14,813 | 测试/源码比 0.83，覆盖态势健康 |
| `taskboard-electron/src` + `scripts` | 28 | 8,592 | 其中 `App.tsx` 占 6,819（79%） |
| `site` | 12 | 674 | 与主应用无耦合 |

最大的 6 个源文件：

```
3199  backend/src/scheduler.ts
2255  backend/src/api.ts
2172  backend/src/channels/feishu.ts
2006  backend/src/db.ts
1656  backend/src/channels/telegram.ts
6819  taskboard-electron/src/renderer/App.tsx   ← 单文件最大
```

---

## P0 — 优先处理

### P0-1. `App.tsx` 6,819 行单文件，承载 14 个组件 + 30 个 API 函数 + 全部样式

**证据**

- `App.tsx:5797` `export default function App()` 本体 1,022 行
- 同文件内的巨型组件：
  - `SettingsModal` (`App.tsx:3735`) — **1,410 行**
  - `DetailPanel` (`App.tsx:3048`) — 650 行
  - `ExecutionTimelineStep` (`App.tsx:520`) — 606 行
  - `NewTaskModal` (`App.tsx:2570`) — 478 行
  - `HeartbeatDetailPanel` (`App.tsx:2240`) — 330 行
- `App.tsx:826-1124` 连续 30 个 `async function fetch*/create*/update*/delete*` —— 完整的 API 客户端层嵌在组件文件里
- `App.tsx:43` `THEMES`、`App.tsx:1508-1615` 8 个样式工厂函数（`uiField` / `modalPanel` / `primaryButton` …）
- 全文 **398 处** `style={{ ... }}` 内联样式对象

**影响**：任何一处改动都要在 7,000 行里定位；组件无法单测（当前 renderer 侧只有 `traceSteps` / `dateTime` / `channelsSettings` / `nativeBridge` 四个纯函数模块有测试，UI 零覆盖）；`build:check` 之外没有更细粒度的回归网。

**建议拆分**（纯文件搬迁，不改渲染行为）：

```
src/renderer/
  api/client.ts          ← 826-1124 的 30 个函数 + csrfHeaders/fetchWithTimeout (784-825)
  theme/tokens.ts        ← THEMES / *_FONT_STACK (40-124)
  theme/styles.ts        ← uiField/uiLabel/modal*/​*Button/segmentedButton (1508-1615)
  components/output/     ← FormattedOutput, ExecutionTimeline*, getExecutionStepConfig,
                            formatTraceValue, buildTraceRows (181-783)
  components/common/     ← Tooltip/BrandMark/Icon*/Badge/Tag/StatusPill/MetricTile (1126-1507)
  features/tasks/        ← TaskCard/Column/NewTaskModal/DetailPanel
  features/heartbeats/   ← HeartbeatBadge/Modal/Card/DetailPanel
  features/skills/       ← SkillsView/SkillPatternCard/SkillRegistryCard/parseSkillFrontmatter
  features/settings/     ← SettingsModal（本身需二次拆为 per-channel 子面板）
  App.tsx                ← 只保留布局 + 视图切换
```

建议分批提交，每批跑一次 `bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build:check`。

---

### P0-2. renderer 关闭了类型检查，backend 是 strict

**证据**

- `taskboard-electron/tsconfig.json`：`"strict": false`、`"noImplicitAny": false`
- `taskboard-electron/eslint.config.mjs`：`"@typescript-eslint/no-explicit-any": "off"`（注释自述为 "pragmatic migration posture"）
- `backend/tsconfig.json`：`"strict": true`
- 结果：`App.tsx` 里 `function TaskCard({ task, onAction, onViewDetail })`、`function Column({ col, tasks, ... })` 等组件 props 全是隐式 `any`；另有 21 处显式 `any`（含 `DetailPanel({ ... }: any)`、`HeartbeatModal({ ... }: any)`）

**影响**：`src/renderer/types.ts` 里已经定义好的 `Task` / `Heartbeat` / `TaskOutputEvent` 在组件边界上完全没生效，后端改字段时前端不会报错，只会运行时坏。这是 P0-1 拆分的**前置收益放大器** —— 先拆再开 strict，收益远大于顺序颠倒。

**建议**：拆分完成后逐目录开启 strict。可用 tsconfig `include` 分层，或先把 `noImplicitAny` 打开、`strictNullChecks` 后置。给 `types.ts` 里已有的接口补上组件 props 类型即可消掉绝大部分。

---

### P0-3. 构建产物被提交进 Git

**证据**

- `git ls-files taskboard-electron/.bun` → 8 个文件被跟踪，含 `chunk-53wppy34.js` (848K)、`chunk-53wppy34.js.map` (1.4M)、`agentforge.icns` (2.6M)、3 份重复的 PNG
- `.gitignore` 只忽略了 `build/` `dist/` `node_modules/`，**没有 `.bun/`**
- 已产生的噪声提交：`cc450fb Rebuild renderer bundle`；另有 3 个功能提交（`c652e78`、`f9ba347`、`810cb71`）顺带改动了 bundle

**影响**：每次改 renderer 都要么产生一个无意义的 "Rebuild bundle" 提交，要么让功能提交夹带几百 KB 的 diff；code review 信噪比被压低；`assets/` 下的图标在 `.bun/renderer/assets/` 里有一份完整拷贝。

**建议**：`.gitignore` 补 `.bun/`，`git rm -r --cached taskboard-electron/.bun`。历史里的 blob 可暂不清理（1.5G 中绝大部分是 `node_modules`，见 P2-2，历史 blob 不是体积主因）。

---

## P1 — 结构性问题，建议排在 P0 之后

### P1-1. `scheduler.ts` 是 god object：至少 7 类职责挤在一个类里

**证据**（`backend/src/scheduler.ts`，3,199 行，单个 `TaskScheduler` 类）

| 职责 | 代表方法 |
|---|---|
| IM 入站消息分发 | `handle_inbound_message:276`, `_handle_create_brief:301`, `_handle_confirm_brief:355`, `_handle_discard_brief:387` |
| Runbook | `_handle_preview_runbook:441`, `_handle_run_runbook:454` |
| Digest | `_handle_trigger_digest:472` |
| Skill 建议 | `_handle_skill_suggestion_action:519` |
| 调度主循环 | `start:605`, `_loop:680`, `_tick:691`, `_schedule_delayed:792`, `_spawn_task:817` |
| Heartbeat | `_render_heartbeat_check_prompt:836`, `_parse_heartbeat_decision:864`, `_execute_heartbeat:1592`, `_heartbeat_trigger_suppressed:1555` |
| Skill 蒸馏 | `run_skill_sweep:915`, `distill_skill_draft:1116`, `_build_sweep_prompt:1310`, `_build_distill_prompt:1061`, `approve_skill:1235` |
| **Agent 执行 + 流解析** | `_run_agent_command:1417`(138行), `_parse_codex_event:2093`(110行), `_parse_and_store_event:2203`(88行), `_claude_text_delta:1952`, `_store_output_event:2073`, `_extract_codex_thread_id:1805`, `_find_codex_generated_images:1829` |

顶部 import 达 12 组，`import { makeTask } from "./types.ts"` 甚至出现在**第 3195 行**（文件末尾），是长期堆积的直接痕迹。

**建议**：按上表切成 `scheduler/loop.ts`、`scheduler/heartbeats.ts`、`scheduler/skills.ts`、`scheduler/inbound.ts`，`TaskScheduler` 保留为组合入口。可先做纯文件搬迁 + re-export，保持 `TaskScheduler` 的公开方法签名不变，测试（`scheduler-logic` / `scheduler-more` / `scheduler-runbooks` / `scheduler-skill-suggestions`，共 1,868 行）无需改动。

### P1-2. `executor.ts` 与 `scheduler.ts` 的职责边界与文档不符

**证据**

- `AGENTS.md:62` 声称 `src/executor.ts — AgentExecutor — 运行 agent CLI…解析 NDJSON 流并把每个事件持久化到 task_output_events`
- 实际 `executor.ts`（283 行）主体是 subprocess 抽象：`OSError:26`、`TimeoutExpired:35`、`PIPE:47`、`default_subprocess_run:69`、`default_popen:154`、`AgentExecutor:214`；全文只有 1 处 `JSON.parse`
- NDJSON 解析与落库实际全在 `scheduler.ts:1417/1952/2073/2093/2203`

**影响**：新人按 AGENTS.md 找解析逻辑会找错文件。这也是 P1-1 里"Agent 执行 + 流解析"那一档应该被抽出来的直接理由 —— 抽出后正好落回 `executor.ts` 该有的位置，文档也就自洽了。

**建议**：把 `_run_agent_command` / `_parse_codex_event` / `_parse_and_store_event` / `_claude_text_delta` / `_codex_*` 迁入 `executor.ts`（或新建 `src/agent/stream.ts`），同步修订 `AGENTS.md:59-72`。

### P1-3. 四个 channel 之间存在逐字复制的工具函数与常量

**证据**

| 重复项 | 位置 |
|---|---|
| `_file_url_path` | `telegram.ts:1535`、`weixin.ts:255` —— **实现逐字一致**（已 diff 确认） |
| `_unquote` | `telegram.ts:1542`、`weixin.ts:262` |
| `_expanduser` | `telegram.ts:1551`、`weixin.ts:271`；`feishu.ts:196` 另有 `expandUser` 同义实现 |
| `_is_plain_object` | `telegram.ts:1557`、`weixin.ts:277`；`feishu.ts:139` 另有 `isPlainObject` |
| `*_UPLOADABLE_IMAGE_SUFFIXES` | `telegram.ts:252`、`feishu.ts:88`、`weixin.ts:72` —— **三份内容完全相同**的 `{.png .jpg .jpeg .gif .webp}` |
| `*_MARKDOWN_IMAGE_RE` | `telegram.ts:259`、`feishu.ts:105`、`weixin.ts:79`（feishu 版多一个 `\n` 排除，疑似有意也疑似漂移） |
| markdown 图片替换 | `telegram.ts:1519`、`feishu.ts:999`、`weixin.ts:1343` —— 三处同形的 `line.replace(RE, ...)` |

已有的共享层是好的先例：`channels/agent_utils.ts`（`/agent` 命令）、`channels/dir_utils.ts`（`/dir` 命令）、`channels/brief_utils.ts`。

**建议**：新增 `channels/path_utils.ts`（`file_url_path` / `unquote` / `expanduser` / `is_plain_object`）与 `channels/image_utils.ts`（后缀集合 + 图片正则 + 提取/替换），沿用 `*_utils.ts` 既有约定。注意 `FEISHU_MARKDOWN_IMAGE_RE` 的 `\n` 差异要先确认是刻意还是漂移，再决定统一到哪个版本。

### P1-4. `db.ts` 单个 `TaskDB` 类 71 个方法，横跨 9 个领域

**证据**（`backend/src/db.ts`，2,006 行）：tasks(`459/1131/1184/1191/1198/1992`)、settings(`508/515`)、task_briefs(`559-666`)、im_runbooks(`711-814`)、heartbeats(`824-1128`)、runs & output events(`1224-1398`)、skill_patterns & drafts(`1400-1674`)、im_skill_suggestions(`1702-1841`)、skills(`1843-1898`)、dependencies & DAG(`1899-1991`)。

**影响**：任何 channel 只需要 `get_setting`/`set_setting` 两个方法，却要依赖整个 71 方法的类型（现有的 `SettingsDB` / `TelegramDB` 结构化接口是对这个问题的正确缓解，说明团队已经意识到了）。

**建议**：按领域拆为 `db/tasks.ts`、`db/heartbeats.ts`、`db/skills.ts`、`db/runbooks.ts` 等 repository 模块，`TaskDB` 组合它们并保留全部现有方法名（方法名即 API JSON key，**不能改**）。schema 与建表语句集中留在 `db/schema.ts`。这是纯内部重组，对外零变化。

### P1-5. `api.ts` 手写 60+ 条 `if (path === ...)` 路由链

**证据**：`api.ts:1018-2016`，GET/POST/PATCH/DELETE 四段各自一条长 if 链，混用 `path === `、`path.startsWith(...) && path.endsWith(...)`、`path.split("/").length === 4` 三种匹配风格。例如 `api.ts:1133` 的 `if (path.startsWith("/api/tasks/"))` 必须排在 `/runs`、`/output`、`/events`、`/messages`、`/dependencies`、`/dependents` 六条之后才正确 —— **顺序即隐式契约，且无任何注释标注**。

**影响**：新增一条 `/api/tasks/{id}/xxx` 若不慎插在 `1133` 之后就会被静默吞掉，且不会有编译期错误。

**建议**：引入一张显式路由表（`[method, pattern, handler]` 数组 + 一个小 matcher），把顺序依赖变成显式的 pattern 优先级。**URL 与响应体保持完全不变**，`api-handler.test.ts`（2,180 行）就是这次重构的安全网。

---

## P2 — 值得做，但不急

### P2-1. 前后端类型两套定义，靠人工同步

`taskboard-electron/src/renderer/types.ts` 与 `backend/src/types.ts` 各自定义 `Task` / `TaskStatus` / `ScheduleType` / `Heartbeat`。后端用 `const` object + `keyof typeof` 派生联合类型，前端用字面量联合手写。字段漂移目前只能靠人肉发现（叠加 P0-2 的 `strict:false`，漂移在前端连报错都不会有）。

建议：抽 `shared/types.ts`，或至少让 renderer 直接 `import type` 后端类型（Bun 的 `allowImportingTsExtensions` 两边都开了，跨目录 type-only import 可行，不引入运行时依赖）。

### P2-2. 仓库工作区 1.5G

`site/node_modules` 754M + `taskboard-electron/node_modules` 458M + `taskboard-electron/build` 176M + `backend/node_modules` 88M。均已被 `.gitignore` 覆盖（`build/`、`node_modules/`），**不是 Git 体积问题，是本地磁盘问题**。

`site/` 754M 依赖 vs 674 行源码的比例值得单独看一眼 —— 它与主应用无任何耦合，若不再活跃，可考虑移出主仓。

### P2-3. `.gitignore` 仍带 Python 时代残留

`__pycache__/`、`*.py[oc]`、`.ruff_cache/`、`.python-version`、`.venv`、`htmlcov/`、`coverage.xml` 等 9 行，与 `AGENTS.md:5`「TypeScript-only，无 Python」的声明矛盾。清理成本近零。

### P2-4. renderer 侧 UI 零测试覆盖

现有 renderer 测试只覆盖 4 个纯函数模块（`traceSteps` 324行/`dateTime` 103行/`channelsSettings` 189行/`nativeBridge`），组件层完全没有。P0-1 拆分后每个 feature 目录才具备可测形态 —— 这一项应作为 P0-1 的**后续动作**而非独立任务。

---

## 建议执行顺序

```
1. P0-3  .gitignore 加 .bun/ + git rm --cached        （10 分钟，立刻净化后续所有 diff）
2. P2-3  清理 .gitignore Python 残留                   （5 分钟，顺手）
3. P0-1  App.tsx 分批拆分                              （最大工作量，但收益最高；分 6-8 批）
4. P0-2  renderer 逐步开启 strict                      （依赖 3 完成）
5. P1-3  channels 工具函数收敛                         （独立、低风险，可与 3 并行）
6. P1-2  流解析逻辑迁回 executor.ts + 修订 AGENTS.md    （为 7 铺路）
7. P1-1  scheduler.ts 按职责拆分                       （依赖 6）
8. P1-4  db.ts 拆 repository                          （独立，可与 7 并行）
9. P1-5  api.ts 路由表化                               （独立，有 2180 行测试兜底）
10. P2-1 类型共享
11. P2-4 组件测试补齐
```

第 1、2、5 项可以立刻做且互不冲突。第 3 项是关键路径，建议单独开分支分批推进。

每批改动后执行既定质量门：
- backend：`make check`
- frontend：`cd taskboard-electron && bun run typecheck && bun run lint && bun run format:check && bun run test && bun run build:check`

---

## 附：本次未发现的问题

- 测试覆盖在 backend 侧是充分的（14,813 行测试 / 17,945 行源码），重构有网可依
- CI（`.github/workflows/ci.yml`）双 job + `concurrency` 取消超越运行，配置合理
- `bus.ts` 的 `MessageBus` / `Channel` 抽象设计干净，是全项目边界最清晰的模块
- `channels/agent_utils.ts`、`dir_utils.ts`、`brief_utils.ts` 是正确的共享层先例，P1-3 只需沿用同一约定
