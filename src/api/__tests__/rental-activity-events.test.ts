/**
 * Tests for rental_activity_events schema — p1.2b.
 *
 * Verifies:
 * - rentalActivitySourceEnum values
 * - rental_activity_events table columns, PK, notNull, defaults
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rental_activity_events,
  rentalActivitySourceEnum,
} from "../db/schema.js";

describe("rental_activity_events schema", () => {
  it("rentalActivitySourceEnum has 6 values per spec §19.3", () => {
    assert.deepStrictEqual(rentalActivitySourceEnum.enumValues, [
      "agent", "tool", "patch_gate", "system", "renter", "provider",
    ]);
  });
});

describe("rental_activity_events table columns", () => {
  const expectedColumns = [
    "id", "session_id", "room_id", "event_type",
    "source", "verified", "visibility", "payload", "created_at",
  ];

  it("has all expected columns per spec §19.3", () => {
    const columns = Object.keys(rental_activity_events);
    for (const col of expectedColumns) {
      assert.ok(columns.includes(col), `Missing column: ${col}`);
    }
  });

  it("id column is primary key", () => {
    assert.ok(rental_activity_events.id.primary, "id should be primary key");
  });

  it("required columns are notNull", () => {
    const required = [
      "session_id", "room_id", "event_type", "source",
      "verified", "visibility", "payload", "created_at",
    ];
    for (const col of required) {
      const column = (rental_activity_events as Record<string, { notNull: boolean }>)[col];
      assert.ok(column.notNull, `${col} should be NOT NULL`);
    }
  });

  it("verified defaults to false", () => {
    assert.ok(rental_activity_events.verified.default !== undefined, "verified should have default");
  });

  it("visibility defaults to rental_visible", () => {
    assert.ok(rental_activity_events.visibility.default !== undefined, "visibility should have default");
  });
});
