/**
 * Shared utilities for switching the default coding agent across all channels.
 *
 * Usage from any channel:
 *     /agent claude   — switch to Claude Code
 *     /agent codex    — switch to Codex CLI
 */

// Structural view of TaskDB — only what these helpers touch.
export interface SettingsDB {
  get_setting(key: string, defaultValue?: string | null): string | null;
  set_setting(key: string, value: string): void;
}

// Supported agent names
export const SUPPORTED_AGENTS: Record<string, string> = {
  claude: "Claude Code (claude CLI)",
  codex: "Codex CLI (openai/codex)",
};
export const DEFAULT_AGENT = "codex";

// Regex: /agent <name>
const AGENT_CMD_RE = /^\/agent\s+(\S+)\s*$/i;

/** Return the agent name argument if `text` is a /agent command, else null. */
export function parse_agent_command(text: string): string | null {
  const m = AGENT_CMD_RE.exec(text.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * If `text` is a /agent command, persist the choice to DB and return a
 * confirmation string. Returns null if `text` is not an agent command.
 *
 * The setting is stored as global `default_agent` (shared across all channels
 * and the Forge desktop app).
 */
export function handle_agent_command(
  text: string,
  channel_key: string,
  db: SettingsDB,
): string | null {
  const agent = parse_agent_command(text);
  if (agent === null) return null;

  if (!(agent in SUPPORTED_AGENTS)) {
    const names = Object.keys(SUPPORTED_AGENTS)
      .map((k) => `\`${k}\``)
      .join(", ");
    return `❌ Unknown agent \`${agent}\`. Supported: ${names}`;
  }

  db.set_setting("default_agent", agent);
  const label = SUPPORTED_AGENTS[agent];
  return `🤖 Default agent switched to: **${label}**`;
}

/**
 * Return the current default agent from settings.
 * Falls back to the app default if not set.
 */
export function resolve_agent(channel_key: string, db: SettingsDB): string {
  return db.get_setting("default_agent", DEFAULT_AGENT) ?? DEFAULT_AGENT;
}
