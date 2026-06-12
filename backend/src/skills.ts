// Skill Library: on-disk skill files, ported from taskboard.py (lines 1662-1768).
//
// Canonical SKILL.md lives in an AgentForge-owned dir and is symlinked into
// each agent's native skill dir. Both agents load via their own progressive
// disclosure; enable/disable just adds/removes the two symlinks (canonical kept).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./log.ts";

/**
 * ≙ Python os.path.expanduser: "~" resolves through $HOME (tests override
 * process.env.HOME), falling back to os.homedir().
 */
export function expanduser(p: string): string {
  const home = process.env.HOME || os.homedir();
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function islink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function _skill_library_dirs(): [string, string, string] {
  return [
    expanduser("~/.agentforge/skills"), // canonical (AgentForge-owned)
    expanduser("~/.claude/skills"), // claude consumer
    expanduser("~/.agents/skills"), // codex consumer
  ];
}

/**
 * Path to the vendored Anthropic skill-creator skill (dev tree or packaged binary).
 *
 * Python resolves `getattr(sys, "_MEIPASS", dirname(abspath(__file__)))` +
 * "vendor/skill-creator": taskboard.py sits at the repo root, so the dev path
 * is <repo>/vendor/skill-creator, and a PyInstaller binary uses the bundled
 * data dir (sys._MEIPASS).
 *
 * Bun-compile has no _MEIPASS equivalent (no bundled-data dir): inside a
 * compiled binary import.meta.dir is a virtual bunfs path, so we fall back to
 * a vendor/ dir next to the executable (dirname(process.execPath)) — the
 * packager must ship vendor/skill-creator alongside the binary. In the dev
 * tree this file lives at backend/src/, so the repo root is two levels up.
 */
export function _skill_creator_dir(): string {
  const here = import.meta.dir;
  const isCompiled = here.includes("$bunfs") || here.includes("~BUN");
  const base = isCompiled ? path.dirname(process.execPath) : path.resolve(here, "..", "..");
  return path.join(base, "vendor", "skill-creator");
}

/** Lowercase kebab slug safe as a directory name (no path traversal). */
export function _sanitize_skill_name(name: string | null | undefined): string {
  name = (name || "").trim().toLowerCase();
  let slug = "";
  for (const ch of name) {
    slug += /[\p{L}\p{N}]/u.test(ch) ? ch : "-";
  }
  while (slug.includes("--")) {
    slug = slug.replace("--", "-");
  }
  return slug.replace(/^-+|-+$/g, "");
}

/** Create/refresh the claude + codex symlinks pointing at the canonical dir. */
export function link_skill(name: string): string[] {
  const [canonical_root, claude_root, agents_root] = _skill_library_dirs();
  const skill_dir = path.join(canonical_root, name);
  const links: string[] = [];
  for (const root of [claude_root, agents_root]) {
    fs.mkdirSync(root, { recursive: true });
    const link = path.join(root, name);
    if (islink(link)) {
      fs.unlinkSync(link);
    }
    if (!fs.existsSync(link)) {
      try {
        fs.symlinkSync(skill_dir, link, "dir");
      } catch (e) {
        logger.warning(`symlink ${link} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    links.push(link);
  }
  return links;
}

/** Remove both consumer symlinks; leave the canonical dir intact. */
export function unlink_skill(name: string): void {
  const [_canonical_root, claude_root, agents_root] = _skill_library_dirs();
  void _canonical_root;
  for (const root of [claude_root, agents_root]) {
    const link = path.join(root, name);
    if (islink(link)) {
      try {
        fs.unlinkSync(link);
      } catch {
        // ≙ except OSError: pass
      }
    }
  }
}

/** Write canonical SKILL.md and create both symlinks. Returns (md_path, dir). */
export function write_skill_to_disk(name: string, body: string): [string, string] {
  const [canonical_root, _claude_root, _agents_root] = _skill_library_dirs();
  void _claude_root;
  void _agents_root;
  const skill_dir = path.join(canonical_root, name);
  fs.mkdirSync(skill_dir, { recursive: true });
  const skill_md = path.join(skill_dir, "SKILL.md");
  fs.writeFileSync(skill_md, body, { encoding: "utf-8" });
  link_skill(name);
  return [skill_md, skill_dir];
}

/** Remove symlinks and the canonical dir entirely (used on delete). */
export function remove_skill_from_disk(name: string): void {
  unlink_skill(name);
  const [canonical_root, _claude_root, _agents_root] = _skill_library_dirs();
  void _claude_root;
  void _agents_root;
  const skill_dir = path.join(canonical_root, name);
  let isDir = false;
  try {
    isDir = fs.statSync(skill_dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (isDir) {
    fs.rmSync(skill_dir, { recursive: true, force: true });
  }
}

export function _compose_skill_md(
  name: string,
  description: string | null | undefined,
  body_markdown: string | null | undefined,
): string {
  const desc = (description || "").replaceAll("\n", " ").trim();
  const body = (body_markdown || "").trim();
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`;
}

/** Pull name + description out of a SKILL.md's YAML frontmatter (best-effort). */
export function _parse_skill_frontmatter(body: string | null | undefined): [string, string] {
  let name = "";
  let description = "";
  const text = (body || "").replace(/^\s+/, "");
  if (!text.startsWith("---")) {
    return [name, description];
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return [name, description];
  }
  for (const line of text.slice(3, end).split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    const val = line.slice(sep + 1).trim();
    if (key === "name" && !name) {
      name = val;
    } else if (key === "description" && !description) {
      description = val;
    }
  }
  return [name, description];
}
