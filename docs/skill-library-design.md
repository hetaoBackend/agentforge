# AgentForge Skill Library — 设计稿

> 来源：对照 Multica 的 "skill compounding" 特性 + pskoett `self-improvement` SKILL.md，
> 经一轮 grill 收敛而成。目标是把 Multica 最具差异化的"复利沉淀"能力，
> 翻译到 AgentForge **单人本地**的战略与现有基建上。

## 0. 战略约束（不可越界）

- **保持单人本地**。MIT / 回环 only / 零外发的差异化不动。
- 凡是依赖"团队"语境的 Multica 特性（agent-as-assignee、Squads、workspace 多租户、
  主动 blocker 上报给"人"、iOS）**一律不借**。
- 本特性只增强**单人**的"把自己反复跑的活沉淀成可复用能力"。

## 1. 一句话定义

AgentForge 定期（增量、每日 + 手动）让一个 agent 扫一遍最近完成的任务，
用 **Pattern-Key + Recurrence-Count** 检测跨 run 的复发模式；
当某模式 `复发≥3 且 跨≥2 个任务 且 在 30 天窗口内`，自动蒸馏出一份
**标准 Claude Code `SKILL.md` 草稿** → 人工审批 → 落到全局 `~/.claude/skills/`。
claude 从 `~/.claude/skills` 原生加载；codex 从 `~/.agents/skills` 原生加载
（审批后写一次 SKILL.md，再 symlink 到两个目录）——**两边都是各自原生的渐进式披露，零 prompt 注入**。

## 2. 决策树（已收敛）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 战略边界 | 保持单人本地；团队类特性全部出局 |
| 2 | 优先借鉴 | 个人可复用 Skill 库（Multica 最高复利点） |
| 3 | Skill 层次 | **跨 agent 能力**，但规范产物 = **标准 SKILL.md 格式** |
| 4 | 沉淀机制 | **自动草稿 + 人工审批**（草稿是杠杆，审批是质控） |
| 5 | 触发来源 | **跨 run 模式检测**（现在做，非 v2） |
| 6 | 检测方式 | **定期批量 sweep**（claude/codex 扫一遍），非 per-run 在线打标 |
| 7 | 范围节奏 | **增量每日（watermark）+ 手动按钮**，复用 heartbeat 引擎 |
| 8 | 存储作用域 | **全局 `~/.claude/skills/` + DB registry** |
| 9 | 跨 agent 投递 | **双 symlink，两边原生加载**：真身写 `~/.claude/skills/<name>/`，软链 `~/.agents/skills/<name>` → 同一目录。claude / codex 各自原生 progressive disclosure，**零 prompt 注入** |
| 10 | pattern 范围 | **成功配方 + 失败→修复** 两类（配方为主、避坑为辅） |
| 11 | 总开关 | **可开关，默认 OFF**（opt-in，省 token）；只 gate 自动 sweep+蒸馏，**不**停已沉淀 skill 的加载 |
| 12 | sweep agent | **可配置**（claude/codex），复用 heartbeat `default_agent`，默认 claude |
| 13 | 手动按钮 | **不受总开关限制**：手动 = 显式付费，关着也能点一次 |

## 3. 复用现有基建（关键：几乎不造新引擎）

`heartbeat` 表已是为本特性量身的周期-agent-决策引擎：

| heartbeat 已有字段 | 复用为 |
|---|---|
| `schedule_type`+`cron_expr`+`interval_seconds` | 扫描节奏（默认每日 cron） |
| `check_prompt` | sweep 分析 prompt |
| `default_agent` (claude/codex) | 谁来扫 |
| `heartbeat_ticks.decision_payload` | 持久化结构化 pattern 候选 |
| `heartbeat_dedup` + `UNIQUE(dedupe_key)` | **Pattern-Key 去重**（同模式不重复提议） |
| `cooldown_seconds` | 节流 |

