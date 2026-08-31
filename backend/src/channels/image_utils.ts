/**
 * Shared markdown-image helpers used by every chat channel.
 *
 * Previously each channel carried its own `*_UPLOADABLE_IMAGE_SUFFIXES` set and
 * `*_MARKDOWN_IMAGE_RE` regex. The suffix sets were identical across Telegram,
 * Feishu and WeChat; the regexes differed only in whether the `(...)` capture
 * excluded newlines. This module standardises on the newline-excluding form —
 * a markdown image reference never legitimately spans lines, and allowing it to
 * lets an unclosed `(` swallow unrelated content during ref stripping.
 *
 * The regex is built per call rather than shared as a module-level `/g` const,
 * so no channel can leak `lastIndex` state into another.
 */

import path from "node:path";

/** File extensions the channels are willing to upload as an image. */
export const UPLOADABLE_IMAGE_SUFFIXES: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

/** True when `image_path` has an extension we can upload as an image. */
export function is_uploadable_image(image_path: string): boolean {
  return UPLOADABLE_IMAGE_SUFFIXES.has(path.extname(image_path).toLowerCase());
}

const MARKDOWN_IMAGE_PATTERN = String.raw`!\[[^\]]*]\(([^)\n]+)\)`;

/** A fresh global regex — never share one, `lastIndex` is mutable state. */
function markdown_image_re(): RegExp {
  return new RegExp(MARKDOWN_IMAGE_PATTERN, "g");
}

/** Every `![alt](ref)` target in `content`, in order. */
export function markdown_image_refs(content: string): string[] {
  const refs: string[] = [];
  for (const match of (content || "").matchAll(markdown_image_re())) {
    refs.push(match[1] ?? "");
  }
  return refs;
}

/**
 * Rewrite every `![alt](ref)` in `line`. `replacer` receives the full match and
 * the captured ref, and returns the replacement text.
 */
export function replace_markdown_image_refs(
  line: string,
  replacer: (full_match: string, ref: string) => string,
): string {
  return line.replace(markdown_image_re(), (full, ref: string) =>
    replacer(full, ref),
  );
}
