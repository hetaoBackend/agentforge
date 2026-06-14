import {
  ScheduleType,
  makeTask,
  makeTaskBrief,
  type Task,
  type TaskBrief,
} from "./types.ts";

export const RunbookConfirmationPolicy = {
  AUTO: "auto",
  REQUIRED: "required",
} as const;
export type RunbookConfirmationPolicy =
  (typeof RunbookConfirmationPolicy)[keyof typeof RunbookConfirmationPolicy];

export const RunbookSourceType = {
  BUILTIN: "builtin",
  TEMPLATE: "template",
  SKILL: "skill",
} as const;
export type RunbookSourceType =
  (typeof RunbookSourceType)[keyof typeof RunbookSourceType];

export interface RunbookDefinition {
  name: string;
  aliases: string[];
  description: string;
  source_type: RunbookSourceType;
  source_id: string | null;
  command_schema: Record<string, unknown>;
  prompt_template: string;
  default_agent: string | null;
  confirmation_policy: RunbookConfirmationPolicy;
  enabled: boolean;
}

export interface ParsedRunbookCommand {
  name: string;
  args: string[];
  raw_args: string;
}

export interface RunbookExpansion {
  runbook: RunbookDefinition;
  confirmation_policy: RunbookConfirmationPolicy;
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

export const BUILTIN_RUNBOOKS: BuiltinSpec[] = [
  {
    name: "review-pr",
    aliases: [],
    description: "Review a pull request and summarize risks, bugs, and missing tests.",
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
    description: "Inspect a failing CI run and propose or apply the minimal fix.",
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
    goal: () => "Summarize the current IM thread into a clear task brief or notes.",
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

export function find_runbook(nameOrAlias: string): BuiltinSpec | null {
  const normalized = nameOrAlias.toLowerCase();
  return (
    BUILTIN_RUNBOOKS.find(
      (runbook) =>
        runbook.name === normalized ||
        runbook.aliases.some((alias) => alias.toLowerCase() === normalized),
    ) ?? null
  );
}

export function parse_runbook_command(text: string): ParsedRunbookCommand | null {
  const trimmed = text.trim();
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const known = find_runbook(match[1] ?? "");
  if (!known) return null;
  const raw_args = (match[2] ?? "").trim();
  return {
    name: known.name,
    raw_args,
    args: raw_args ? raw_args.split(/\s+/) : [],
  };
}

export function expand_runbook(args: ExpandArgs): RunbookResult {
  const runbook = find_runbook(args.name);
  if (!runbook) return { ok: false, error: `Unknown runbook: ${args.name}` };

  const validationError = runbook.validate(args.raw_args);
  if (validationError) return { ok: false, error: validationError };

  const agent = args.agent ?? runbook.default_agent ?? null;
  const title = runbook.title(args.raw_args);
  const goal = runbook.goal(args.raw_args);
  const acceptance = runbook.acceptance(args.raw_args);
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
