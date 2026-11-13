import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopRoomMessage } from "../../electron/ipc-types";
import { createSharedRoomMessagePages, SHARED_ROOM_MESSAGE_PAGE_MS } from "../src/domain/shared-room-message-pages";

// A new message makes the unread counter and the notification check ask for
// the same page of the same room. One read must serve both, but never with an
// answer that is older than the message a caller already knows of.

const message = (id: number) => ({ id: `msg_${id}`, sender: "Agent", source: "agent", text: "Reply" }) as DesktopRoomMessage;
const page = (...ids: number[]) => ({ messages: ids.map(message), hasMore: false });

function setup() {
  let time = 1_000;
  const calls: string[] = [];
  let answer = async (_room: string, _after: string | null) => page(2, 3);
  const pages = createSharedRoomMessagePages(() => time);
  const load = (reader: string, roomIdentifier: string, after: string | null, latest: string | null, accountId = "a") => pages.load({
    accountId, reader, roomIdentifier, afterMessageId: after, latestMessageId: latest,
    loadPage: (room, cursor) => { calls.push(`${room}:${cursor}`); return answer(room, cursor); },
  });
  return { calls, load, advance: (ms: number) => { time += ms; }, answerWith: (next: typeof answer) => { answer = next; } };
}

test("the two readers share one read when they ask at the same moment", async () => {
  const { calls, load } = setup();
  const [first, second] = await Promise.all([load("notifications", "Room-1", "msg_1", "msg_3"), load("unread", "room-1", "msg_1", "msg_3")]);
  assert.deepEqual(calls, ["Room-1:msg_1"]);
  assert.equal(first, second);
});

test("a finished read answers the other reader for a moment, then is read again", async () => {
  const { advance, calls, load } = setup();
  await load("notifications", "room-1", "msg_1", "msg_3");
  advance(SHARED_ROOM_MESSAGE_PAGE_MS);
  await load("unread", "room-1", "msg_1", "msg_3");
  assert.equal(calls.length, 1);
  await load("notifications", "room-2", "msg_1", "msg_3");
  advance(SHARED_ROOM_MESSAGE_PAGE_MS + 1);
  await load("unread", "room-2", "msg_1", "msg_3");
  assert.equal(calls.length, 3);
});

test("a reader that asks again always reads again", async () => {
  const { calls, load } = setup();
  await load("unread", "room-1", "msg_1", "msg_3");
  await load("unread", "room-1", "msg_1", "msg_3");
  assert.equal(calls.length, 2);
  // The other reader takes the newest read once; its own second ask reads.
  await load("notifications", "room-1", "msg_1", "msg_3");
  assert.equal(calls.length, 2);
  await load("notifications", "room-1", "msg_1", "msg_3");
  assert.equal(calls.length, 3);
});

test("an answer that stops before the caller's newest message is not shared", async () => {
  const { answerWith, calls, load } = setup();
  const early = load("notifications", "room-1", "msg_1", "msg_3");
  // A later message arrived while the first read was in flight.
  answerWith(async () => page(2, 3, 4));
  const late = load("unread", "room-1", "msg_1", "msg_4");
  assert.deepEqual((await early).messages.map((entry) => entry.id), ["msg_2", "msg_3"]);
  assert.deepEqual((await late).messages.map((entry) => entry.id), ["msg_2", "msg_3", "msg_4"]);
  assert.equal(calls.length, 2);
  // A caller that does not know the newest message always reads.
  await load("third", "room-1", "msg_1", null);
  assert.equal(calls.length, 3);
});

test("other cursors, rooms and accounts read on their own; a failed read is not kept", async () => {
  const { answerWith, calls, load } = setup();
  await load("notifications", "room-1", "msg_1", "msg_3");
  await Promise.all([load("unread", "room-1", "msg_2", "msg_3"), load("unread", "room-2", "msg_1", "msg_3"), load("unread", "room-1", "msg_1", "msg_3", "b")]);
  assert.equal(calls.length, 4);
  answerWith(async () => { throw new Error("offline"); });
  await assert.rejects(load("notifications", "room-9", "msg_1", "msg_3"));
  answerWith(async () => page(2, 3));
  assert.equal((await load("unread", "room-9", "msg_1", "msg_3")).messages.length, 2);
  assert.equal(calls.length, 6);
});
