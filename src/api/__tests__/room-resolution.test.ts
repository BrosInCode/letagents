import assert from "node:assert/strict";
import test from "node:test";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";

const {
  isReservedRoomId,
  parseFocusRoomLocator,
  resolveCanonicalRoomRequestId,
} = await import("../room-resolution.js");

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

test("isReservedRoomId only matches generated focus ids", () => {
  assert.equal(isReservedRoomId("focus_5"), true);
  assert.equal(isReservedRoomId("focus_123"), true);
  assert.equal(isReservedRoomId("focus_alpha"), false);
  assert.equal(isReservedRoomId("github.com/owner/repo"), false);
});

test("resolveCanonicalRoomRequestId preserves invite codes without DB lookup", async () => {
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291"), "ABCX-7291");
  assert.equal(await resolveCanonicalRoomRequestId("ABCX-7291-L2QP"), "ABCX-7291-L2QP");
});
