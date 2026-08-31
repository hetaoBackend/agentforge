/**
 * Locating and hiding agent-generated images, shared by every chat channel.
 *
 * Telegram, Feishu and WeChat each carried their own copy of these ten
 * routines. The copies had drifted: Telegram gained working-directory
 * resolution for relative markdown references, its `canonical_image_path`
 * filtered on the uploadable-suffix set, and it split lines on a lone `\r`.
 * The other two were older snapshots of the same code. A fix applied to one
 * channel therefore never reached the others.
 *
 * This module standardises on the Telegram behaviour, which is a superset:
 * `working_dir` stays optional, so a caller that omits it gets what the
 * older copies did. The `db` and `label` parameters carry the only pieces
 * of channel state the routines ever touched — the run/event lookup and the
 * log prefix.
 */

import fs from "node:fs";
import path from "node:path";

import {
  is_uploadable_image,
  markdown_image_refs,
  replace_markdown_image_refs,
} from "./image_utils.ts";
import {
  expanduser,
  file_url_path,
  is_plain_object,
  unquote,
} from "./path_utils.ts";

/** The slice of a channel's task database these routines read. */
export interface GeneratedImageDB {
  get_task_runs(task_id: number, limit?: number): unknown;
  get_run_output_events(run_id: number, limit?: number): unknown;
}

/** Resolve `image_path` to a real, uploadable image file, or null. */
export function canonical_image_path(image_path: string | null): string | null {
  if (!image_path) {
    return null;
  }
  try {
    const p = expanduser(image_path);
    if (!is_uploadable_image(p)) {
      return null;
    }
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      return null;
    }
    return fs.realpathSync(path.resolve(p));
  } catch {
    return null;
  }
}

/** Strip the `<>`/quote/title decorations a markdown image target may carry. */
export function markdown_image_reference_target(reference: string): string {
  const raw = (reference || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.startsWith("<")) {
    const end = raw.indexOf(">");
    if (end >= 0) {
      return raw.slice(1, end).trim();
    }
  }
  if (raw[0] === "'" || raw[0] === '"') {
    const end = raw.indexOf(raw[0]!, 1);
    if (end > 0) {
      return raw.slice(1, end).trim();
    }
  }
  const titled = /^(.+?)\s+['"][^'"]*['"]\s*$/.exec(raw);
  return (titled ? titled[1]! : raw).trim();
}

/** Resolve a markdown image reference to a local file, or null for remote ones. */
export function local_image_path_from_reference(
  reference: string,
  working_dir: string | null = null,
): string | null {
  let target = markdown_image_reference_target(reference);
  if (
    !target ||
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("data:")
  ) {
    return null;
  }
  if (target.startsWith("file://")) {
    target = file_url_path(target);
  } else if (target.startsWith("sandbox:")) {
    target = target.slice("sandbox:".length);
  }
  target = unquote(target).trim();
  if (!target) {
    return null;
  }

  let p = expanduser(target);
  if (!path.isAbsolute(p) && working_dir) {
    p = path.join(expanduser(working_dir), p);
  }
  return canonical_image_path(p);
}

/** Every local image referenced by markdown in `content`. */
export function generated_image_paths_from_markdown(
  content: string,
  working_dir: string | null = null,
): string[] {
  const paths: string[] = [];
  for (const ref of markdown_image_refs(content)) {
    const image_path = local_image_path_from_reference(ref, working_dir);
    if (image_path) {
      paths.push(image_path);
    }
  }
  return paths;
}

/** Canonicalise and drop duplicates, preserving first-seen order. */
export function dedupe_image_paths(image_paths: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const image_path of image_paths) {
    const canonical = canonical_image_path(image_path);
    if (!canonical || seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    deduped.push(canonical);
  }
  return deduped;
}

