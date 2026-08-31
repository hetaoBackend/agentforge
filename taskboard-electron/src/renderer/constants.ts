/** Board columns, agent registry and form defaults shared across features. */

import { CheckCircle2, Inbox, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { TaskStatus } from "./types.ts";

interface BoardColumnDef {
  key: string;
  label: string;
  hint: string;
  /** Typed against the backend union so a new status cannot go unrouted. */
  statuses: TaskStatus[];
  icon: LucideIcon;
  tone: string;
}

export const COLUMNS: BoardColumnDef[] = [
  {
    key: "queued",
    label: "Queue",
    hint: "ready, delayed, or blocked",
    statuses: ["pending", "scheduled", "blocked"],
    icon: Inbox,
    tone: "orange",
  },
  {
    key: "running",
    label: "Running",
    hint: "live agent sessions",
    statuses: ["running"],
    icon: Play,
    tone: "blue",
  },
  {
    key: "done",
    label: "Done",
    hint: "completed, failed, cancelled",
    statuses: ["completed", "failed", "cancelled"],
    icon: CheckCircle2,
    tone: "green",
  },
];

export type BoardColumn = (typeof COLUMNS)[number];

export const AGENTS = {
  claude: { label: "Claude Code", icon: "C", color: "#ff9f0a" },
  codex: { label: "Codex CLI", icon: "X", color: "#00c7be" },
};
export const DEFAULT_AGENT = "codex";
export const DEFAULT_TIMEOUT_SECONDS = 12000;
