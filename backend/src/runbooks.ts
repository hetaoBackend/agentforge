import {
  RunbookConfirmationPolicy,
  RunbookSourceType,
  ScheduleType,
  makeTask,
  makeTaskBrief,
  type RunbookConfirmationPolicy as RunbookConfirmationPolicyValue,
  type RunbookSourceType as RunbookSourceTypeValue,
  type Task,
  type TaskBrief,
} from "./types.ts";

export { RunbookConfirmationPolicy, RunbookSourceType } from "./types.ts";

export interface RunbookDefinition {
  name: string;
  aliases: string[];
  description: string;
  source_type: RunbookSourceTypeValue;
  source_id: string | null;
  command_schema: Record<string, unknown>;
  prompt_template: string;
  default_agent: string | null;
  confirmation_policy: RunbookConfirmationPolicyValue;
  enabled: boolean;
}

export interface ParsedRunbookCommand {
  name: string;
  args: string[];
  raw_args: string;
}

export interface RunbookExpansion {
  runbook: RunbookDefinition;
  confirmation_policy: RunbookConfirmationPolicyValue;
  task: Task;
  brief: TaskBrief;
}

export interface RunbookResult {
  ok: boolean;
  expansion?: RunbookExpansion;
  error?: string;
}

interface ExpandArgs {
  name: string;
  raw_args: string;
  source_channel: string;
  source_ref: string;
  source_metadata?: Record<string, unknown>;
  working_dir?: string | null;
  agent?: string | null;
  runbooks?: RunbookDefinition[];
}

type BuiltinSpec = RunbookDefinition & {
  usage: string;
  title: (rawArgs: string) => string;
  goal: (rawArgs: string) => string;
  acceptance: (rawArgs: string) => string[];
  validate: (rawArgs: string) => string | null;
};

function firstArg(rawArgs: string): string {
  return rawArgs.trim().split(/\s+/)[0] ?? "";
}

function requireArg(usage: string): (rawArgs: string) => string | null {
  return (rawArgs) => (firstArg(rawArgs) ? null : `Usage: ${usage}`);
}

function noValidation(_rawArgs: string): string | null {
  return null;
}

function titleizeName(name: string): string {
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderTemplate(template: string, rawArgs: string): string {
  const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    if (key === "raw_args" || key === "args") return rawArgs.trim();
    const argMatch = /^arg(\d+)$/.exec(String(key));
    if (argMatch) {
      const index = Number.parseInt(argMatch[1]!, 10) - 1;
      return args[index] ?? "";
    }
    return "";
  });
}

function isBuiltinSpec(runbook: RunbookDefinition): runbook is BuiltinSpec {
  return (
    "usage" in runbook &&
    "validate" in runbook &&
    "title" in runbook &&
    "goal" in runbook &&
    "acceptance" in runbook
  );
}

function validateGeneric(
  runbook: RunbookDefinition,
  rawArgs: string,
): string | null {
  const schemaArgs = runbook.command_schema["args"];
  if (
    Array.isArray(schemaArgs) &&
    schemaArgs.length > 0 &&
    !firstArg(rawArgs)
  ) {
    return `Usage: /${runbook.name} ${schemaArgs.map((arg) => `<${String(arg)}>`).join(" ")}`;
  }
  return null;
}

function genericTitle(runbook: RunbookDefinition): string {
  return `[Runbook] ${runbook.description || titleizeName(runbook.name)}`;
}

function genericGoal(runbook: RunbookDefinition, rawArgs: string): string {
  const rendered = renderTemplate(runbook.prompt_template, rawArgs).trim();
  return rendered || `Run /${runbook.name} ${rawArgs}`.trim();
}

function genericAcceptance(): string[] {
  return [
    "Complete the runbook goal.",
    "Report what changed and how it was verified.",
  ];
}

