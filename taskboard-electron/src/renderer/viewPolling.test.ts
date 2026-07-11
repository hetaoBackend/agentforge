import { describe, expect, test } from "bun:test";
import { fetchMainViewData, type MainView } from "./viewPolling.ts";

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchMainViewData", () => {
  test.each([
    ["tasks", ["/tasks?mode=summary"]],
    ["heartbeats", ["/heartbeats"]],
    ["skills", ["/skill-patterns", "/skills", "/tasks?mode=summary"]],
  ] as Array<[MainView, string[]]>)(
    "fetches only data needed by the %s view",
    async (view, expectedPaths) => {
      const requested: string[] = [];
      const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
        const url = new URL(String(input));
        requested.push(`${url.pathname}${url.search}`.replace("/api", ""));
        if (url.pathname.endsWith("/skills")) return response({ skills: [{ id: 1 }] });
        if (url.pathname.endsWith("/skill-patterns")) return response({ patterns: [] });
        return response([]);
      };

      await fetchMainViewData(view, "http://localhost/api", fetchImpl);

      expect(requested.sort()).toEqual(expectedPaths.sort());
    },
  );

  test("returns partial data without empty placeholders for unrequested views", async () => {
    const data = await fetchMainViewData("heartbeats", "http://localhost/api", async () =>
      response([{ id: 7 }]),
    );

    expect(data).toEqual({ heartbeats: [{ id: 7 }] });
    expect("tasks" in data).toBe(false);
    expect("skills" in data).toBe(false);
  });
});
