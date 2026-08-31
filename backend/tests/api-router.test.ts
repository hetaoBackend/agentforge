import { describe, expect, test } from "bun:test";

import { Router, type Route } from "../src/api/router.ts";

/** Builds a router whose handlers just report which pattern was hit. */
function routerOf(...specs: Array<[string, string]>): Router<null> {
  const routes: Array<Route<null>> = specs.map(([method, pattern]) => ({
    method,
    pattern,
    handler: () => new Response(pattern),
  }));
  return new Router(routes);
}

function hit(
  router: Router<null>,
  method: string,
  path: string,
): string | null {
  return router.find(method, path)?.pattern ?? null;
}

describe("api router", () => {
  test("matches literal patterns exactly", () => {
    const router = routerOf(["GET", "/api/tasks"], ["GET", "/api/skills"]);

    expect(hit(router, "GET", "/api/tasks")).toBe("/api/tasks");
    expect(hit(router, "GET", "/api/skills")).toBe("/api/skills");
    expect(hit(router, "GET", "/api/unknown")).toBeNull();
  });

  test("a :param consumes exactly one segment", () => {
    const router = routerOf(["GET", "/api/tasks/:id"]);

    expect(hit(router, "GET", "/api/tasks/7")).toBe("/api/tasks/:id");
    // Any single segment, not just digits — handlers do their own id parsing.
    expect(hit(router, "GET", "/api/tasks/abc")).toBe("/api/tasks/:id");
    expect(hit(router, "GET", "/api/tasks")).toBeNull();
    expect(hit(router, "GET", "/api/tasks/7/runs")).toBeNull();
  });

  test("a :param+ consumes one or more trailing segments", () => {
    const router = routerOf(["GET", "/api/dag/:dag_id+"]);

    expect(hit(router, "GET", "/api/dag/abc")).toBe("/api/dag/:dag_id+");
    expect(hit(router, "GET", "/api/dag/a/b/c")).toBe("/api/dag/:dag_id+");
    // "one or more" — a bare prefix does not match.
    expect(hit(router, "GET", "/api/dag")).toBeNull();
  });

  test("a narrow pattern wins even when declared after a broad one", () => {
    // This is the ordering bug the route table exists to prevent: in the old
    // if-chain, a broad match written first silently shadowed every later one.
    const router = routerOf(
      ["GET", "/api/tasks/:id+"],
      ["GET", "/api/tasks/:id/runs"],
      ["GET", "/api/tasks/:id"],
    );

    expect(hit(router, "GET", "/api/tasks/7/runs")).toBe("/api/tasks/:id/runs");
    expect(hit(router, "GET", "/api/tasks/7")).toBe("/api/tasks/:id");
    expect(hit(router, "GET", "/api/tasks/7/other")).toBe("/api/tasks/:id+");
  });

  test("a literal segment outranks a :param at the same position", () => {
    const router = routerOf(
      ["POST", "/api/im-runbooks/:name"],
      ["POST", "/api/im-runbooks/from-task"],
    );

    expect(hit(router, "POST", "/api/im-runbooks/from-task")).toBe(
      "/api/im-runbooks/from-task",
    );
    expect(hit(router, "POST", "/api/im-runbooks/other")).toBe(
      "/api/im-runbooks/:name",
    );
  });

  test("routes are scoped to their method", () => {
    const router = routerOf(
      ["GET", "/api/tasks/:id"],
      ["DELETE", "/api/tasks"],
    );

    expect(hit(router, "DELETE", "/api/tasks/7")).toBeNull();
    expect(hit(router, "GET", "/api/tasks")).toBeNull();
    expect(hit(router, "PATCH", "/api/tasks")).toBeNull();
  });

  test("rejects a duplicate method plus pattern", () => {
    expect(() =>
      routerOf(["GET", "/api/tasks"], ["GET", "/api/tasks"]),
    ).toThrow("duplicate route: GET /api/tasks");
    // The same pattern under a different method is fine.
    expect(() =>
      routerOf(["GET", "/api/tasks"], ["POST", "/api/tasks"]),
    ).not.toThrow();
  });

  test("rejects a rest segment that is not last", () => {
    expect(() => routerOf(["GET", "/api/tasks/:id+/runs"])).toThrow(
      "rest segment must be last",
    );
  });
});
