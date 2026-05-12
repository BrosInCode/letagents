/**
 * Unit tests for the role-based visibility decision logic (p2.10a).
 *
 * Pure-decision coverage only — DB integration is exercised by the
 * existing rental-activity-events / rental-room-projection test
 * suites. This file deliberately avoids importing the DB module so
 * it stays fast and DB-less.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  clampActivityLimit,
  visibleVisibilitiesFor,
} from "../rental/session-activity-decisions.js";

test("renter sees renter_only + rental_visible (not provider_only or internal)", () => {
  const v = visibleVisibilitiesFor("renter");
  assert.deepEqual([...v].sort(), ["rental_visible", "renter_only"].sort());
  assert.ok(!v.includes("provider_only" as never));
  assert.ok(!v.includes("internal" as never));
});

test("provider sees provider_only + rental_visible (not renter_only or internal)", () => {
  const v = visibleVisibilitiesFor("provider");
  assert.deepEqual([...v].sort(), ["provider_only", "rental_visible"].sort());
  assert.ok(!v.includes("renter_only" as never));
  assert.ok(!v.includes("internal" as never));
});

test("both roles share rental_visible (the default verified-event visibility)", () => {
  const renter = visibleVisibilitiesFor("renter");
  const provider = visibleVisibilitiesFor("provider");
  assert.ok(renter.includes("rental_visible"));
  assert.ok(provider.includes("rental_visible"));
});

test("renter and provider visibilities don't leak across roles", () => {
  const renter = visibleVisibilitiesFor("renter");
  const provider = visibleVisibilitiesFor("provider");
  assert.ok(!renter.includes("provider_only"));
  assert.ok(!provider.includes("renter_only"));
});

test("'internal' is never returned to UI for either role", () => {
  const renter = visibleVisibilitiesFor("renter");
  const provider = visibleVisibilitiesFor("provider");
  assert.ok(!renter.includes("internal" as never));
  assert.ok(!provider.includes("internal" as never));
});

test("clampActivityLimit defaults missing / invalid values to 200", () => {
  assert.equal(clampActivityLimit(undefined), 200);
  assert.equal(clampActivityLimit(null), 200);
  assert.equal(clampActivityLimit(NaN), 200);
  assert.equal(clampActivityLimit("not a number"), 200);
  assert.equal(clampActivityLimit(0), 200);
  assert.equal(clampActivityLimit(-50), 200);
});

test("clampActivityLimit caps to 1000 and floors decimals", () => {
  assert.equal(clampActivityLimit(1), 1);
  assert.equal(clampActivityLimit(42.7), 42);
  assert.equal(clampActivityLimit(1000), 1000);
  assert.equal(clampActivityLimit(1_000_000), 1000);
});

test("clampActivityLimit accepts numeric strings (URLSearchParams output)", () => {
  assert.equal(clampActivityLimit("50"), 50);
  assert.equal(clampActivityLimit("9999"), 1000);
});
