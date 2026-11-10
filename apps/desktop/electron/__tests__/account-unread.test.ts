import assert from "node:assert/strict";
import { mock, test } from "node:test";

class DesktopApiError extends Error { constructor(readonly status: number) { super(`API ${status}`); } }
const calls: Array<{ path: string; init?: RequestInit }> = [];
let answer: () => unknown = () => ({});
mock.module("../main/auth.js", { namedExports: {
  DesktopApiError,
  apiFetch: async (path: string, init?: RequestInit) => { calls.push({ path, init }); return answer(); },
} });
mock.module("../main/rooms/local-store.js", { namedExports: {
  resolveLocalAwareRoomStorageMode: async (room: string) => ({ effectiveMode: room.startsWith("local") ? "local" : "cloud" }),
  cloudRoomIdentifierForStorage: (_storage: unknown, room: string) => room,
} });
const { getDesktopAccountUnread, reportDesktopRoomRead } = await import("../main/rooms/account-unread.js");

test("account unread is read in one request and malformed rooms are dropped", async () => {
  calls.length = 0;
  answer = () => ({ rooms: [
    { room_id: "github.com/org/repo", read_message_id: "msg_4", unread_count: 3, github_unread_count: 1 },
    { room_id: "invite-room", read_message_id: null, unread_count: null, github_unread_count: null },
    { nope: true },
  ] });
  assert.deepEqual(await getDesktopAccountUnread(), { rooms: [
    { roomId: "github.com/org/repo", readMessageId: "msg_4", unreadCount: 3, githubUnreadCount: 1 },
    { roomId: "invite-room", readMessageId: null, unreadCount: null, githubUnreadCount: null },
  ] });
  assert.deepEqual(calls.map((call) => call.path), ["/account/unread"]);
});

test("a server without the route answers null; other failures are thrown", async () => {
  answer = () => { throw new DesktopApiError(404); };
  assert.equal(await getDesktopAccountUnread(), null);
  answer = () => { throw new DesktopApiError(500); };
  await assert.rejects(getDesktopAccountUnread(), /500/);
});

test("a read is reported as a timeline range, for cloud rooms only", async () => {
  calls.length = 0;
  answer = () => ({ success: true });
  await reportDesktopRoomRead("github.com/org/repo", "msg_7");
  await reportDesktopRoomRead("local-room", "msg_7");
  await reportDesktopRoomRead("github.com/org/repo", "__none__");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, "/rooms/github.com%2Forg%2Frepo/messages/read");
  assert.equal(calls[0]!.init?.method, "PUT");
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.ranges.length, 1);
  assert.deepEqual({ ...body.ranges[0], client_batch_id: undefined }, {
    scope_kind: "timeline", first_message_id: "msg_7", last_message_id: "msg_7", client_batch_id: undefined,
  });
  assert.match(body.ranges[0].client_batch_id, /^desktop-/);
  await reportDesktopRoomRead("room-b", "msg_9", "msg_5");
  await reportDesktopRoomRead("room-b", "msg_9", "msg_12");
  const ranges = calls.slice(1).map((call) => JSON.parse(String(call.init?.body)).ranges[0]);
  assert.deepEqual(ranges.map((range) => [range.first_message_id, range.last_message_id]), [["msg_5", "msg_9"], ["msg_9", "msg_9"]],
    "a range never starts after its end");
});
