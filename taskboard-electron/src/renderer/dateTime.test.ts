import { test, expect } from "bun:test";

import {
  formatDateTimeLocalInput,
  parseTaskDateTime,
  serializeDateTimeLocalInput,
} from "./dateTime.ts";

test("parseTaskDateTime keeps naive timestamps in local wall time", () => {
  const parsed = parseTaskDateTime("2026-03-19T18:04:00");

  expect(parsed.getFullYear()).toBe(2026);
  expect(parsed.getMonth()).toBe(2);
  expect(parsed.getDate()).toBe(19);
  expect(parsed.getHours()).toBe(18);
  expect(parsed.getMinutes()).toBe(4);
});

test("formatDateTimeLocalInput converts aware timestamps into local datetime-local values", () => {
  expect(formatDateTimeLocalInput("2026-03-19T10:04:00+00:00")).toBe("2026-03-19T18:04");
});

test("serializeDateTimeLocalInput preserves local wall time without forcing UTC", () => {
  expect(serializeDateTimeLocalInput("2026-03-19T18:04")).toBe("2026-03-19T18:04:00");
});