export const BUILTIN_RUNBOOKS: BuiltinSpec[] = [
  {
    name: "review-pr",
    aliases: [],
    description:
      "Review a pull request and summarize risks, bugs, and missing tests.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["url"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
    usage: "/review-pr <url>",
    validate: requireArg("/review-pr <url>"),
    title: () => "[Runbook] Review PR",
    goal: (rawArgs) => `Review this pull request:\n${firstArg(rawArgs)}`,
    acceptance: () => [
      "Identify correctness, reliability, security, and test coverage risks.",
      "Call out specific files or changes when possible.",
      "Summarize whether the PR is safe to merge and what should change first.",
    ],
  },
  {
    name: "fix-ci",
    aliases: [],
    description:
      "Inspect a failing CI run and propose or apply the minimal fix.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["url"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/fix-ci <url>",
    validate: requireArg("/fix-ci <url>"),
    title: () => "Fix failing CI run",
    goal: (rawArgs) =>
      `Investigate this failing CI run and fix the minimal issue:\n${firstArg(rawArgs)}`,
    acceptance: () => [
      "Identify the failing job and likely cause.",
      "Patch the minimal relevant code or configuration.",
      "Run the focused tests or explain why they cannot run.",
    ],
  },
  {
    name: "summarize-thread",
    aliases: [],
    description: "Summarize the current IM thread into a task brief or notes.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/summarize-thread",
    validate: noValidation,
    title: () => "Summarize IM thread",
    goal: () =>
      "Summarize the current IM thread into a clear task brief or notes.",
    acceptance: () => [
      "Extract the concrete asks, decisions, and open questions.",
      "Separate facts from assumptions.",
      "Produce a concise summary suitable for creating a task.",
    ],
  },
  {
    name: "write-tests",
    aliases: [],
    description: "Add or improve tests for a file or module.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: ["path"] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.AUTO,
    enabled: true,
    usage: "/write-tests <path>",
    validate: requireArg("/write-tests <path>"),
    title: (rawArgs) => `[Runbook] Write tests for ${firstArg(rawArgs)}`,
    goal: (rawArgs) => `Add or improve tests for ${firstArg(rawArgs)}.`,
    acceptance: () => [
      "Identify the behavior that needs coverage.",
      "Add focused tests using the repo's existing test style.",
      "Run the relevant test command or explain why it cannot run.",
    ],
  },
  {
    name: "release-check",
    aliases: [],
    description: "Run a release readiness checklist for the active repo.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/release-check",
    validate: noValidation,
    title: () => "Release readiness check",
    goal: () => "Run a release readiness checklist for the active repository.",
    acceptance: () => [
      "Inspect the current repository state and recent changes.",
      "Run or identify the relevant release checks.",
      "Report blockers, risks, and the recommended release decision.",
    ],
  },
  {
    name: "scan-skills",
    aliases: [],
    description: "Trigger a manual Skill Library scan.",
    source_type: RunbookSourceType.BUILTIN,
    source_id: null,
    command_schema: { args: [] },
    prompt_template: "",
    default_agent: null,
    confirmation_policy: RunbookConfirmationPolicy.REQUIRED,
    enabled: true,
    usage: "/scan-skills",
    validate: noValidation,
    title: () => "Scan for reusable skills",
    goal: () => "Run a manual Skill Library scan for recurring task patterns.",
    acceptance: () => [
      "Scan recent completed runs for recurring workflows.",
      "Summarize any candidate skills or report that none were found.",
      "Do not install any skill without explicit approval.",
    ],
  },
];

export function find_runbook(
  nameOrAlias: string,
  runbooks: RunbookDefinition[] = [],
): RunbookDefinition | null {
  const normalized = nameOrAlias.toLowerCase();
  const candidates: RunbookDefinition[] = [...BUILTIN_RUNBOOKS, ...runbooks];
  return (
    candidates.find(
      (runbook) =>
        runbook.name === normalized ||
        runbook.aliases.some((alias) => alias.toLowerCase() === normalized),
    ) ?? null
  );
}

