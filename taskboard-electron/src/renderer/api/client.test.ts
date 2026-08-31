import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  API,
  createTask,
  deleteTask,
  fetchTasks,
  fetchWithTimeout,
  respondToTask,
  updateSettings,
} from "./client.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let calls: Call[];
const realFetch = globalThis.fetch;

/** Records every request and replies with `body` as JSON. */
function stubFetch(reply: (url: string) => { status?: number; body?: unknown } = () => ({})) {
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? init.body : null,
    });
    const { status = 200, body = {} } = reply(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("read endpoints", () => {
  test("fetchTasks reads the task collection", async () => {
    stubFetch(() => ({ body: [{ id: 1 }] }));

    await expect(fetchTasks()).resolves.toEqual([{ id: 1 }]);
    expect(calls[0]?.url).toBe(`${API}/tasks`);
    expect(calls[0]?.method).toBe("GET");
  });

  test("fetchTasks surfaces a non-2xx status as an error", async () => {
    stubFetch(() => ({ status: 503 }));

    await expect(fetchTasks()).rejects.toThrow("HTTP 503");
  });
});

describe("CSRF handling", () => {
  test("every mutation carries one shared token and a JSON content type", async () => {
    // The token promise is cached in module scope and cannot be reset from a
    // test, so the assertions below are written to hold whether or not this
    // is the first mutating call in the process: the endpoint is hit at most
    // once, and every mutation reuses the same token.
    stubFetch((url) =>
      url.endsWith("/csrf-token") ? { body: { csrf_token: "tok-123" } } : { body: {} },
    );

    await createTask({ title: "new" });
    await updateSettings({ default_agent: "codex" });
    await deleteTask(4);

    const tokenFetches = calls.filter((c) => c.url.endsWith("/csrf-token"));
    expect(tokenFetches.length).toBeLessThanOrEqual(1);

    const mutations = calls.filter((c) => !c.url.endsWith("/csrf-token"));
    expect(mutations.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/tasks`,
      `PUT ${API}/settings`,
      `DELETE ${API}/tasks/4`,
    ]);

    const tokens = new Set(mutations.map((c) => c.headers["X-CSRF-Token"]));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toBeTruthy();

    const post = mutations[0]!;
    expect(post.headers["Content-Type"]).toBe("application/json");
    expect(post.body).toBe(JSON.stringify({ title: "new" }));
  });
});

describe("URL construction", () => {
  test("per-task endpoints interpolate the id into the path", async () => {
    stubFetch();

    await respondToTask(7, "yes");

    expect(calls[0]?.url).toBe(`${API}/tasks/7/respond`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(JSON.stringify({ answer: "yes" }));
  });
});

describe("fetchWithTimeout", () => {
  test("returns the response when it arrives in time", async () => {
    stubFetch(() => ({ body: { ok: true } }));

    const res = await fetchWithTimeout(`${API}/health`, 1000);

    expect(res.ok).toBe(true);
  });

  test("aborts a request that outlives the timeout", async () => {
    globalThis.fetch = ((_input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      })) as typeof fetch;

    await expect(fetchWithTimeout(`${API}/health`, 10)).rejects.toThrow(/abort/i);
  });
});
