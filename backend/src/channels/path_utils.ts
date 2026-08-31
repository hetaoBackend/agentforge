/**
 * Shared path/value helpers used by every chat channel.
 *
 * These were previously duplicated verbatim in `telegram.ts`, `weixin.ts` and
 * (under camelCase names) `feishu.ts`. The implementations here are byte-for-byte
 * the same as the copies they replace, so channel behaviour is unchanged.
 *
 * Note: `feishu.ts` keeps its own `fileUrlPath`, which tries `new URL()` before
 * falling back to this module's slicing logic. That divergence is deliberate and
 * documented at its definition — do not fold it in here without checking the
 * degenerate `file://` (empty path) case.
 */

import os from "node:os";
import path from "node:path";

/** ≙ urlparse(target).path for file:// references (scheme + netloc dropped). */
export function file_url_path(target: string): string {
  const rest = target.slice("file://".length);
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "";
}

/** ≙ urllib.parse.unquote (left untouched when percent-decoding fails). */
export function unquote(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** ≙ Path.expanduser(). */
export function expanduser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** True for non-null, non-array objects — i.e. a JSON object payload. */
export function is_plain_object(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
