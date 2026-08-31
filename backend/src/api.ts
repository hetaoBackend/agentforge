/**
 * The REST surface: one route table assembled from the per-domain modules,
 * plus the request pipeline (CORS, CSRF, body limits) wrapped around it.
 */

import { Router, type Route } from "./api/router.ts";
import {
  type ApiContext,
  type RouteArgs,
  type Row,
  checkCsrf,
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
  readJsonBody,
} from "./api/shared.ts";
import { HEARTBEAT_ROUTES } from "./api/heartbeats.ts";
import { TASK_BRIEF_ROUTES } from "./api/task_briefs.ts";
import { IM_RUNBOOK_ROUTES } from "./api/im_runbooks.ts";
import { TASK_ROUTES } from "./api/tasks.ts";
import { TASK_GRAPH_ROUTES } from "./api/task_graph.ts";
import { SKILL_ROUTES } from "./api/skills.ts";
import { IM_DIGEST_ROUTES } from "./api/im_digests.ts";
import { CHANNEL_ROUTES } from "./api/channels.ts";
import { SETTINGS_ROUTES } from "./api/settings.ts";
import { META_ROUTES } from "./api/meta.ts";

export type { ApiContext };

/**
 * Every REST route, grouped by the module that owns it. Order is
 * presentational only — the router derives match priority from the patterns,
 * so a broad `/api/tasks/:task_id+` cannot swallow a narrow
 * `/api/tasks/:id/runs` declared elsewhere.
 */
const ROUTES: Array<Route<RouteArgs>> = [
  ...HEARTBEAT_ROUTES,
  ...TASK_BRIEF_ROUTES,
  ...IM_RUNBOOK_ROUTES,
  ...TASK_ROUTES,
  ...TASK_GRAPH_ROUTES,
  ...SKILL_ROUTES,
  ...IM_DIGEST_ROUTES,
  ...CHANNEL_ROUTES,
  ...SETTINGS_ROUTES,
  ...META_ROUTES,
];

const ROUTER = new Router(ROUTES);

/** Methods dispatched through the router; anything else is a 405. */
const ROUTABLE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Methods whose request body is parsed before routing. */
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** PATCH shares the PUT handlers, so it is not registered separately. */
function routingMethod(method: string): string {
  return method === "PATCH" ? "PUT" : method;
}

export async function handleApiRequest(
  ctx: ApiContext,
  req: Request,
): Promise<Response> {
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders(origin) });
  }
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "not found" }, 404, origin);
  }
  if (
    req.method === "PATCH" &&
    !url.pathname.startsWith("/api/task-briefs/") &&
    !url.pathname.startsWith("/api/im-runbooks/")
  ) {
    void req.body?.cancel();
    return jsonResponse({ error: "method not allowed" }, 405, origin);
  }
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    !checkCsrf(req)
  ) {
    void req.body?.cancel();
    return jsonResponse(
      { error: "CSRF token missing or invalid" },
      403,
      origin,
    );
  }

  try {
    if (!ROUTABLE_METHODS.has(req.method)) {
      return jsonResponse({ error: "method not allowed" }, 405, origin);
    }
    // Read the body before matching, so an oversized or malformed body is
    // rejected the same way whether or not the path resolves to a route.
    let body: Row = {};
    if (BODY_METHODS.has(req.method)) {
      const bodyOrResponse = await readJsonBody(req, origin);
      if (bodyOrResponse instanceof Response) return bodyOrResponse;
      body = bodyOrResponse;
    }
    const route = ROUTER.find(routingMethod(req.method), url.pathname);
    if (!route) return jsonResponse({ error: "not found" }, 404, origin);
    return await route.handler({ ctx, url, path: url.pathname, origin, body });
  } catch (e) {
    return jsonResponse(
      { error: e instanceof Error ? e.message : String(e) },
      500,
      origin,
    );
  }
}
