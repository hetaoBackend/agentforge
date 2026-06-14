type Row = Record<string, unknown>;

export type BriefCommand =
  | { action: "create"; goal: string }
  | { action: "confirm"; brief_id: number }
  | { action: "discard"; brief_id: number }
  | { action: "help"; reason: "missing_goal" | "invalid_brief_id" };
type BriefHelpReason = Extract<BriefCommand, { action: "help" }>["reason"];

function parseBriefId(value: string): number | null {
  const raw = value.trim().replace(/^#+/, "");
  if (!/^\d+$/.test(raw)) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function parse_brief_command(text: string): BriefCommand | null {
  const trimmed = text.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const cmd = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();

  if (cmd === "brief") {
    return args
      ? { action: "create", goal: args }
      : { action: "help", reason: "missing_goal" };
  }
  if (cmd === "confirm-brief" || cmd === "run-brief") {
    const brief_id = parseBriefId(args);
    return brief_id === null
      ? { action: "help", reason: "invalid_brief_id" }
      : { action: "confirm", brief_id };
  }
  if (cmd === "discard-brief") {
    const brief_id = parseBriefId(args);
    return brief_id === null
      ? { action: "help", reason: "invalid_brief_id" }
      : { action: "discard", brief_id };
  }
  return null;
}

function titleFromGoal(goal: string): string {
  const singleLine = goal.replace(/\s+/g, " ").trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

export function build_brief_payload(args: {
  channel: string;
  goal: string;
  source_ref: string;
  source_metadata?: Row;
  working_dir?: string | null;
  agent?: string | null;
}): Row {
  return {
    title: titleFromGoal(args.goal),
    goal: args.goal.trim(),
    context_summary: "",
    acceptance_criteria: [],
    working_dir: args.working_dir ?? null,
    working_dir_confidence: "unknown",
    agent: args.agent ?? null,
    risk_level: "normal",
    needs_confirmation: true,
    source_channel: args.channel,
    source_ref: args.source_ref,
    source_metadata: args.source_metadata ?? {},
  };
}

export function format_brief_help(reason: BriefHelpReason): string {
  if (reason === "missing_goal") {
    return "Usage: `/brief <what should AgentForge do?>`";
  }
  return "Usage: `/confirm-brief <brief_id>` or `/discard-brief <brief_id>`";
}

export function format_brief_created_reply(
  brief_id: number,
  title: string,
): string {
  return [
    `Draft task brief #${brief_id}: ${title}`,
    "",
    `Run: \`/confirm-brief ${brief_id}\``,
    `Discard: \`/discard-brief ${brief_id}\``,
  ].join("\n");
}

export function format_brief_started_reply(
  brief_id: number,
  task_id: number,
): string {
  return `Task #${task_id} created from brief #${brief_id}. Thinking ▌`;
}

export function format_brief_discarded_reply(brief_id: number): string {
  return `Draft task brief #${brief_id} discarded.`;
}
