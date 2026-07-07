import assert from "node:assert/strict";
import test from "node:test";
import {
  collectThreadContextMessages,
  rememberThreadContextMessages,
  resetThreadContextCacheForTests,
} from "../server/tools/messages/wait-tool.js";

// With localRoomId/roomId/projectId all null, a cache miss falls through to the
// remote lookup, which throws "No room is available" before any network I/O —
// so a resolved parent proves a cache hit and a rejection proves a miss.
const NO_STORAGE = { localRoomId: null, roomId: null, projectId: null };

function message(id: string, replyToId?: string): Record<string, unknown> {
  return {
    id,
    sender: "Agent",
    text: `text of ${id}`,
    ...(replyToId ? { reply_to: { id: replyToId } } : {}),
  };
}

test("idle polls skip thread-context resolution entirely", async () => {
  resetThreadContextCacheForTests();

  assert.deepEqual(await collectThreadContextMessages({ messages: [], ...NO_STORAGE }), []);
});

test("a cached parent resolves without touching storage", async () => {
  resetThreadContextCacheForTests();
  rememberThreadContextMessages("", [message("msg_1")]);

  const context = await collectThreadContextMessages({
    messages: [message("msg_2", "msg_1")],
    ...NO_STORAGE,
  });

  assert.deepEqual(context.map((record) => record.id), ["msg_1"]);
});

test("messages observed in one poll resolve parents in later polls", async () => {
  resetThreadContextCacheForTests();

  // Both messages in-window: nothing to fetch, but the window seeds the cache.
  await collectThreadContextMessages({
    messages: [message("msg_1"), message("msg_2", "msg_1")],
    ...NO_STORAGE,
  });

  const context = await collectThreadContextMessages({
    messages: [message("msg_3", "msg_1")],
    ...NO_STORAGE,
  });

  assert.deepEqual(context.map((record) => record.id), ["msg_1"]);
});

test("cache entries are scoped per room", async () => {
  resetThreadContextCacheForTests();
  rememberThreadContextMessages("room_a", [message("msg_1")]);

  await assert.rejects(
    collectThreadContextMessages({ messages: [message("msg_2", "msg_1")], ...NO_STORAGE }),
    /No room is available/,
  );
});

test("cache stays bounded and evicts the oldest entries", async () => {
  resetThreadContextCacheForTests();
  rememberThreadContextMessages("", [message("msg_1")]);
  rememberThreadContextMessages(
    "",
    Array.from({ length: 500 }, (_, index) => message(`filler_${index}`)),
  );

  await assert.rejects(
    collectThreadContextMessages({ messages: [message("msg_2", "msg_1")], ...NO_STORAGE }),
    /No room is available/,
  );
});