export function parse_runbook_command(
  text: string,
  runbooks: RunbookDefinition[] = [],
): ParsedRunbookCommand | null {
  const trimmed = text.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const known = find_runbook(match[1] ?? "", runbooks);
  if (!known) return null;
  const raw_args = (match[2] ?? "").trim();
  return {
    name: known.name,
    raw_args,
    args: raw_args ? raw_args.split(/\s+/) : [],
  };
}

export function expand_runbook(args: ExpandArgs): RunbookResult {
  const runbook = find_runbook(args.name, args.runbooks ?? []);
  if (!runbook) return { ok: false, error: `Unknown runbook: ${args.name}` };

  const validationError = isBuiltinSpec(runbook)
    ? runbook.validate(args.raw_args)
    : validateGeneric(runbook, args.raw_args);
  if (validationError) return { ok: false, error: validationError };

  const agent = args.agent ?? runbook.default_agent ?? null;
  const title = isBuiltinSpec(runbook)
    ? runbook.title(args.raw_args)
    : genericTitle(runbook);
  const goal = isBuiltinSpec(runbook)
    ? runbook.goal(args.raw_args)
    : genericGoal(runbook, args.raw_args);
  const acceptance = isBuiltinSpec(runbook)
    ? runbook.acceptance(args.raw_args)
    : genericAcceptance();
  const prompt = [
    `Runbook: /${runbook.name}`,
    "",
    "Goal:",
    goal,
    "",
    "Acceptance criteria:",
    ...acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
  const task = makeTask({
    title,
    prompt,
    working_dir: args.working_dir ?? ".",
    schedule_type: ScheduleType.IMMEDIATE,
    tags: `runbook,${runbook.name},${args.source_channel}`,
    ...(agent ? { agent } : {}),
  });
  const brief = makeTaskBrief({
    title: title.replace(/^\[Runbook\]\s*/, ""),
    goal,
    context_summary: `Created from /${runbook.name} ${args.raw_args}`.trim(),
    acceptance_criteria: acceptance,
    working_dir: args.working_dir ?? null,
    working_dir_confidence: args.working_dir ? "high" : "unknown",
    agent,
    risk_level:
      runbook.confirmation_policy === RunbookConfirmationPolicy.REQUIRED
        ? "elevated"
        : "normal",
    needs_confirmation:
      runbook.confirmation_policy === RunbookConfirmationPolicy.REQUIRED,
    source_channel: args.source_channel,
    source_ref: args.source_ref,
    source_metadata: args.source_metadata ?? {},
  });

  return {
    ok: true,
    expansion: {
      runbook,
      confirmation_policy: runbook.confirmation_policy,
      task,
      brief,
    },
  };
}

export function runbook_from_row(row: Record<string, any>): RunbookDefinition {
  return {
    name: String(row["name"] ?? ""),
    aliases: Array.isArray(row["aliases"]) ? row["aliases"].map(String) : [],
    description: String(row["description"] ?? ""),
    source_type: row["source_type"] ?? RunbookSourceType.TEMPLATE,
    source_id:
      row["source_id"] === null || row["source_id"] === undefined
        ? null
        : String(row["source_id"]),
    command_schema:
      row["command_schema"] &&
      typeof row["command_schema"] === "object" &&
      !Array.isArray(row["command_schema"])
        ? row["command_schema"]
        : {},
    prompt_template: String(row["prompt_template"] ?? ""),
    default_agent:
      row["default_agent"] === null || row["default_agent"] === undefined
        ? null
        : String(row["default_agent"]),
    confirmation_policy:
      row["confirmation_policy"] === RunbookConfirmationPolicy.AUTO
        ? RunbookConfirmationPolicy.AUTO
        : RunbookConfirmationPolicy.REQUIRED,
    enabled: Boolean(row["enabled"] ?? true),
  };
}
