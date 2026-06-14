type Row = Record<string, any>;

export interface IMSkillSuggestionSourceTask {
  id: number;
  title: string;
}

export interface IMSkillSuggestion {
  pattern_id: number;
  pattern_key: string;
  summary: string;
  recurrence_count: number;
  status: string;
  draft_status: string | null;
  draft_name: string | null;
  draft_description: string | null;
  draft_body: string | null;
  source_tasks: IMSkillSuggestionSourceTask[];
}

export interface CollectIMSkillSuggestionsOptions {
  channel?: string | null;
  limit?: number;
}

function parseJsonList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tagsIncludeChannel(tags: unknown, channel: string): boolean {
  return String(tags ?? "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .includes(channel.toLowerCase());
}

function sourceTasksForPattern(
  db: {
    get_task?: (task_id: number) => Row | null | undefined;
  },
  pattern: Row,
  channel: string | null,
): IMSkillSuggestionSourceTask[] {
  const seen = new Set<number>();
  const tasks: IMSkillSuggestionSourceTask[] = [];
  for (const rawTaskId of parseJsonList(pattern["contributing_task_ids"])) {
    const taskId = Number(rawTaskId);
    if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId)) {
      continue;
    }
    const task = db.get_task?.(taskId);
    if (!task) {
      continue;
    }
    if (channel && !tagsIncludeChannel(task["tags"], channel)) {
      continue;
    }
    seen.add(taskId);
    tasks.push({
      id: taskId,
      title: String(task["title"] || "Untitled"),
    });
  }
  return tasks;
}

function isSuggestiblePattern(pattern: Row): boolean {
  const status = String(pattern["status"] ?? "");
  const draftStatus = String(pattern["draft_status"] ?? "");
  return (
    status === "candidate" ||
    draftStatus === "drafting" ||
    draftStatus === "ready" ||
    draftStatus === "error"
  );
}

export function collect_im_skill_suggestions(
  db: {
    get_skill_patterns: (limit?: number) => Row[];
    get_task?: (task_id: number) => Row | null | undefined;
  },
  options: CollectIMSkillSuggestionsOptions = {},
): IMSkillSuggestion[] {
  const channel = options.channel?.trim() || null;
  const limit = options.limit ?? 10;
  const suggestions: IMSkillSuggestion[] = [];
  for (const pattern of db.get_skill_patterns(200)) {
    if (!isSuggestiblePattern(pattern)) {
      continue;
    }
    const sourceTasks = sourceTasksForPattern(db, pattern, channel);
    if (channel && sourceTasks.length === 0) {
      continue;
    }
    suggestions.push({
      pattern_id: Number(pattern["id"]),
      pattern_key: String(pattern["pattern_key"] ?? ""),
      summary: String(pattern["summary"] ?? ""),
      recurrence_count: Number(pattern["recurrence_count"] ?? 0),
      status: String(pattern["status"] ?? ""),
      draft_status:
        pattern["draft_status"] === null || pattern["draft_status"] === undefined
          ? null
          : String(pattern["draft_status"]),
      draft_name:
        pattern["draft_name"] === null || pattern["draft_name"] === undefined
          ? null
          : String(pattern["draft_name"]),
      draft_description:
        pattern["draft_description"] === null ||
        pattern["draft_description"] === undefined
          ? null
          : String(pattern["draft_description"]),
      draft_body:
        pattern["draft_body"] === null || pattern["draft_body"] === undefined
          ? null
          : String(pattern["draft_body"]),
      source_tasks: sourceTasks,
    });
    if (suggestions.length >= limit) {
      break;
    }
  }
  return suggestions;
}

export function render_im_skill_suggestion_text(
  suggestion: IMSkillSuggestion,
): string {
  const displayName =
    suggestion.draft_name?.trim() || suggestion.pattern_key || "unnamed-skill";
  const lines = [
    `Skill suggestion: ${displayName}`,
    "",
    `I found this recurring workflow across ${suggestion.recurrence_count} tasks:`,
    suggestion.summary || "A recurring AgentForge workflow may be reusable.",
  ];

  if (suggestion.source_tasks.length) {
    lines.push("", "Source tasks:");
    suggestion.source_tasks.slice(0, 5).forEach((task, index) => {
      lines.push(`${index + 1}. #${task.id} ${task.title}`);
    });
  }

  if (suggestion.draft_status === "ready" && suggestion.draft_body?.trim()) {
    lines.push(
      "",
      "Draft is ready for review.",
      "Approving installs a SKILL.md under ~/.agentforge/skills and links it into ~/.claude/skills and ~/.agents/skills.",
    );
  }

  lines.push(
    "",
    "Reply:",
    `\`/draft-skill ${suggestion.pattern_id}\` to generate a SKILL.md draft`,
    `\`/approve-skill ${suggestion.pattern_id}\` to install after draft review`,
    `\`/dismiss-skill ${suggestion.pattern_id}\` to stop suggesting this pattern`,
  );

  return lines.join("\n");
}
