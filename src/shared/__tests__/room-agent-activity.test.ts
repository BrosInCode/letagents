import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoomActivitySourceFlags,
  deriveRoomAgentActivityState,
  isReachableRoomAgentActivityState,
} from "../room-agent-activity.js";

test("deriveRoomAgentActivityState keeps live presence authoritative", () => {
  assert.equal(
    deriveRoomAgentActivityState({ hidden: false, hasPresence: true, freshness: "active" }),
    "online"
  );
  assert.equal(
    deriveRoomAgentActivityState({ hidden: true, hasPresence: true, freshness: "active" }),
    "online"
  );
});

test("deriveRoomAgentActivityState separates stale, historical, and archived", () => {
  assert.equal(
    deriveRoomAgentActivityState({ hidden: false, hasPresence: true, freshness: "stale" }),
    "stale"
  );
  assert.equal(
    deriveRoomAgentActivityState({ hidden: false, hasPresence: false, freshness: null }),
    "historical"
  );
  assert.equal(
    deriveRoomAgentActivityState({ hidden: true, hasPresence: false, freshness: null }),
    "archived"
  );
});

test("buildRoomActivitySourceFlags is ordered and deduplicated", () => {
  assert.deepEqual(
    buildRoomActivitySourceFlags(["tasks", "presence", "tasks", "messages"]),
    ["presence", "messages", "tasks"]
  );
});

test("isReachableRoomAgentActivityState only accepts online agents", () => {
  assert.equal(isReachableRoomAgentActivityState("online"), true);
  assert.equal(isReachableRoomAgentActivityState("stale"), false);
  assert.equal(isReachableRoomAgentActivityState("historical"), false);
  assert.equal(isReachableRoomAgentActivityState("archived"), false);
});
