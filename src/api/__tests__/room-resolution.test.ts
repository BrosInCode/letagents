import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  isReservedRoomId,
  resolveCanonicalRoomRequestId,
} = await import("../rooms/resolution.js");
const { isReservedMainRoomCreationId, normalizeRoomName, parseFocusRoomLocator } = await import("../rooms/routing.js");

test("parseFocusRoomLocator extracts parent room and focus key", () => {
  assert.deepEqual(parseFocusRoomLocator("github.com/owner/repo/focus/task_1"), {
    parentRoomId: "github.com/owner/repo",
    focusKey: "task_1",
  });
  assert.deepEqual(parseFocusRoomLocator("parent/focus/review"), {
    parentRoomId: "parent",
    focusKey: "review",
  });
});

test("parseFocusRoomLocator rejects non-focus and nested focus locators", () => {
  assert.equal(parseFocusRoomLocator("focus_5"), null);
  assert.equal(parseFocusRoomLocator("/focus/key"), null);
  assert.equal(parseFocusRoomLocator("parent/focus/child/extra"), null);
});

test("GitHub focus locators normalize repository casing without corrupting opaque focus keys", () => {
  assert.equal(
    normalizeRoomName("github.com/BrosInCode/LetAgents/FOCUS/git:branch:RmVhdHVyZS9DYXBz"),
    "github.com/brosincode/letagents/focus/git:branch:RmVhdHVyZS9DYXBz"
  );
});

test("isReservedRoomId only matches generated focus ids", () => {
  assert.equal(isReservedRoomId("focus_5"), true);
  assert.equal(isReservedRoomId("focus_123"), true);
  assert.equal(isReservedRoomId("focus_0"), true);
  assert.equal(isReservedRoomId("focus_alpha"), false);
  assert.equal(isReservedRoomId("github.com/owner/repo"), false);
});

test("main room creation reserves focus locators and the retired Git focus namespace", () => {
  assert.equal(isReservedMainRoomCreationId("focus_00"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/owner/repo/focus/git:branch:bWFpbg"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/private/repo/focus/git:branch:Zm9v/bar"), true);
  assert.equal(isReservedMainRoomCreationId("named/focus/not-a-valid-locator/either"), true);
  assert.equal(isReservedMainRoomCreationId("git-room:github.com:owner/repo:branch:bWFpbg"), true);
  assert.equal(isReservedMainRoomCreationId("github.com/owner/repo"), false);
});

test("resolveCanonicalRoomRequestId preserves invite codes without DB lookup", async () => {
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291"), "ABCX-7291");
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291-L2QP"), "ABCX-7291-L2QP");
});
