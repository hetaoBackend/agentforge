import { expect, test } from "bun:test";

import { createRequestGenerationGuard, parseApiResponse } from "./apiReliability.ts";

test("parseApiResponse returns JSON from successful responses", async () => {
  const response = new Response(JSON.stringify({ saved: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

  await expect(parseApiResponse(response)).resolves.toEqual({ saved: true });
});

test("parseApiResponse accepts empty 204 and non-JSON success responses", async () => {
  await expect(parseApiResponse(new Response(null, { status: 204 }))).resolves.toBeUndefined();
  await expect(parseApiResponse(new Response("accepted", { status: 202 }))).resolves.toBe(
    "accepted",
  );
});

test("parseApiResponse throws the backend JSON error for non-2xx responses", async () => {
  const response = new Response(JSON.stringify({ error: "Task is already running" }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });

  await expect(parseApiResponse(response)).rejects.toThrow("Task is already running");
});

test("parseApiResponse uses a non-JSON error body and falls back to HTTP status", async () => {
  await expect(
    parseApiResponse(new Response("service unavailable", { status: 503 })),
  ).rejects.toThrow("service unavailable");
  await expect(
    parseApiResponse(new Response(null, { status: 500, statusText: "" })),
  ).rejects.toThrow("HTTP 500");
});

test("request generation guard only accepts the latest request round", () => {
  const guard = createRequestGenerationGuard();
  const first = guard.begin();
  const second = guard.begin();

  expect(guard.isCurrent(first)).toBe(false);
  expect(guard.isCurrent(second)).toBe(true);

  guard.invalidate();
  expect(guard.isCurrent(second)).toBe(false);
});
