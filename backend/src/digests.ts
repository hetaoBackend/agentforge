import type { TaskDB } from "./db.ts";

type Row = Record<string, any>;

export interface IMDigestSection {
  key: string;
  title: string;
  items: string[];
}

export interface IMDigest {
  generated_at: string;
  since: string | null;
  has_content: boolean;
  sections: IMDigestSection[];
  suggested_commands: string[];
}

export interface IMDigestRecipient {
  channel: string;
  target: string;
}

export interface ComposeIMDigestOptions {
  since?: string | null;
  limit?: number;
  include_empty?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function taskLine(task: Row, detailKey: string | null = null): string {
  const id = Number(task["id"]);
  const title = rowText(task["title"]) || "Untitled task";
  const detail = detailKey ? rowText(task[detailKey]) : "";
  const prefix = Number.isInteger(id) && id > 0 ? `#${id} ` : "";
  return detail ? `${prefix}${title}: ${detail}` : `${prefix}${title}`;
}

function parsePayloadSummary(value: unknown): string {
  if (!value) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    return rowText((value as Row)["summary"] ?? (value as Row)["message"]);
  }
  if (typeof value !== "string") return rowText(value);
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return rowText((parsed as Row)["summary"] ?? (parsed as Row)["message"]);
    }
  } catch {
    return value.trim();
  }
  return "";
}

function addSection(
  sections: IMDigestSection[],
  key: string,
  title: string,
  items: string[],
): void {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length) sections.push({ key, title, items: clean });
}

function limited<T>(items: T[], limit: number): T[] {
  return items.slice(0, Math.max(0, limit));
}

export function compose_im_digest(
  db: TaskDB,
  options: ComposeIMDigestOptions = {},
): IMDigest {
  const limit = Math.max(1, Math.trunc(options.limit ?? 10));
  const sections: IMDigestSection[] = [];
  const tasks = db.get_all_tasks();

  addSection(
    sections,
    "completed",
    "Completed",
    limited(
      tasks.filter((task) => task["status"] === "completed"),
      limit,
    ).map((task) => taskLine(task)),
  );
  addSection(
    sections,
    "needs_you",
    "Needs you",
    limited(
      tasks.filter((task) => rowText(task["question"])),
      limit,
    ).map((task) => taskLine(task, "question")),
  );
  addSection(
    sections,
    "failed",
    "Failed",
    limited(
      tasks.filter((task) => task["status"] === "failed"),
      limit,
    ).map((task) => taskLine(task, "error")),
  );

  const watcherItems: string[] = [];
  for (const heartbeat of db.get_all_heartbeats()) {
    const heartbeatId = Number(heartbeat["id"]);
    if (!Number.isInteger(heartbeatId)) continue;
    for (const tick of db.get_heartbeat_ticks(heartbeatId, limit)) {
      const decisionType = rowText(tick["decision_type"]);
      if (!decisionType || decisionType === "idle") continue;
      const summary =
        parsePayloadSummary(tick["decision_payload"]) ||
        rowText(tick["raw_output"]) ||
        rowText(tick["error"]) ||
        decisionType;
      watcherItems.push(`${heartbeat["name"]}: ${summary}`);
      if (watcherItems.length >= limit) break;
    }
    if (watcherItems.length >= limit) break;
  }
  addSection(sections, "watchers", "Watchers", watcherItems);

  addSection(
    sections,
    "skills",
    "Skill candidates",
    limited(
      db
        .get_skill_patterns()
        .filter((pattern) =>
          ["candidate", "drafted"].includes(rowText(pattern["status"])),
        ),
      limit,
    ).map((pattern) => rowText(pattern["summary"] || pattern["pattern_key"])),
  );

  const suggested = new Set<string>();
  if (sections.some((section) => section.key === "failed")) {
    suggested.add("/fix-ci <url>");
  }
  if (sections.some((section) => section.key === "skills")) {
    suggested.add("/scan-skills");
  }

  return {
    generated_at: nowIso(),
    since: options.since ?? null,
    has_content: sections.length > 0 || Boolean(options.include_empty),
    sections,
    suggested_commands: [...suggested],
  };
}

export function render_im_digest_text(digest: IMDigest): string {
  if (!digest.sections.length) {
    return "AgentForge Standup\n\nNo notable AgentForge activity.";
  }
  const lines = ["AgentForge Standup"];
  for (const section of digest.sections) {
    lines.push("", `${section.title}:`);
    section.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item}`);
    });
  }
  if (digest.suggested_commands.length) {
    lines.push("", "Suggested next:");
    for (const command of digest.suggested_commands) {
      lines.push(command);
    }
  }
  return lines.join("\n");
}

export function parse_im_digest_recipients(
  value: unknown,
): IMDigestRecipient[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const recipients: IMDigestRecipient[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const channel = rowText((item as Row)["channel"]).toLowerCase();
    const target = rowText((item as Row)["target"]);
    if (!channel || !target) continue;
    recipients.push({ channel, target });
  }
  return recipients;
}
