# DAG Task Support — Implementation Plan

## Overview

Add support for DAG (Directed Acyclic Graph) task workflows where:
- Tasks can declare dependencies on other tasks
- Downstream tasks auto-trigger when all upstream dependencies complete
- Failed upstream tasks auto-cancel downstream tasks
- Downstream tasks can optionally inject upstream results into their prompt

---

## 1. Data Model Changes

### 1.1 New Table: `task_dependencies`

```sql
CREATE TABLE task_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,           -- downstream task (consumer)
    depends_on_task_id INTEGER NOT NULL, -- upstream task (producer)
    inject_result BOOLEAN DEFAULT 0,    -- whether to inject upstream result into prompt
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id),
    UNIQUE(task_id, depends_on_task_id)
)
```

### 1.2 New `Task` fields

- `dag_id: Optional[str]` — optional group identifier to visually cluster tasks in the same DAG workflow
- `depends_on: list[int]` — list of task IDs this task depends on (transient, not stored in tasks table, used at creation time)

### 1.3 New `TaskStatus`

- `BLOCKED = "blocked"` — task has unmet dependencies; waiting for upstream tasks

### 1.4 `tasks` table migration

```sql
ALTER TABLE tasks ADD COLUMN dag_id TEXT;
-- status 'blocked' is handled by the existing TEXT column — no schema change needed
```

---

## 2. Backend Changes (`taskboard.py`)

### 2.1 `TaskDB` additions

```python
def add_dependency(self, task_id: int, depends_on_task_id: int, inject_result: bool = False)
def get_dependencies(self, task_id: int) -> list[dict]   # upstream tasks
def get_dependents(self, task_id: int) -> list[dict]      # downstream tasks
def get_dag_tasks(self, dag_id: str) -> list[dict]
def delete_task_dependencies(self, task_id: int)          # called in delete_task
```

### 2.2 `TaskScheduler` changes

#### `submit_task()` — DAG-aware scheduling

When creating a task with dependencies:
1. If task has `depends_on` list → set initial status to `"blocked"` instead of `"pending"` (unless all deps already completed)
2. Store entries in `task_dependencies` table
3. `dag_id` is stored on the task

#### `_on_task_completed(tid)` — trigger downstream tasks

After a task transitions to `completed`:
1. Find all tasks that depend on `tid` (via `get_dependents(tid)`)
2. For each dependent task: check if ALL its dependencies are now completed
3. If yes → unblock the task:
   - Optionally inject upstream results into prompt (if `inject_result=True`)
   - Set status from `blocked` → `pending`
4. Notify

#### `_on_task_failed(tid)` — cascade cancel

After a task transitions to `failed`:
1. Find all tasks that directly or transitively depend on `tid`
2. Set their status to `cancelled` with error message: `"Cancelled: upstream task #{tid} failed"`
3. Notify each cancelled task

#### `_build_injected_prompt(task_id)` — result injection

```python
def _build_injected_prompt(self, task: dict) -> str:
    deps = self.db.get_dependencies(task["id"])
    injections = []
    for dep in deps:
        if dep["inject_result"]:
            upstream = self.db.get_task(dep["depends_on_task_id"])
            if upstream and upstream.get("result"):
                injections.append(
                    f"=== Result from upstream task #{upstream['id']} ({upstream['title']}) ===\n"
                    f"{upstream['result']}\n"
                    f"=== End of upstream result ==="
                )
    if injections:
        return "\n\n".join(injections) + "\n\n---\n\n" + task["prompt"]
    return task["prompt"]
```

### 2.3 `get_due_tasks()` update

Exclude `blocked` tasks from due-task query:
```sql
WHERE status IN ('pending', 'scheduled')  -- blocked tasks are not due
```
(No change needed if `blocked` is a new status not in the existing query.)

### 2.4 `delete_task()` update

Also delete dependency rows:
```python
self.conn.execute("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?", (task_id, task_id))
```

---

## 3. API Changes

### 3.1 `POST /api/tasks` — extended body

