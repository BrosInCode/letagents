import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUATION_REPAIR_EXHAUSTED_ERROR,
  continuationRepairExhaustionNeedsPersistence,
  continuationRepairMissingContinuation,
} from "../continuation-repair-policy.js";

test("continuation repair preserves the original missing continuation until commit", () => {
  assert.equal(continuationRepairMissingContinuation(null, "inbox-1", "current"), "current");
  assert.equal(continuationRepairMissingContinuation({
    inbox_item_id: "inbox-1",
    phase: "prepared",
    missing_continuation: "original",
  }, "inbox-1", "current"), "original");
  assert.equal(continuationRepairMissingContinuation({
    inbox_item_id: "inbox-1",
    phase: "committed",
    missing_continuation: "original",
  }, "inbox-1", "current"), "current");
});

test("continuation repair exhaustion is persisted exactly once", () => {
  assert.equal(continuationRepairExhaustionNeedsPersistence(null), true);
  assert.equal(continuationRepairExhaustionNeedsPersistence("another failure"), true);
  assert.equal(continuationRepairExhaustionNeedsPersistence(CONTINUATION_REPAIR_EXHAUSTED_ERROR), false);
});