/** True when a `- <path>` bullet names an image we already uploaded. */
export function line_is_uploaded_image_path(
  stripped_line: string,
  uploaded_paths: Set<string>,
  working_dir: string | null = null,
): boolean {
  if (!stripped_line.startsWith("- ")) {
    return false;
  }
  const candidate = stripped_line.slice(2).trim();
  const canonical =
    local_image_path_from_reference(candidate, working_dir) ??
    canonical_image_path(candidate);
  if (canonical && uploaded_paths.has(canonical)) {
    return true;
  }
  return stripped_line.includes("/.codex/generated_images/");
}

/** Drop markdown image refs from `line` that point at an uploaded image. */
export function remove_uploaded_markdown_image_refs(
  line: string,
  uploaded_paths: Set<string>,
  working_dir: string | null = null,
): string {
  if (uploaded_paths.size === 0) {
    return line;
  }

  return replace_markdown_image_refs(line, (match, ref) => {
    const image_path = local_image_path_from_reference(ref, working_dir);
    const canonical = image_path ? canonical_image_path(image_path) : null;
    return canonical !== null && uploaded_paths.has(canonical) ? "" : match;
  });
}

/**
 * Rewrite `content` for a channel that has already uploaded the images:
 * remove the paths and refs pointing at them, and fall back to a short
 * "N images" line when nothing else is left to say.
 */
export function hide_generated_image_paths(
  content: string,
  image_count: number,
  uploaded_paths: string[] | null = null,
  working_dir: string | null = null,
): string {
  const uploaded = new Set<string>();
  for (const p of uploaded_paths ?? []) {
    const canonical = canonical_image_path(p);
    if (canonical) {
      uploaded.add(canonical);
    }
  }
  const lines: string[] = [];
  for (const line of (content || "").split(/\r\n|\r|\n/)) {
    const stripped = line.trim();
    if (!stripped) {
      lines.push("");
      continue;
    }
    if (line_is_uploaded_image_path(stripped, uploaded, working_dir)) {
      continue;
    }
    const cleaned_line = remove_uploaded_markdown_image_refs(
      line,
      uploaded,
      working_dir,
    );
    const visible = cleaned_line.trim();
    if (visible && visible !== "-" && visible !== "*" && visible !== "+") {
      lines.push(cleaned_line.replace(/\s+$/, ""));
    }
  }
  const cleaned = lines.join("\n").trim();
  if (!cleaned || cleaned.startsWith("已生成")) {
    return `已生成 ${image_count} 张图片。`;
  }
  return cleaned;
}

/** Image paths recorded as `generated_image` events on a task's latest run. */
export function generated_image_paths_for_task(
  db: GeneratedImageDB,
  label: string,
  task_id: number,
): string[] {
  let runs: unknown;
  try {
    runs = db.get_task_runs(task_id, 1);
  } catch (exc) {
    console.log(`[${label}] Failed to load runs for generated images: ${exc}`);
    return [];
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return [];
  }

  const first: unknown = runs[0];
  const run_id = is_plain_object(first) ? first["id"] : null;
  if (!run_id) {
    return [];
  }
  let events: unknown;
  try {
    events = db.get_run_output_events(run_id as number, 1000);
  } catch (exc) {
    console.log(
      `[${label}] Failed to load output events for generated images: ${exc}`,
    );
    return [];
  }
  if (!Array.isArray(events)) {
    return [];
  }

  const paths: string[] = [];
  for (const event of events) {
    if (!is_plain_object(event) || event["event_type"] !== "generated_image") {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse((event["content"] as string | undefined) || "{}");
    } catch {
      continue;
    }
    const p = is_plain_object(payload) ? payload["path"] : null;
    if (p) {
      paths.push(p as string);
    }
  }
  return paths;
}

/** Run-recorded images plus the ones `content` references, deduplicated. */
export function collect_generated_image_paths(
  db: GeneratedImageDB,
  label: string,
  task_id: number,
  content: string,
  task: Record<string, unknown> | null = null,
): string[] {
  const paths = generated_image_paths_for_task(db, label, task_id);
  paths.push(
    ...generated_image_paths_from_markdown(
      content,
      ((task ?? {})["working_dir"] as string | null | undefined) ?? null,
    ),
  );
  return dedupe_image_paths(paths);
}
