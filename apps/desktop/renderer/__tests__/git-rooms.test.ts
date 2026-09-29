import assert from "node:assert/strict";
import { test } from "node:test";

import { friendlyRoomLabel } from "../src/domain/git-rooms";

test("friendlyRoomLabel decodes contextual branch locators to repo · branch", () => {
  assert.equal(
    friendlyRoomLabel("github.com/brosincode/letagents/focus/git:branch:c3RhZ2luZw"),
    "letagents · staging"
  );
});

test("friendlyRoomLabel decodes base64url refs with url-safe characters", () => {
  // "codex/premium-sidebar-ui" exercises the _ and - substitutions.
  const encoded = Buffer.from("codex/premium-sidebar-ui", "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  assert.equal(
    friendlyRoomLabel(`github.com/brosincode/letagents/focus/git:branch:${encoded}`),
    "letagents · codex/premium-sidebar-ui"
  );
});

test("friendlyRoomLabel passes friendly names through untouched", () => {
  assert.equal(friendlyRoomLabel("sky-lake"), "sky-lake");
  assert.equal(friendlyRoomLabel("github.com/BrosInCode/letagents"), "github.com/BrosInCode/letagents");
});

test("friendlyRoomLabel leaves identifiers with undecodable refs untouched", () => {
  assert.equal(
    friendlyRoomLabel("github.com/brosincode/letagents/focus/git:branch:!!!!"),
    "github.com/brosincode/letagents/focus/git:branch:!!!!"
  );
});
