import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDateTimeLocalInput,
  parseTaskDateTime,
  serializeDateTimeLocalInput,
} from "./dateTime.mjs";

test("parseTaskDateTime keeps naive timestamps in local wall time", () => {
  const parsed = parseTaskDateTime("2026-03-19T18:04:00");

  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 2);
  assert.equal(parsed.getDate(), 19);
  assert.equal(parsed.getHours(), 18);
  assert.equal(parsed.getMinutes(), 4);
});

test("formatDateTimeLocalInput converts aware timestamps into local datetime-local values", () => {
  assert.equal(
    formatDateTimeLocalInput("2026-03-19T10:04:00+00:00"),
    "2026-03-19T18:04",
  );
});

test("serializeDateTimeLocalInput preserves local wall time without forcing UTC", () => {
  assert.equal(
    serializeDateTimeLocalInput("2026-03-19T18:04"),
    "2026-03-19T18:04:00",
  );
});
