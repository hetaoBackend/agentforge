// Shared types for the renderer: backend REST payloads (snake_case JSON for
// API compatibility) and the native desktop bridge surface.
//
// The closed value sets below are re-exported from the backend rather than
// copied, so adding or renaming a status server-side breaks the renderer
// build instead of drifting silently. The payload interfaces stay local on
// purpose: they describe a row that has already been through SQLite, so `id`
// and the timestamps are non-null and the joined fields the REST layer adds
// (`dependencies`, `dependents`) have no backend counterpart.
import type {
  HeartbeatScheduleType,
  PromptImage,
  ScheduleType,
  TaskStatus,
} from "../../../backend/src/types.ts";

export type { HeartbeatScheduleType, PromptImage, ScheduleType, TaskStatus };

export interface Task {
  id: number;
  title: string;
  prompt: string;
  working_dir: string;
  status: TaskStatus;
  schedule_type: ScheduleType;
  cron_expr: string | null;
  delay_seconds: number | null;
  next_run_at: string | null;
  last_run_at: string | null;
  result: string | null;
  error: string | null;
  run_count: number;
  max_runs: number | null;
  created_at: string;
  updated_at: string;
  tags: string;
  agent: string;
  question: string | null;
  answer: string | null;
  session_id?: string | null;
  dag_id?: string | null;
  image_paths?: string[];
  prompt_images?: PromptImage[];
  feishu_root_msg_id?: string | null;
  /** Only present on the task-detail payload, which joins the dependency graph. */
  dependencies?: TaskDependency[];
  /** Only present on the task-detail payload: ids of tasks this one unblocks. */
  dependents?: number[];
}

export interface TaskDependency {
  id?: number;
  task_id: number;
  depends_on_task_id: number;
  inject_result?: number | boolean;
  depends_on_title?: string;
  depends_on_status?: string;
}

export interface TaskRun {
  id: number;
  task_id: number;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  result: string | null;
  error: string | null;
  raw_output?: string | null;
}

export interface TaskOutputEvent {
  id: number;
  task_id: number;
  run_id: number;
  event_type: string;
  content: string;
  timestamp: string;
}

export interface Heartbeat {
  id: number;
  name: string;
  enabled: number | boolean;
  working_dir: string;
  schedule_type: HeartbeatScheduleType;
  cron_expr: string | null;
  interval_seconds: number | null;
  check_prompt: string;
  action_prompt_template: string;
  default_agent: string;
  cooldown_seconds: number;
  next_run_at: string | null;
  last_tick_at: string | null;
  last_decision: string | null;
  last_error: string | null;
  last_triggered_at: string | null;
  last_dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface DesktopBridgeAPI {
  selectDirectory: () => Promise<string | null>;
}

declare global {
  interface Window {
    electronAPI?: DesktopBridgeAPI;
  }
}

/** Board/heartbeat card action dispatched up to App. */
export type ActionHandler = (action: string, id: number) => void;

export interface HeartbeatTick {
  id: number;
  heartbeat_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  decision_type: string | null;
  decision_payload: string | null;
  task_id: number | null;
  raw_output: string | null;
  error: string | null;
}

export interface Skill {
  id: number;
  name: string;
  description: string;
  path: string;
  source_pattern_key: string | null;
  source_task_ids: string | null;
  kind: string | null;
  enabled: number | boolean;
  created_at: string;
}

export interface SkillPattern {
  id: number;
  pattern_key: string;
  kind: string;
  summary: string;
  recurrence_count: number;
  first_seen: string;
  last_seen: string;
  contributing_task_ids: string;
  contributing_run_ids: string;
  status: string;
  promoted_skill_id: number | null;
  created_at: string;
  updated_at: string;
  /** Joined from skill_drafts when a distilled SKILL.md exists for this pattern. */
  draft_status?: string | null;
  draft_body?: string | null;
  draft_error?: string | null;
  draft_worthy?: boolean | null;
  draft_worthiness_reason?: string | null;
}

/** Sweep progress reported alongside the pattern list. */
export interface SkillSweepState {
  running?: boolean;
  last?: {
    agent?: string;
    scanned?: number;
    new?: number;
    candidates?: number;
    error?: string | null;
  } | null;
}

/** Payload of the skills view: patterns plus the last sweep summary. */
export interface SkillData {
  patterns?: SkillPattern[];
  sweep?: SkillSweepState;
}
