// TaskDB: SQLite persistence layer, ported from taskboard.py (class TaskDB).
// Method names, SQL, column names and defaults intentionally mirror the Python
// source. Bun is single-threaded, so Python's RLock has no TS equivalent.
//
// The class is assembled from one repository mixin per domain (see db/), so
// every method name — which doubles as an API JSON key — stays exactly where
// callers expect it while the source is no longer one 2 000-line file.

import { DbBase } from "./db/base.ts";
import { TasksMixin } from "./db/tasks.ts";
import { BriefsMixin } from "./db/briefs.ts";
import { RunbooksMixin } from "./db/runbooks.ts";
import { HeartbeatsMixin } from "./db/heartbeats.ts";
import { RunsMixin } from "./db/runs.ts";
import { SkillsMixin } from "./db/skills.ts";
import { SuggestionsMixin } from "./db/suggestions.ts";

export class TaskDB extends SuggestionsMixin(
  SkillsMixin(
    RunsMixin(HeartbeatsMixin(RunbooksMixin(BriefsMixin(TasksMixin(DbBase))))),
  ),
) {}