```json
{
  "title": "Step 2: Analyze",
  "prompt": "Analyze the output",
  "depends_on": [1, 2],          // list of upstream task IDs
  "inject_result": true,          // inject ALL upstream results into prompt
  "dag_id": "my-pipeline-2024"   // optional group label
}
```

Or per-dependency control:
```json
{
  "depends_on": [
    {"task_id": 1, "inject_result": true},
    {"task_id": 2, "inject_result": false}
  ]
}
```

### 3.2 New endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/tasks/:id/dependencies` | Get upstream deps for a task |
| GET | `/api/tasks/:id/dependents` | Get downstream tasks |
| GET | `/api/dag/:dag_id` | Get all tasks in a DAG group |
| POST | `/api/tasks/:id/dependencies` | Add a dependency to existing task |
| DELETE | `/api/tasks/:id/dependencies/:dep_id` | Remove a dependency |

### 3.3 `GET /api/tasks` response

Each task now includes:
```json
{
  "id": 5,
  "status": "blocked",
  "dag_id": "my-pipeline",
  "dependencies": [{"depends_on_task_id": 3, "inject_result": true}],
  ...
}
```

---

## 4. `TaskScheduler.submit_task()` — DAG batch creation helper

Add `POST /api/dag` endpoint to create an entire DAG in one call:

```json
POST /api/dag
{
  "dag_id": "release-pipeline",
  "tasks": [
    {"ref": "A", "title": "Build", "prompt": "Run build"},
    {"ref": "B", "title": "Test",  "prompt": "Run tests", "depends_on_refs": ["A"]},
    {"ref": "C", "title": "Deploy","prompt": "Deploy", "depends_on_refs": ["B"], "inject_result": true}
  ]
}
```

Response:
```json
{"dag_id": "release-pipeline", "task_ids": {"A": 10, "B": 11, "C": 12}}
```

---

## 5. Frontend Changes (`App.jsx`)

### 5.1 Task status: `blocked`

Add to `STATUS_CONFIG`:
```js
blocked: { label: "Blocked", color: theme.textMuted, bg: "rgba(107,107,138,0.08)", icon: "⊘" }
```

Add `blocked` to the `Queue` column statuses.

### 5.2 Task card enhancements

Show dependency info on each task card:
- If `blocked`: show `"Waiting for: #3, #4"` with upstream task IDs as badges
- If task has dependents: show `"Unlocks: #5, #6"`
- Show `dag_id` as a subtle tag if present

### 5.3 Task creation form

Add a **Dependencies** tab/section:
- Multi-select of existing task IDs/titles
- Toggle "inject result into prompt" per dependency
- `dag_id` text field (optional)

### 5.4 DAG view (optional / phase 2)

A dedicated DAG visualization panel showing tasks as nodes with arrows for dependencies.

---

## 6. `skills/agentforge/scripts/agentforge_api.py` updates

Add CLI support for creating DAG tasks:
```bash
python agentforge_api.py --method create \
  --prompt "Run tests" \
  --title "Test" \
  --depends-on 10,11 \
  --inject-result \
  --dag-id "release-pipeline"
```

---

## 7. Implementation Order

1. **DB layer** — `task_dependencies` table, migration, new DB methods
2. **Scheduler logic** — `_on_task_completed` / `_on_task_failed` cascades, `_build_injected_prompt`
3. **API** — extend `POST /api/tasks`, add new dependency endpoints, `POST /api/dag`
4. **`get_all_tasks`** — include dependency info in response
5. **Frontend** — `blocked` status, task card badges, form dependencies tab
6. **AgentForge skill** — CLI flag additions

---

## 8. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Failure cascade | Auto-cancel all downstream | Clean; avoids orphaned blocked tasks |
| Result injection | Per-dependency opt-in | Flexible; avoid polluting prompts unnecessarily |
| Cycle detection | Validate at creation time (DFS check) | Fail fast; prevent deadlocks |
| `blocked` status | New status value | Makes it visible in UI; distinguishable from `pending` |
| DAG batch API | Optional `/api/dag` endpoint | Convenience for AgentForge skill; atomic creation |
