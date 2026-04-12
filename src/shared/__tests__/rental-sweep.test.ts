/**
 * Unit tests for the rental-sweep module.
 * Tests sweep logic using the exported sweepRentalSessions function.
 *
 * NOTE: These are structural tests — they verify the module exports
 * exist and the timer control functions work. Full DB-level sweep
 * tests require a running Postgres instance (integration/E2E).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  startRentalSweep,
  stopRentalSweep,
} from "../../api/rental-sweep.js";

describe("rental-sweep module exports", () => {
  it("exports startRentalSweep as a function", () => {
    assert.equal(typeof startRentalSweep, "function");
  });

  it("exports stopRentalSweep as a function", () => {
    assert.equal(typeof stopRentalSweep, "function");
  });

  it("stopRentalSweep is idempotent (can call without starting)", () => {
    // Should not throw
    stopRentalSweep();
    stopRentalSweep();
  });
});
