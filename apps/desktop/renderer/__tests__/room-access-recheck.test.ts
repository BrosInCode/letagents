import assert from "node:assert/strict";
import { test } from "node:test";

import { ROOM_ACCESS_RECHECK_MIN_GAP_MS, shouldRecheckAfterStreamRefusal } from "../src/domain/room-access-recheck";

const base = {
  refusedRoom: "design-room",
  openRooms: ["design-room", "design-room"],
  status: "ready" as const,
  loading: false,
  lastRecheckAt: 0,
  now: 1_000_000,
};

test("a refused stream in a room shown as open checks the room once", () => {
  assert.equal(shouldRecheckAfterStreamRefusal(base), true);
  // The app may know the room by its canonical name only.
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, refusedRoom: "Design-Room", openRooms: [null, "design-room"] }), true);
});

test("a check in progress never starts another check", () => {
  // Every check opens the room's stream before its snapshot, so its own
  // refusal arrives while it runs. Answering it would loop without end.
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, loading: true }), false);
});

test("a room already on the join card, or another room, is left alone", () => {
  for (const status of ["membership_required", "repo_collaborator_required", "forbidden", "unavailable", "auth_required"] as const) {
    assert.equal(shouldRecheckAfterStreamRefusal({ ...base, status }), false, status);
  }
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, openRooms: ["other-room", null] }), false);
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, refusedRoom: "" }), false);
});

test("refusals that repeat within the gap do not reload the room again", () => {
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, lastRecheckAt: base.now - ROOM_ACCESS_RECHECK_MIN_GAP_MS + 1 }), false);
  assert.equal(shouldRecheckAfterStreamRefusal({ ...base, lastRecheckAt: base.now - ROOM_ACCESS_RECHECK_MIN_GAP_MS }), true);
});
