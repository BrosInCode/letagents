import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoomActivitySourceFlags,
  deriveRoomAgentActivityState,
  isReachableRoomAgentActivityState,
} from "../room-agent-activity.js";

test("deriveRoomAgentActivityState separates active and away for reachable agents", () => {
  assert.equal(
    deriveRoomAgentActivityState({
      hidden: false,
      hasPresence: true,
      freshness: "active",
      status: "working",
    }),
    "active"
  );
  assert.equal(
    deriveRoomAgentActivityState({
      hidden: false,
      hasPresence: true,
      freshness: "active",
      status: "idle",
    }),
    "away"
  );
});

test("deriveRoomAgentActivityState keeps hidden agents as offline live-state entries", () => {
  assert.equal(
    deriveRoomAgentActivityState({
      hidden: false,
      hasPresence: true,
      freshness: "stale",
      status: "working",
    }),
    "offline"
  );
  assert.equal(
    deriveRoomAgentActivityState({
      hidden: false,
      hasPresence: false,
      freshness: null,
      status: null,
    }),
    "offline"
  );
  assert.equal(
    deriveRoomAgentActivityState({
      hidden: true,
      hasPresence: false,
      freshness: null,
      status: null,
    }),
    "offline"
  );
});

test("buildRoomActivitySourceFlags is ordered and deduplicated", () => {
  assert.deepEqual(
    buildRoomActivitySourceFlags(["tasks", "presence", "tasks", "messages"]),
    ["presence", "messages", "tasks"]
  );
});

test("isReachableRoomAgentActivityState only accepts active and away agents", () => {
  assert.equal(isReachableRoomAgentActivityState("active"), true);
  assert.equal(isReachableRoomAgentActivityState("away"), true);
  assert.equal(isReachableRoomAgentActivityState("offline"), false);
});
