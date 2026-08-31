/**
 * Routes that describe the server itself rather than a domain.
 */

import { CSRF_TOKEN, jsonResponse, type RouteArgs } from "./shared.ts";
import type { Route } from "./router.ts";

async function getCsrfToken({ origin }: RouteArgs): Promise<Response> {
  return jsonResponse({ csrf_token: CSRF_TOKEN }, 200, origin);
}

async function getHealth({ ctx, origin }: RouteArgs): Promise<Response> {
  return jsonResponse(
    { status: "ok", tasks: ctx.db.get_all_tasks().length },
    200,
    origin,
  );
}

export const META_ROUTES: Array<Route<RouteArgs>> = [
  { method: "GET", pattern: "/api/csrf-token", handler: getCsrfToken },
  { method: "GET", pattern: "/api/health", handler: getHealth },
];
