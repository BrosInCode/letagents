import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldSkipPollTick } from "../src/domain/visibility-polling";

describe("shouldSkipPollTick", () => {
  it("runs the tick when the window is visible and nothing is in flight", () => {
    assert.equal(shouldSkipPollTick({ hidden: false }), false);
    assert.equal(shouldSkipPollTick({ hidden: false, inFlight: false }), false);
  });

  it("skips the tick while the window is hidden", () => {
    assert.equal(shouldSkipPollTick({ hidden: true }), true);
    assert.equal(shouldSkipPollTick({ hidden: true, inFlight: false }), true);
  });

  it("skips overlapping refreshes while a previous tick is still in flight", () => {
    // Mirrors the agent-detail modal guard: a slow supervisor call must not
    // stack a second refresh on the next 4s tick.
    assert.equal(shouldSkipPollTick({ hidden: false, inFlight: true }), true);
  });
});
