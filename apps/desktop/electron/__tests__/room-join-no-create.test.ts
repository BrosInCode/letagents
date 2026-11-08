import assert from "node:assert/strict";
import test from "node:test";

// A room link opens a room only if it exists: the join carries `create=false`,
// so a crafted `letagents://in/<new-name>` never makes the person admin of a
// room that did not exist. Other opens (the workspace room on first run) keep
// creating, as before.
async function loadRoomInfo(t: test.TestContext) {
  const calls: Array<{ path: string; method: string }> = [];
  t.mock.module("../main/auth.js", { namedExports: {
    DesktopApiError: class ApiError extends Error { status = 500; payload = null; },
    apiFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method || "GET" });
      return { room_id: path.split("/")[2] ? decodeURIComponent(path.split("/")[2]) : "", code: "" };
    },
  } });
  const subject = await import(new URL(`../main/rooms/room-info.js?${encodeURIComponent(t.name)}`, import.meta.url).href) as typeof import("../main/rooms/room-info.js");
  return { subject, calls };
}

test("a no-create join asks the server not to make the room; a plain join still may", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  await subject.getJoinedRoomInfo("github.com/acme/app", { create: false });
  await subject.getJoinedRoomInfo("alerts-demo");
  await subject.getJoinedRoomInfo("design-lounge", { create: true });
  assert.deepEqual(calls, [
    { path: "/rooms/github.com%2Facme%2Fapp/join?create=false", method: "POST" },
    { path: "/rooms/alerts-demo/join", method: "POST" },
    { path: "/rooms/design-lounge/join", method: "POST" },
  ]);
});

test("a room joined once is remembered for both kinds of open", async (t) => {
  const { subject, calls } = await loadRoomInfo(t);
  await subject.getJoinedRoomInfo("alerts-demo", { create: false });
  await subject.getJoinedRoomInfo("alerts-demo");
  await subject.getJoinedRoomInfo("alerts-demo", { create: false });
  assert.equal(calls.length, 1, "the cache answers the later opens");
});

test("the snapshot for a room a link named but that does not exist here is unavailable, not created", async () => {
  const { createRoomNotFoundSnapshot } = await import("../main/rooms/snapshot/snapshots.js");
  const snapshot = createRoomNotFoundSnapshot("quiet-corner");
  assert.equal(snapshot.roomIdentifier, "quiet-corner");
  assert.equal(snapshot.room, null);
  assert.equal(snapshot.access.status, "unavailable");
  assert.equal(snapshot.access.message, "Room not found");
  assert.equal(snapshot.access.httpStatus, 404);
});
