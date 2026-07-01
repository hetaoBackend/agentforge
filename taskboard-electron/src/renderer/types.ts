// Shared types for the renderer: backend REST payloads (snake_case JSON for
// API compatibility) and the native desktop bridge surface.

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "blocked"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ScheduleType = "immediate" | "delayed" | "scheduled_at" | "cron";

export interface Task {
  id: number;
  title: string;
  prompt: string;
  working_dir: string;
  status: TaskStatus | string;
  schedule_type: ScheduleType | string;
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
  schedule_type: string;
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
