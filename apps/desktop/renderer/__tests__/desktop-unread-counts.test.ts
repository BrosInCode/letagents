import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type { DesktopAuthAccount, DesktopRoomLatestMessage, DesktopRoomMessage } from "../../electron/ipc-types";
import { useDesktopUnreadCounts } from "../src/composables/useDesktopUnreadCounts";

const accountA = { id: "account-a", login: "Emmy", displayName: null } as DesktopAuthAccount;
const room = (id: string, latest: number): DesktopRoomLatestMessage => ({ roomIdentifier: id, latestMessageId: `msg_${latest}`, latestMessageAt: null });
const message = (id: number) => ({ id: `msg_${id}`, sender: "Agent", source: "agent", text: "Reply" }) as DesktopRoomMessage;

test("badges deduplicate rooms, clear on read/sign-out and ignore stale account results", async () => {
  const originalWindow = globalThis.window;
  const badges: number[] = [];
  let load = async (_room: string, _after: string | null) => ({ messages: [message(2), message(3)], hasMore: false });
  globalThis.window = { letagentsDesktop: {
    room: { getMessagesAfter: (id: string, after: string | null) => load(id, after) },
    notifications: { setBadgeCount: async (count: number) => { badges.push(count); } },
  } } as never;
  const scope = effectScope();
  const account = ref<DesktopAuthAccount | null>(accountA);
  const rooms = ref([room("room-a", 3), room("ROOM-A", 3), room("room-b", 3)]);
  const readMarkers = ref<Record<string, string>>({ "room-a": "msg_1", "room-b": "msg_1" });
  const counts = scope.run(() => useDesktopUnreadCounts({ account, rooms, readMarkers, storageMode: ref("cloud") }))!;
  try {
    await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 4);
    assert.equal(badges.at(-1), 4);
    readMarkers.value = { ...readMarkers.value, "room-a": "msg_3" };
    await nextTick(); await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 2);
    rooms.value = [room("room-a", 3)];
    await nextTick(); await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 0, "hidden/archived rooms leave the total");
    let resolve!: (page: { messages: DesktopRoomMessage[]; hasMore: boolean }) => void;
    load = () => new Promise((done) => { resolve = done; });
    rooms.value = [room("room-a", 5)];
    await nextTick();
    account.value = null;
    await nextTick();
    resolve({ messages: [message(4), message(5)], hasMore: false });
    await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 0);
    assert.equal(badges.at(-1), 0);
    load = async () => ({ messages: [message(5)], hasMore: false });
    account.value = { ...accountA, id: "account-b" };
    readMarkers.value = { "room-a": "msg_4" };
    await nextTick(); await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 1, "old account results cannot populate the new account");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("history failures retain the last badge count and retry without a message change", async () => {
  const originalWindow = globalThis.window;
  let fail = false;
  globalThis.window = { letagentsDesktop: {
    room: { getMessagesAfter: async (_room: string, after: string | null) => {
      if (fail) throw new Error("offline");
      return { messages: [message(after === "msg_1" ? 2 : 3)], hasMore: false };
    } }, notifications: { setBadgeCount: async () => {} },
  } } as never;
  const scope = effectScope();
  const rooms = ref([room("room-a", 2)]);
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms, readMarkers: ref({ "room-a": "msg_1" }), storageMode: ref("cloud") }))!;
  try {
    await counts.refresh(); assert.equal(counts.totalCount.value, 1);
    fail = true; rooms.value = [room("room-a", 3)];
    await nextTick(); await counts.refresh(); assert.equal(counts.totalCount.value, 1);
    fail = false; await counts.refresh(); assert.equal(counts.totalCount.value, 2);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("changing storage history resets counts and follows new local message IDs", async () => {
  const originalWindow = globalThis.window;
  const cursors: Array<string | null> = [];
  globalThis.window = { letagentsDesktop: {
    room: { getMessagesAfter: async (_room: string, after: string | null) => {
      cursors.push(after);
      return { messages: [message(Number(after!.slice(4)) + 1)], hasMore: false };
    } }, notifications: { setBadgeCount: async () => {} },
  } } as never;
  const scope = effectScope();
  const rooms = ref([room("room-a", 100)]);
  const readMarkers = ref({ "room-a": "msg_99" });
  const storageMode = ref("cloud");
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms, readMarkers, storageMode }))!;
  try {
    await counts.refresh(); assert.equal(counts.totalCount.value, 1);
    storageMode.value = "local"; readMarkers.value = { "room-a": "msg_5" }; rooms.value = [room("room-a", 6)];
    await nextTick(); await counts.refresh(); assert.equal(counts.totalCount.value, 1);
    rooms.value = [room("room-a", 7)];
    await nextTick(); await counts.refresh(); assert.equal(counts.totalCount.value, 2);
    assert.deepEqual(cursors, ["msg_99", "msg_5", "msg_6"]);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});
