// Core enums and models, ported from taskboard.py.
// Field and member names intentionally keep the Python snake_case spelling:
// they double as SQLite column names and REST API JSON keys.

export const DEFAULT_AGENT = "codex";
export const DEFAULT_TIMEOUT_SECONDS = 12000;

export const CLAUDE_STREAM_JSON_ARGS = [
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--permission-mode",
  "bypassPermissions",
];

export const LIVE_OUTPUT_EVENT_TYPES = new Set([
  "assistant",
  "tool_call",
  "tool_result",
  "command_execution",
  "file_change",
  "web_search",
  "error",
]);

export const SECRET_KEY_FRAGMENTS = [
  "api_key",
  "apikey",
  "authorization",
  "auth_token",
  "credential",
  "password",
  "secret",
  "token",
] as const;

export const GENERATED_IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const TaskStatus = {
  PENDING: "pending",
  SCHEDULED: "scheduled",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  BLOCKED: "blocked", // has unmet upstream dependencies
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const ScheduleType = {
  IMMEDIATE: "immediate",
  DELAYED: "delayed", // run after N seconds
  SCHEDULED_AT: "scheduled_at", // run at a specific datetime
  CRON: "cron", // recurring cron expression
} as const;
export type ScheduleType = (typeof ScheduleType)[keyof typeof ScheduleType];

export const HeartbeatScheduleType = {
  CRON: "cron",
  INTERVAL: "interval",
} as const;
export type HeartbeatScheduleType =
  (typeof HeartbeatScheduleType)[keyof typeof HeartbeatScheduleType];

export const HeartbeatDecisionType = {
  IDLE: "idle",
  TRIGGER_TASK: "trigger_task",
  RESUME_TASK: "resume_task",
  NOTIFY_ONLY: "notify_only",
  ERROR: "error",
} as const;
export type HeartbeatDecisionType =
  (typeof HeartbeatDecisionType)[keyof typeof HeartbeatDecisionType];

export interface PromptImage {
  media_type: string;
  data: string;
  name?: string;
}

export interface Task {
  id: number | null;
  title: string;
  prompt: string;
  working_dir: string;
  status: TaskStatus;
  schedule_type: ScheduleType;
  cron_expr: string | null; // e.g. "*/30 * * * *"
  delay_seconds: number | null; // e.g. 300
  next_run_at: string | null; // ISO timestamp
  last_run_at: string | null;
  result: string | null;
  error: string | null;
  run_count: number;
  max_runs: number | null; // null = unlimited for cron
  created_at: string | null;
  updated_at: string | null;
  tags: string; // comma-separated
  agent: string;
  question: string | null; // question the agent asked
  answer: string | null; // user's answer
  session_id: string | null; // agent session/thread id for resume
  prompt_images: PromptImage[];
  image_paths: string[]; // list of local image file paths
  dag_id: string | null; // optional DAG workflow group label
  feishu_root_msg_id: string | null; // Feishu root message_id that created this task
}

export function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: null,
    title: "",
    prompt: "",
    working_dir: ".",
    status: TaskStatus.PENDING,
    schedule_type: ScheduleType.IMMEDIATE,
    cron_expr: null,
    delay_seconds: null,
    next_run_at: null,
    last_run_at: null,
    result: null,
    error: null,
    run_count: 0,
    max_runs: null,
    created_at: null,
    updated_at: null,
    tags: "",
    agent: DEFAULT_AGENT,
    question: null,
    answer: null,
    session_id: null,
    prompt_images: [],
    image_paths: [],
    dag_id: null,
    feishu_root_msg_id: null,
    ...partial,
  };
}

export interface Heartbeat {
  id: number | null;
  name: string;
  enabled: boolean;
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
  created_at: string | null;
  updated_at: string | null;
}

export function makeHeartbeat(partial: Partial<Heartbeat> = {}): Heartbeat {
  return {
    id: null,
    name: "",
    enabled: true,
    working_dir: ".",
    schedule_type: HeartbeatScheduleType.INTERVAL,
    cron_expr: null,
    interval_seconds: null,
    check_prompt: "",
    action_prompt_template: "",
    default_agent: DEFAULT_AGENT,
    cooldown_seconds: 0,
    next_run_at: null,
    last_tick_at: null,
    last_decision: null,
    last_error: null,
    last_triggered_at: null,
    last_dedupe_key: null,
    created_at: null,
    updated_at: null,
    ...partial,
  };
}
