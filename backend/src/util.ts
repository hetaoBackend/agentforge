// Helpers ported from taskboard.py (lines 117-187) plus the local-naive
// ISO timestamp conventions used throughout the Python backend.

import os from "node:os";

/**
 * Return process.env augmented with common macOS tool install paths.
 * Desktop GUI launchers inherit a stripped PATH that often
 * misses npm globals, Homebrew, and ~/.local/bin.
 */
export function getEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  const home = os.homedir();
  const extra = [
    `${home}/.local/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin", // Apple-silicon Homebrew
    "/usr/local/opt/node/bin",
    `${home}/.npm/bin`,
    `${home}/.nvm/current/bin`,
    "/usr/bin",
    "/bin",
  ];
  const current = env.PATH ?? "";
  env.PATH =
    extra.filter((p) => !current.includes(p)).join(":") +
    (current ? `:${current}` : "");
  return env;
}

/**
 * Format a Date as a local-naive ISO string, matching Python's
 * `datetime.now().isoformat()` storage convention (no timezone suffix,
 * 6-digit fractional seconds). Strings of this shape sort lexicographically.
 */
export function dateToLocalIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}000`
  );
}

/** Local-naive ISO timestamp for "now" (≙ Python `datetime.now().isoformat()`). */
export function nowIso(): string {
  return dateToLocalIso(new Date());
}

/**
 * Parse ISO datetimes and collapse aware values into local naive datetimes.
 *
 * The app historically stored naive local timestamps, but the desktop UI can
 * submit offset-aware ISO strings for `scheduled_at`. JS Dates are epoch-based,
 * so "aware → local naive" simply means: parse, and later re-serialize with
 * dateToLocalIso(). Date-only strings are pinned to local midnight to match
 * Python's fromisoformat semantics (plain `new Date("YYYY-MM-DD")` is UTC).
 *
 * Throws on unparseable input (≙ Python ValueError).
 */
export function parseComparableDatetime(
  value: string | null | undefined,
): Date | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00`
    : value;
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`Invalid isoformat string: ${JSON.stringify(value)}`);
  }
  return dt;
}

export function normalizeDatetimeForStorage(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  let dt: Date | null;
  try {
    dt = parseComparableDatetime(value);
  } catch {
    return value;
  }
  return dt ? dateToLocalIso(dt) : null;
}

/**
 * Extract a JSON object from raw agent output (≙ taskboard.py
 * `_parse_json_object`): strips markdown fences, then trims to the outermost
 * {...} span. Throws if the result is not a JSON object.
 */
export function parseJsonObject(rawText: string): Record<string, unknown> {
  let text = (rawText || "").trim();
  if (text.startsWith("```")) {
    text = text
      .split(/\r?\n/)
      .filter((ln) => !ln.trim().startsWith("```"))
      .join("\n")
      .trim();
  }
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("expected JSON object");
  }
  return data as Record<string, unknown>;
}
