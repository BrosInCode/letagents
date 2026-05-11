import assert from "node:assert/strict";
import test from "node:test";

import {
  participantRoleEnum,
  rentalVisibilityEnum,
  messages,
} from "../db/schema.js";

// ===== p1.0 Schema Extensions Tests =====

test("participantRoleEnum includes rental_participant", () => {
  const values = participantRoleEnum.enumValues;
  assert.ok(
    values.includes("rental_participant"),
    `Expected rental_participant in enum values: ${JSON.stringify(values)}`
  );
  // Original values preserved
  assert.ok(values.includes("participant"));
  assert.ok(values.includes("admin"));
});

test("rentalVisibilityEnum has spec-compliant values", () => {
  const values = rentalVisibilityEnum.enumValues;
  const expected = ["rental_visible", "renter_only", "provider_only", "internal"];
  assert.deepEqual(values, expected);
});

test("messages table has visibility column", () => {
  const cols = messages as Record<string, unknown>;
  assert.ok("visibility" in cols, "messages should have visibility column");
});

test("messages table has rental_session_id column", () => {
  const cols = messages as Record<string, unknown>;
  assert.ok("rental_session_id" in cols, "messages should have rental_session_id column");
});

test("existing message inserts unaffected — new columns are nullable", () => {
  // Verify the schema definition does not mark the new columns as notNull
  // This ensures existing insert paths (without visibility/rental_session_id) still work
  const visCol = (messages as any).visibility;
  const rentalCol = (messages as any).rental_session_id;

  assert.ok(visCol, "visibility column should exist on messages table");
  assert.ok(rentalCol, "rental_session_id column should exist on messages table");

  // Drizzle columns expose notNull on the column config — false means nullable
  assert.equal(visCol.notNull, false, "visibility should be nullable");
  assert.equal(rentalCol.notNull, false, "rental_session_id should be nullable");
});
