import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, ref } from "vue";
import { useAccountActivity } from "../src/composables/useAccountActivity";

test("every room_read since the last look is kept in order, and a missed one is an unknown read", () => {
  const originalWindow = globalThis.window;
  let push!: (state: unknown) => void;
  globalThis.window = { letagentsDesktop: { room: {
    onAccountActivity: (callback: (state: unknown) => void) => { push = callback; return () => {}; },
  } } } as never;
  const scope = effectScope();
  const activity = scope.run(() => useAccountActivity({ authenticated: ref(false), roomIds: ref([]) }))!;
  try {
    const state = (readRevision: number, roomId: string, lastMessageId: string) => ({ connected: true, rooms: {}, readRevision, lastRead: { roomId, lastMessageId } });
    push(state(1, "room-a", "msg_3"));
    push(state(2, "room-b", "msg_9"));
    assert.equal(activity.readRevision.value, 2);
    assert.deepEqual(activity.takeReads(), [{ roomId: "room-a", lastMessageId: "msg_3" }, { roomId: "room-b", lastMessageId: "msg_9" }]);
    assert.deepEqual(activity.takeReads(), []);
    push(state(4, "room-c", "msg_1"));
    assert.deepEqual(activity.takeReads(), [null, { roomId: "room-c", lastMessageId: "msg_1" }]);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});
