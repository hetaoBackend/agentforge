# 工作流模板库 — 详细设计文档

> AgentForge v2.x 功能设计
> 状态：Draft
> 日期：2026-03-03

---

## 一、背景与目标

### 问题陈述

当前每次创建 Agent 任务都需要从零填写 title、prompt、working_dir、schedule_type 等字段，存在三个核心痛点：

1. **重复劳动** — 常用任务（Code Review、生成 changelog、重构）需要反复填写相似内容
2. **知识流失** — 好用的 prompt 写完就丢，没有沉淀机制
3. **门槛偏高** — 新用户不知道 prompt 该怎么写，无法快速上手

### 目标

- 将优质 Agent 工作流"固化"为可复用模板
- 降低任务创建的认知成本，从"从零写 prompt"变成"选模板 → 填参数 → 提交"
- 内置官方模板覆盖高频场景，用户模板积累个人经验

---

## 二、功能范围

### In Scope（本期）

| 功能 | 说明 |
|------|------|
| 内置模板库 | 10 个官方场景模板，随版本内置 |
| 从模板创建任务 | 在 NewTaskModal 中增加"从模板创建"入口 |
| 模板变量替换 | 模板支持 `{{变量名}}` 占位符，用户填值后生成最终 prompt |
| 保存为模板 | 将现有任务（title + prompt + schedule 配置）保存为用户模板 |
| 用户模板管理 | 查看、删除用户自建模板；不支持编辑（直接删除重建） |

### Out of Scope（后续版本）

- 模板版本管理
- 模板市场 / 社区分享
- 模板嵌套（模板引用模板）
- 模板执行历史统计

---

## 三、数据模型

### 3.1 Template 结构

```python
@dataclass
class Template:
    id: Optional[int] = None
    name: str = ""                  # 显示名称，例如 "Code Review 整个仓库"
    description: str = ""           # 一句话说明
    category: str = ""              # 分类：code / docs / ops / custom
    icon: str = ""                  # 单个 emoji，用于 UI 展示
    prompt_template: str = ""       # 含 {{变量}} 的 prompt 原文
    default_title: str = ""         # 任务标题模板，也支持 {{变量}}
    default_schedule_type: str = "immediate"
    default_cron_expr: Optional[str] = None
    default_delay_seconds: Optional[int] = None
    variables: list = field(default_factory=list)  # 见 3.2
    is_builtin: bool = False        # True = 内置，不可删除
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
```

### 3.2 Variable 结构

```python
# 存储为 JSON 数组，每项：
{
  "key": "branch_name",        # 在 prompt 中 {{branch_name}} 引用
  "label": "分支名",            # 表单显示标签
  "type": "text|select|dir",   # text = 文本输入，select = 下拉，dir = 目录选择器
  "default": "main",           # 默认值（可空）
  "required": true,            # 是否必填
  "options": ["main", "dev"]   # 仅 type=select 时有效
}
```

### 3.3 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'custom',
    icon TEXT DEFAULT '📋',
    prompt_template TEXT NOT NULL,
    default_title TEXT DEFAULT '',
    default_schedule_type TEXT DEFAULT 'immediate',
    default_cron_expr TEXT,
    default_delay_seconds INTEGER,
    variables TEXT DEFAULT '[]',   -- JSON
    is_builtin INTEGER DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
