/**
 * Shared utilities for working-directory management across all channels.
 *
 * Two features:
 * 1. /dir (or cd) command  — explicit path switch, persists to DB.
 * 2. Claude-based extraction — ask claude-haiku to pull a path from a
 *    free-text prompt so the user can say "在 ~/myproject 里帮我…"
 *    without typing a /dir command first.
 */

import type { SettingsDB } from "./agent_utils.ts";

// ── 1. Explicit /dir / cd command ─────────────────────────────────────────

// Patterns we recognise as "switch directory" commands:
//   /dir ~/foo      cd ~/foo      /cd ~/foo
const DIR_CMD_RE = /^(?:\/dir|\/cd|cd)\s+(\S+)\s*$/i;

/** Return the path argument if `text` is a /dir or cd command, else null. */
export function parse_dir_command(text: string): string | null {
  const m = DIR_CMD_RE.exec(text.trim());
  return m ? m[1]! : null;
}

/**
 * If `text` is a /dir command, persist the new path to DB and return a
 * confirmation string. Returns null if `text` is not a dir command.
 *
 * `channel_key` is the settings key prefix, e.g. "telegram", "slack", "feishu".
 */
export function handle_dir_command(
  text: string,
  channel_key: string,
  db: SettingsDB,
): string | null {
  const path = parse_dir_command(text);
  if (path === null) return null;

  const setting_key = `${channel_key}_default_working_dir`;
  db.set_setting(setting_key, path);
  return `📁 Working directory set to: ${path}`;
}

// ── 2. Claude-based path extraction ───────────────────────────────────────

const EXTRACT_SYSTEM =
  "You are a path-extraction assistant. " +
  "Given a user message, decide if it explicitly mentions a filesystem path " +
  "where some work should be done (e.g. ~/projects/foo, /home/user/bar, " +
  "./myapp, C:\\\\Users\\\\foo). " +
  "Reply with a JSON object and nothing else:\n" +
  '  {"path": "<extracted path>"}  — if a path is found\n' +
  '  {"path": null}               — if no path is mentioned\n' +
  "Do NOT invent a path. Only return one that is clearly stated in the message.";

/**
 * Call the Anthropic Messages API (claude-haiku) to extract an explicit
 * working directory from `prompt`.
 * Returns the path string, or null if none found / on any error.
 */
export async function extract_working_dir_with_claude(
  prompt: string,
): Promise<string | null> {
  const api_key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!api_key) return null;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        system: EXTRACT_SYSTEM,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status !== 200) return null;

    const data: any = await resp.json();
    const text = (data?.content?.[0]?.text ?? "").trim();
    const parsed = JSON.parse(text);
    const path = parsed?.path;
    if (path && typeof path === "string") return path.trim();
  } catch {
    /* network/parse errors → no extraction */
  }
  return null;
}

// Seam for tests (≙ pytest monkeypatching dir_utils.extract_working_dir_with_claude):
// resolve_working_dir reads the extractor through this mutable hook object.
export const _hooks = { extract_working_dir_with_claude };

/**
 * Determine the working directory for a new task:
 * 1. Try to extract an explicit path from `prompt` via Claude.
 * 2. Fall back to the channel's default_working_dir in DB.
 * 3. Fall back to "~".
 */
export async function resolve_working_dir(
  prompt: string,
  channel_key: string,
  db: SettingsDB,
): Promise<string> {
  const extracted = await _hooks.extract_working_dir_with_claude(prompt);
  if (extracted) return extracted;

  const setting_key = `${channel_key}_default_working_dir`;
  return db.get_setting(setting_key) || "~";
}
