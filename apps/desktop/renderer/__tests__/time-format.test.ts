import assert from "node:assert/strict";
import test from "node:test";

import { formatFullTimestamp, formatShortDateTime } from "../src/domain/time";

test("formatShortDateTime returns null for empty or unparseable input", () => {
  assert.equal(formatShortDateTime(null), null);
  assert.equal(formatShortDateTime(undefined), null);
  assert.equal(formatShortDateTime(""), null);
  assert.equal(formatShortDateTime("not a date"), null);
});

test("formatShortDateTime formats a valid timestamp with the requested hour style", () => {
  const twoDigit = formatShortDateTime("2026-07-10T09:05:00Z");
  assert.equal(typeof twoDigit, "string");
  assert.ok(twoDigit && twoDigit.length > 0);

  const numeric = formatShortDateTime("2026-07-10T09:05:00Z", { hourStyle: "numeric" });
  assert.equal(typeof numeric, "string");
  assert.ok(numeric && numeric.includes("05"));
});

test("formatFullTimestamp falls back to a dash or the raw value", () => {
  assert.equal(formatFullTimestamp(null), "—");
  assert.equal(formatFullTimestamp(""), "—");
  assert.equal(formatFullTimestamp("not a date"), "not a date");
});

test("formatFullTimestamp formats valid timestamps via toLocaleString", () => {
  const value = "2026-07-10T09:05:00Z";
  assert.equal(formatFullTimestamp(value), new Date(value).toLocaleString());
});