```

**迁移策略：** `TaskDB._init_db()` 中追加 `CREATE TABLE IF NOT EXISTS templates (...)` 并在首次启动时写入内置模板数据，通过 `is_builtin=1` 标记。

---

## 四、内置模板清单

| icon | name | category | 变量 |
|------|------|----------|------|
| 🔍 | Code Review 整个仓库 | code | `scope`（select: 全部/仅改动） |
| 📝 | 生成 CHANGELOG | docs | `from_tag`、`to_tag` |
| ♻️ | 批量重构文件 | code | `target_pattern`（glob）、`instruction` |
| 🐛 | 修复指定 Bug | code | `issue_description` |
| 🧪 | 补全单元测试 | code | `file_path`、`framework`（select: pytest/jest/vitest） |
| 📖 | 生成 README | docs | `project_name`、`description` |
| 🔒 | 安全审计 | ops | `scope`（select: 全部/依赖/代码） |
| 🗂️ | 整理项目结构 | ops | `target_dir` |
| 📊 | 分析代码复杂度 | code | 无 |
| 🔄 | 每日代码同步检查 | ops | `cron_expr`（默认 `0 9 * * 1-5`） |

---

## 五、后端 API

### 5.1 新增端点

```
GET  /api/templates              — 列出所有模板（内置 + 用户）
POST /api/templates              — 创建用户模板
DELETE /api/templates/{id}       — 删除模板（内置模板返回 403）
```

### 5.2 GET /api/templates 响应

```json
[
  {
    "id": 1,
    "name": "Code Review 整个仓库",
    "description": "对仓库代码进行全面的 code review，输出改进建议",
    "category": "code",
    "icon": "🔍",
    "prompt_template": "请对 {{scope}} 进行 code review，重点关注：\n1. 潜在的 bug\n2. 代码风格与可读性\n3. 性能隐患\n4. 安全问题\n\n以 Markdown 格式输出改进建议，按严重程度分级。",
    "default_title": "Code Review — {{scope}}",
    "default_schedule_type": "immediate",
    "variables": [
      {
        "key": "scope",
        "label": "审查范围",
        "type": "select",
        "default": "所有文件",
        "required": true,
        "options": ["所有文件", "仅 staged 改动", "src/ 目录"]
      }
    ],
    "is_builtin": true
  }
]
```

### 5.3 POST /api/templates（保存用户模板）

请求体（从现有任务保存时由前端构造）：

```json
{
  "name": "我的 Review 模板",
  "description": "...",
  "category": "custom",
  "icon": "⭐",
  "prompt_template": "...",
  "default_title": "...",
  "default_schedule_type": "immediate",
  "variables": []
}
```

---

## 六、前端交互设计

### 6.1 入口：NewTaskModal 改造

在 `NewTaskModal` 顶部增加两个 Tab：

```
[  从模板创建  |  手动创建  ]
```

默认展示"从模板创建"Tab（降低门槛）。

### 6.2 模板选择界面

```
┌─────────────────────────────────────────────────────┐
│  搜索模板...                              [全部] [code] [docs] [ops] [custom] │
├─────────────────────────────────────────────────────┤
│  🔍 Code Review 整个仓库          [code]            │
│     对仓库代码进行全面的 code review…               │
│                                                     │
│  📝 生成 CHANGELOG               [docs]            │
│     根据 git tag 差异自动生成…                      │
│                                                     │
│  ⭐ 我的 Review 模板 (用户)       [custom]  [删除]  │
│     …                                               │
└─────────────────────────────────────────────────────┘
```

点击模板卡片 → 进入变量填写界面。

### 6.3 变量填写界面

```
┌──────────────────────────────────────────────┐
│  ← 返回模板列表                               │
│                                              │
│  🔍 Code Review 整个仓库                     │
│  ─────────────────────────────────────────  │
│                                              │
│  任务标题                                    │
│  [Code Review — 所有文件              ]      │
│                                              │
│  工作目录                                    │
│  [~/my-project                   ] [选择]   │
│                                              │
│  审查范围 *                                  │
│  [所有文件 ▼                        ]        │
│                                              │
│  Prompt 预览（只读）                         │
│  ┌──────────────────────────────────────┐   │
│  │ 请对 所有文件 进行 code review...    │   │
│  └──────────────────────────────────────┘   │
│                                              │
│                  [取消]  [创建任务 →]        │
└──────────────────────────────────────────────┘
```

**变量替换逻辑（前端实时）：**
```javascript
function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? `{{${key}}}`);
}
```

### 6.4 保存为模板入口

在任务详情面板（Detail View）的操作菜单中增加 "另存为模板" 选项：

```
[重试]  [取消]  [编辑]  [Fork]  [另存为模板]  [删除]
```

点击后弹出简单 Modal：
- 模板名称（必填，预填任务 title）
- 描述（选填）
- 分类（select: custom/code/docs/ops，默认 custom）
- icon（emoji 输入，默认 ⭐）

提交后调用 `POST /api/templates`，变量列表默认为空（用户自建模板暂不支持变量向导，prompt 原文保存即可）。

---

## 七、实现计划

### Phase 1：后端（预计 1 天）

1. `TaskDB` 中新增 `templates` 表 + 迁移逻辑
2. 写入 10 个内置模板（首次 `_init_db()` 时插入，`is_builtin=1`）
3. 实现 `GET /api/templates`、`POST /api/templates`、`DELETE /api/templates/{id}`
4. `do_GET` / `do_POST` / `do_DELETE` 中添加路由分支

### Phase 2：前端 Tab + 模板列表（预计 1 天）

1. `App.jsx` 中添加 `fetchTemplates()` / `createTemplate()` / `deleteTemplate()` API 函数
2. `NewTaskModal` 增加 Tab 切换逻辑 + 模板列表渲染
3. 模板卡片组件，支持分类过滤 + 搜索

### Phase 3：变量填写 + Prompt 预览（预计 0.5 天）

1. 变量表单动态渲染（text / select / dir 三种类型）
2. `renderTemplate()` 实时替换 + Prompt 预览
3. 提交时生成最终 task payload，复用 `handleCreate()`

### Phase 4：保存为模板（预计 0.5 天）

1. Detail 面板增加"另存为模板"按钮
2. `SaveAsTemplateModal` 组件
3. 调用 `POST /api/templates`

---

## 八、关键决策记录

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 模板存储位置 | 同 tasks.db / 独立文件 / 独立表 | 同 tasks.db 新表 | 无需新依赖，事务一致 |
| 变量语法 | `{{var}}` / `{var}` / `%var%` | `{{var}}` | Jinja/Mustache 风格，开发者熟悉 |
| 内置模板更新策略 | 版本号比对 / 每次覆盖 / 不更新 | 每次启动检查 `is_builtin=1` 的数量，不足则补充 | 简单，不破坏用户已有内置模板修改（暂不支持编辑） |
| 变量编辑器（用户模板） | 支持 / 不支持 | 不支持（v1） | 降低复杂度，用户可直接在 prompt 中写死值 |

---

## 九、后续扩展点

- **模板变量编辑器** — 让用户为自建模板也定义 `{{变量}}`
- **模板导入/导出** — JSON 文件格式，方便团队共享
- **模板使用统计** — 记录每个模板被使用次数，按热度排序
- **社区模板市场** — 远程拉取、一键安装模板

---

*文档结束*