`task_output_events`（每 run 结构化输出）= sweep 的蒸馏原料。

内置一个名为 `skill-distiller` 的特殊 heartbeat 即可承载整套检测逻辑。

## 4. 新增数据模型（全部 SQLite，AgentForge 原生）

```
-- 跨 sweep 持久化的模式账本
CREATE TABLE skill_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_key TEXT NOT NULL UNIQUE,      -- 语义 key，sweep agent 派发
    kind TEXT NOT NULL,                    -- 'recipe' | 'pitfall'
    summary TEXT NOT NULL,                 -- 一行 learning
    recurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    contributing_task_ids TEXT NOT NULL,   -- JSON array，用于"跨≥2 任务"判定
    status TEXT NOT NULL DEFAULT 'tracking',-- tracking|candidate|drafted|promoted|dismissed
    promoted_skill_id INTEGER
);

-- 已落库的 skill registry（指向 ~/.claude/skills/<name>/）
CREATE TABLE skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,              -- 用于 codex 渐进披露清单 & claude 触发
    path TEXT NOT NULL,                     -- ~/.claude/skills/<name>/SKILL.md
    source_pattern_key TEXT,
    source_task_ids TEXT,                   -- 溯源
    kind TEXT,                              -- recipe|pitfall
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);

-- sweep 增量 watermark（也可塞进 settings 表）
-- setting: skill_sweep_watermark = 上次扫描覆盖到的最大 run 完成时间
```

### settings 键（全部走现有 `settings` 表）

| key | 默认 | 含义 |
|---|---|---|
| `skill_library_enabled` | `0` (OFF) | 总开关。仅 gate **自动 sweep + 蒸馏**；OFF 时零 token 开销 |
| `skill_sweep_agent` | `claude` | sweep 用的 agent（claude/codex），落到 `skill-distiller` heartbeat 的 `default_agent` |
| `skill_sweep_cron` | `0 3 * * *` | 自动扫描节奏（默认每日凌晨 3 点） |
| `skill_sweep_watermark` | — | 上次扫描覆盖到的最大 run 完成时间（增量游标） |

## 5. 端到端流程

```
[每日 cron]──(需 skill_library_enabled=1)──┐
[手动"扫一遍"按钮]──(无视总开关，显式付费)──┤
        │                                    │
        ▼                                    ▼
skill-distiller heartbeat 触发 sweep（agent = skill_sweep_agent）
        │  输入：watermark 以来的新 completed run 摘要 + 当前 skill_patterns 汇总
        │  （永不重扫原始历史 → 成本有界）
        ▼
agent 输出 JSON：每条 = {pattern_key, kind, summary, task_id}
        │  对 skill_patterns 做语义 key 模糊匹配：
        │    命中 → recurrence_count++、更新 last_seen、追加 contributing_task_ids
        │    未命中 → 新建一行（status=tracking）
        ▼
阈值判定（借 pskoett）：recurrence_count≥3 且 跨≥2 任务 且 30 天窗口内
        │  → status=candidate
        ▼
[自动草稿] 对 candidate 再调一次 agent：
        读 contributing 任务的 output_events → 产出标准 SKILL.md 草稿
        （草稿须自评"是否够通用"；区分 recipe / pitfall 模板）
        │  → status=drafted
        ▼
[人工审批 UI] 你 review / 编辑 / 批准 or 驳回
        │  批准 → 写 ~/.claude/skills/<name>/SKILL.md
        │         + symlink ~/.agents/skills/<name> -> ~/.claude/skills/<name>
        │         + 插入 skills 表 + 标 promoted
        │  驳回 → status=dismissed（同 pattern_key 不再反复提议）
        ▼
[投递] 一次写入、双 symlink、两边原生加载、零注入：
  · claude 任务：从 ~/.claude/skills 原生加载（progressive disclosure）
  · codex 任务：从 ~/.agents/skills 原生加载（progressive disclosure）
  · AgentForge 不碰 prompt，_run_agent_prompt_once 无需 skill 专属分支
```

