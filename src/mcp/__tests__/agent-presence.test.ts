import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPresenceStatusText,
  deriveTaskPresenceStatus,
  getRoomIdentityPresenceCacheKey,
} from "../agent-presence.js";

test("classifyPresenceStatusText recognizes idle states", () => {
  assert.equal(classifyPresenceStatusText("online and polling the room"), "idle");
  assert.equal(classifyPresenceStatusText("available for review"), "idle");
});

test("classifyPresenceStatusText recognizes review and blocked states before generic work", () => {
  assert.equal(classifyPresenceStatusText("reviewing PR #146"), "reviewing");
  assert.equal(classifyPresenceStatusText("blocked on CI"), "blocked");
});

test("classifyPresenceStatusText falls back to working for implementation-like updates", () => {
  assert.equal(classifyPresenceStatusText("implementing task_58"), "working");
  assert.equal(classifyPresenceStatusText("", "idle"), "idle");
});

test("deriveTaskPresenceStatus maps task workflow states to presence states", () => {
  assert.equal(deriveTaskPresenceStatus("in_progress"), "working");
  assert.equal(deriveTaskPresenceStatus("in_review"), "reviewing");
  assert.equal(deriveTaskPresenceStatus("blocked"), "blocked");
  assert.equal(deriveTaskPresenceStatus("done"), "idle");
});

test("getRoomIdentityPresenceCacheKey isolates identities within a room", () => {
  assert.equal(
    getRoomIdentityPresenceCacheKey("room_1", "MapleRidge | EmmyMay's agent | Agent"),
    getRoomIdentityPresenceCacheKey("room_1", "MapleRidge | EmmyMay's agent | Agent")
  );
  assert.notEqual(
    getRoomIdentityPresenceCacheKey("room_1", "MapleRidge | EmmyMay's agent | Agent"),
    getRoomIdentityPresenceCacheKey("room_1", "MapleRidge | Reviewer | Agent")
  );
  assert.notEqual(
    getRoomIdentityPresenceCacheKey("room_1", "MapleRidge | EmmyMay's agent | Agent"),
    getRoomIdentityPresenceCacheKey("room_2", "MapleRidge | EmmyMay's agent | Agent")
  );
});
