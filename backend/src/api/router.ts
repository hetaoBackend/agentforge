/**
 * A tiny path router for the REST surface in `api.ts`.
 *
 * Routes used to be a long `if (path === ...)` chain per HTTP method, where a
 * broad pattern had to be written after every narrow one that shared its
 * prefix. That ordering was an unwritten contract: inserting a new
 * `/api/tasks/{id}/xxx` route below `/api/tasks/{id}` silently made it dead
 * code, with no compile error. Here the priority is derived from the patterns
 * themselves, so table order does not matter.
 */

/** One segment of a compiled route pattern. */
type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param" }
  | { kind: "rest" };

/** Ranking of a segment kind; lower is more specific. */
const SEGMENT_RANK: Record<Segment["kind"], number> = {
  literal: 0,
  param: 1,
  rest: 2,
};

/** Rank used for a pattern that has no segment at this position. */
const ABSENT_RANK = 3;

export interface Route<TArgs> {
  /** Uppercase HTTP method, e.g. `"GET"`. */
  method: string;
  /**
   * Slash-prefixed pattern. A segment written as `:name` matches exactly one
   * path segment; `:name+` matches one or more trailing segments and must be
   * the last one. Every other segment matches literally.
   *
   * Handlers read their own ids off the path, so the matcher does not capture
   * segment values — the pattern only decides which handler runs.
   */
  pattern: string;
  handler: (args: TArgs) => Response | Promise<Response>;
}

interface CompiledRoute<TArgs> {
  route: Route<TArgs>;
  segments: Segment[];
}

function parsePattern(pattern: string): Segment[] {
  const raw = segmentsOf(pattern);
  return raw.map((value, index) => {
    if (!value.startsWith(":")) return { kind: "literal", value };
    if (!value.endsWith("+")) return { kind: "param" };
    if (index !== raw.length - 1) {
      throw new Error(`rest segment must be last in pattern: ${pattern}`);
    }
    return { kind: "rest" };
  });
}

/** Splits `/api/tasks/5` into `["api", "tasks", "5"]`. */
function segmentsOf(path: string): string[] {
  const parts = path.split("/");
  return parts[0] === "" ? parts.slice(1) : parts;
}

function matches(segments: Segment[], parts: string[]): boolean {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    // A rest segment is last, so it just needs at least one segment left.
    if (segment.kind === "rest") return parts.length > i;
    const part = parts[i];
    if (part === undefined) return false;
    if (segment.kind === "literal" && segment.value !== part) return false;
  }
  return parts.length === segments.length;
}

/**
 * Orders two patterns by specificity, comparing segment by segment: a literal
 * beats a `:param`, which beats a `:param+`, and a longer pattern beats a
 * shorter one that agrees on the shared prefix. This is what replaces the old
 * hand-maintained ordering of the `if` chains.
 */
function compareSpecificity(a: Segment[], b: Segment[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ? SEGMENT_RANK[a[i]!.kind] : ABSENT_RANK;
    const right = b[i] ? SEGMENT_RANK[b[i]!.kind] : ABSENT_RANK;
    if (left !== right) return left - right;
  }
  return 0;
}

export class Router<TArgs> {
  private readonly byMethod = new Map<string, CompiledRoute<TArgs>[]>();

  constructor(routes: Array<Route<TArgs>>) {
    const seen = new Set<string>();
    for (const route of routes) {
      const key = `${route.method} ${route.pattern}`;
      if (seen.has(key)) {
        throw new Error(`duplicate route: ${key}`);
      }
      seen.add(key);
      const compiled = { route, segments: parsePattern(route.pattern) };
      const bucket = this.byMethod.get(route.method);
      if (bucket) bucket.push(compiled);
      else this.byMethod.set(route.method, [compiled]);
    }
    for (const bucket of this.byMethod.values()) {
      bucket.sort((a, b) => compareSpecificity(a.segments, b.segments));
    }
  }

  /** Returns the most specific route for `path`, or null when none matches. */
  find(method: string, path: string): Route<TArgs> | null {
    const bucket = this.byMethod.get(method);
    if (!bucket) return null;
    const parts = segmentsOf(path);
    for (const candidate of bucket) {
      if (matches(candidate.segments, parts)) return candidate.route;
    }
    return null;
  }
}