## 6. 跨 agent 投递细节（symlink，零注入）

codex 与 claude **都有原生 skill 渐进式加载**，各自的 skill 目录不同：

| agent | 原生 skill 目录 |
|---|---|
| claude | `~/.claude/skills/` |
| codex | `~/.agents/skills/` |

因此跨 agent 投递退化为一次文件写入 + 一次软链：

```
真身：  ~/.claude/skills/<name>/SKILL.md
软链：  ~/.agents/skills/<name>  ->  ~/.claude/skills/<name>
```

- 单一真相源（一份 SKILL.md），两个目录各自 symlink 指过去。
- 两个 agent 各走**自己原生的 progressive disclosure**：只看 name+description，相关时才读全文。
- AgentForge **完全不碰 prompt**：`_run_agent_prompt_once` 不需要 skill 专属分支，
  prompt 大小天然不随 skill 库增长膨胀。
- 待办（实现时一行验证）：确认 codex 当前版本的 skill 目录路径与 SKILL.md 加载约定
  （`~/.agents/skills` 形态），symlink 命名按其约定对齐。
- 备选（更解耦）：真身放 AgentForge 自有目录 `~/.agentforge/skills/<name>/`，
  同时 symlink 进 `~/.claude/skills` 与 `~/.agents/skills`，让 AgentForge 当 owner、两 agent 当消费者。

## 6b. 开关与配置（token 成本两段独立控制）

token 成本拆成两段，分别由不同开关控制，互不牵连：

| 成本来源 | 控制开关 | 默认 | 关掉的效果 |
|---|---|---|---|
| **自动 sweep + 蒸馏**（大头，agent 调用） | `skill_library_enabled` 总开关 | OFF | 零自动 token；手动按钮仍可点 |
| **单个 skill 的加载**（小头，description 进 context） | `skills.enabled` 行级标志 | 各自 ON | 摘掉两个 symlink → claude/codex 都不再加载该 skill |

设计意图：
- 总开关 **只管"造 skill 的过程"**，不管"已造好的 skill 用不用"——OFF 不会让你既有的库失效。
- 想彻底零开销：总开关 OFF + 把不用的 skill 行 `enabled=0`（摘 symlink）。
- 手动"扫一遍"独立于总开关：每次点 = 你显式为这一次 sweep 付费。
- sweep agent 在设置里可切 claude/codex（写 `skill-distiller` heartbeat 的 `default_agent`）。

## 7. 借用的阈值（来自 pskoett self-improvement）

- 提炼门槛：`Recurrence-Count ≥ 3` **且** 跨 ≥2 个不同任务 **且** 30 天窗口内。
- 提炼资格附加项（草稿自评）：broadly-applicable、verified、需要可观调试才发现的、用户显式要求。

## 8. 明确 v2 / 暂不做

- 跨项目"全局 vs 项目"双层路由（先一律全局）。
- skill 版本化 / 陈旧检测（`last_verified`）/ 与已有 skill 的去重合并。
- feature-request 类 pattern（超出 skill 库范畴）。
- 任务 embedding / 聚类（已证明不需要——Pattern-Key + 计数器足够）。

## 9. 与 Multica 的关系（设计意图）

| | Multica | AgentForge（本设计） |
|---|---|---|
| 复利单位 | 团队共享 skill 库 | 个人 skill 库（全局 ~/.claude/skills） |
| 沉淀触发 | 写一次，团队复用 | 自动检测复发 → 自动草稿 → 人工审批 |
| 格式 | 自有 skill 定义 | **标准 Claude Code SKILL.md**（零锁定、可移植） |
| 跨 agent | 平台层 | 双 symlink，claude / codex 各自原生加载，零注入 |
| 边界 | 团队协作平台 | 坚守单人本地 |
