import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopRoomMessage } from "../../electron/ipc-types";
import { createSharedRoomMessagePages } from "../src/domain/shared-room-message-pages";

// A new message makes the unread counter and the notification check ask for
// the same page of the same room. One read must serve both, but never with an
// answer that is older than the message a caller already knows of.

const message = (id: number) => ({ id: `msg_${id}`, sender: "Agent", source: "agent", text: "Reply" }) as DesktopRoomMessage;
const page = (...ids: number[]) => ({ messages: ids.map(message), hasMore: false });

function setup() {
  const calls: string[] = [];
  let answer = async (_room: string, _after: string | null) => page(2, 3);
  const pages = createSharedRoomMessagePages();
  const load = (accountId: string, roomIdentifier: string, after: string | null, latest: string | null) => pages.load({
    accountId, roomIdentifier, afterMessageId: after, latestMessageId: latest,
    loadPage: (room, cursor) => { calls.push(`${room}:${cursor}`); return answer(room, cursor); },
  });
  return { calls, load, answerWith: (next: typeof answer) => { answer = next; } };
}

test("two callers at the same moment share one read", async () => {
  const { calls, load } = setup();
  const [first, second] = await Promise.all([load("a", "Room-1", "msg_1", "msg_3"), load("a", "room-1", "msg_1", "msg_3")]);
  assert.deepEqual(calls, ["Room-1:msg_1"]);
  assert.equal(first, second);
});

test("a finished read is not kept: the next caller reads again", async () => {
  const { calls, load } = setup();
  await load("a", "room-1", "msg_1", "msg_3");
  await load("a", "room-1", "msg_1", "msg_3");
  assert.equal(calls.length, 2);
});

test("an answer that stops before the caller's newest message is not shared", async () => {
  const { answerWith, calls, load } = setup();
  const early = load("a", "room-1", "msg_1", "msg_3");
  // A later message arrived while the first read was in flight.
  answerWith(async () => page(2, 3, 4));
  const late = load("a", "room-1", "msg_1", "msg_4");
  assert.deepEqual((await early).messages.map((entry) => entry.id), ["msg_2", "msg_3"]);
  assert.deepEqual((await late).messages.map((entry) => entry.id), ["msg_2", "msg_3", "msg_4"]);
  assert.equal(calls.length, 2);
  // A caller that does not know the newest message always reads.
  await load("a", "room-1", "msg_1", null);
  assert.equal(calls.length, 3);
});

test("other cursors, rooms and accounts read on their own; a failed read is not kept", async () => {
  const { answerWith, calls, load } = setup();
  await Promise.all([
    load("a", "room-1", "msg_1", "msg_3"), load("a", "room-1", "msg_2", "msg_3"),
    load("a", "room-2", "msg_1", "msg_3"), load("b", "room-1", "msg_1", "msg_3"),
  ]);
  assert.equal(calls.length, 4);
  answerWith(async () => { throw new Error("offline"); });
  await assert.rejects(load("a", "room-9", "msg_1", "msg_3"));
  answerWith(async () => page(2, 3));
  assert.deepEqual((await load("a", "room-9", "msg_1", "msg_3")).messages.length, 2);
  assert.equal(calls.length, 6);
});
