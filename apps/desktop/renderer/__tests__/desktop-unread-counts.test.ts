import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, effectScope, nextTick, ref, watch, type Ref } from "vue";

const watchTotals = (total: Readonly<Ref<number>>, seen: number[]) => watch(total, (value) => { seen.push(value); }, { flush: "sync" });
import type { DesktopAuthAccount, DesktopRoomLatestMessage, DesktopRoomMessage } from "../../electron/ipc-types";
import { unreadStorageModeKey, useDesktopUnreadCounts } from "../src/composables/useDesktopUnreadCounts";
import { rememberGitHubEventsVisible } from "../src/components/desktop/content/room-shell/preferences";

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

test("room and app badges exclude hidden GitHub events and react to visibility changes", async () => {
  const originalWindow = globalThis.window;
  const storage = new Map<string, string>();
  const badges: number[] = [];
  const events = [2, 3].map(id => ({ ...message(id), source: "github", sender: "github" }) as DesktopRoomMessage);
  const deferred: { resolve?: (page: { messages: DesktopRoomMessage[]; hasMore: boolean }) => void } = {};
  let delay = false;
  globalThis.window = {
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    letagentsDesktop: {
      room: { getMessagesAfter: async (id: string) => {
        if (id === "room-b") return { messages: [message(2), message(3)], hasMore: false };
        if (delay) return new Promise<{ messages: DesktopRoomMessage[]; hasMore: boolean }>(resolve => { deferred.resolve = resolve; });
        return { messages: events, hasMore: false };
      } },
      notifications: { setBadgeCount: async (count: number) => { badges.push(count); } },
    },
  } as never;
  const scope = effectScope();
  const counts = scope.run(() => useDesktopUnreadCounts({
    account: ref(accountA), rooms: ref([room("room-a", 3), room("room-b", 3)]),
    readMarkers: ref({ "room-a": "msg_1", "room-b": "msg_1" }), storageMode: ref("cloud"),
  }))!;
  try {
    await counts.refresh(); await nextTick();
    assert.deepEqual(counts.roomCounts.value, { "room-a": 0, "room-b": 2 });
    assert.equal(badges.at(-1), 2);
    rememberGitHubEventsVisible("ROOM-A", true);
    await nextTick(); await counts.refresh(); await nextTick();
    assert.deepEqual(counts.roomCounts.value, { "room-a": 2, "room-b": 2 });
    assert.equal(badges.at(-1), 4);
    rememberGitHubEventsVisible("room-a", false);
    await nextTick(); await counts.refresh(); await nextTick();
    assert.deepEqual(counts.roomCounts.value, { "room-a": 0, "room-b": 2 });
    assert.equal(badges.at(-1), 2);

    delay = true;
    rememberGitHubEventsVisible("room-a", true);
    await nextTick();
    const resolve = deferred.resolve;
    assert.ok(resolve, "a recount should be in flight");
    rememberGitHubEventsVisible("room-a", false);
    delay = false;
    resolve({ messages: events, hasMore: false });
    await nextTick(); await counts.refresh(); await nextTick();
    assert.deepEqual(counts.roomCounts.value, { "room-a": 0, "room-b": 2 }, "stale visible results cannot restore hidden events");
    assert.equal(badges.at(-1), 2);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

/** A fake server: read points and counts per room, the reads it was sent, and how often it was asked. */
function fakeServer(rooms: Record<string, { read: number | null; unread: number; github?: number; latest?: number }>) {
  const reports: Array<[string, string, string | null]> = [];
  let gets = 0;
  const storage = new Map<string, string>();
  const window = { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, letagentsDesktop: {
    room: {
      getMessagesAfter: async (_id: string, after: string | null) => {
        const from = (after ? Number(after.slice(4)) : 0) + 1;
        return { messages: [message(from), message(from + 1)], hasMore: true };
      },
      getAccountUnread: async () => {
        gets += 1;
        return { rooms: Object.entries(rooms).map(([roomId, room]) => ({ roomId, readMessageId: room.read ? `msg_${room.read}` : null,
          unreadCount: room.read ? room.unread : null, githubUnreadCount: room.read ? room.github ?? 0 : null })) };
      },
      reportRoomRead: async (id: string, messageId: string, from?: string | null) => {
        reports.push([id, messageId, from ?? null]);
        const room = rooms[id.toLowerCase()];
        if (room) {
          room.read = Number(messageId.slice(4));
          room.unread = room.latest ? Math.max(0, room.latest - room.read) : 0;
        }
      },
    },
    notifications: { setBadgeCount: async () => {} },
  } };
  return { window, reports, gets: () => gets };
}

async function settleDebounce() { await new Promise((resolve) => setTimeout(resolve, 2_100)); await nextTick(); }

test("a fresh install or a new device never marks rooms read for the account: seeded markers stay local", async () => {
  const originalWindow = globalThis.window;
  // Another desktop read room-x up to msg_3; six messages are unread there.
  const fake = fakeServer({ "room-x": { read: 3, unread: 6 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  // This device saw room-x for the first time and baselined it at its latest message.
  const readMarkers = ref<Record<string, string>>({ "room-x": "msg_9" });
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-x", 9)]), readMarkers,
    storageMode: ref("cloud"), confirmedReads: ref({}) }))!;
  try {
    await settleDebounce();
    assert.deepEqual(fake.reports, [], "a baseline is not a read");
    assert.equal(counts.roomCounts.value["room-x"], 6, "the server's read point wins over the baseline");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a room the person was just added to, and a marker kept before this version, are not reported", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "new-room": { read: null, unread: 0 }, "old-room": { read: null, unread: 0 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("new-room", 5), room("old-room", 5)]),
    readMarkers: ref({ "new-room": "msg_5", "old-room": "msg_3" }), storageMode: ref("cloud"), confirmedReads: ref({}) }))!;
  try {
    await settleDebounce(); await counts.refresh(); await nextTick();
    assert.deepEqual(fake.reports, [], "a marker this device cannot prove is never sent; rooms may show unread instead");
    assert.deepEqual(counts.roomCounts.value, { "new-room": 0, "old-room": 2 }, "without a server read point the room is counted here, as before");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("two devices: a read one device saw is reported once, and the other device follows the server", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-b": { read: 2, unread: 7, github: 3 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const confirmedReads = ref<Record<string, string>>({});
  const readRevision = ref(0);
  let lastRead: { roomId: string; lastMessageId: string | null } | null = null;
  const rooms = ref([room("room-b", 9)]);
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms, readMarkers: ref({ "room-b": "msg_9" }),
    storageMode: ref("cloud"), confirmedReads, readRevision: () => readRevision.value, lastRead: () => lastRead }))!;
  try {
    await settleDebounce();
    assert.equal(counts.roomCounts.value["room-b"], 7);
    rememberGitHubEventsVisible("room-b", true);
    await settleDebounce();
    assert.equal(counts.roomCounts.value["room-b"], 10, "GitHub events count where the room shows them");
    rememberGitHubEventsVisible("room-b", false);
    // The person saw msg_6 on screen: reported as the range after the server's read point.
    confirmedReads.value = { "room-b": "msg_6" };
    await settleDebounce();
    assert.deepEqual(fake.reports, [["room-b", "msg_6", "msg_3"]]);
    const asked = fake.gets();
    // The stream echoes this device's own report: no new request.
    lastRead = { roomId: "room-b", lastMessageId: "msg_6" };
    readRevision.value += 1;
    await settleDebounce();
    assert.equal(fake.gets(), asked, "the echo of its own report is not news");
    // Another device reads to the end: its frame makes this device ask again.
    lastRead = { roomId: "room-b", lastMessageId: "msg_9" };
    readRevision.value += 1;
    await settleDebounce();
    assert.equal(fake.gets(), asked + 1);
    // Seen to the latest message here: 0 at once.
    confirmedReads.value = { "room-b": "msg_9" };
    await nextTick();
    assert.equal(counts.roomCounts.value["room-b"], 0);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a burst of streamed messages asks the server once", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-c": { read: 1, unread: 1 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const rooms = ref([room("room-c", 2)]);
  scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms, readMarkers: ref({}), storageMode: ref("cloud"), confirmedReads: ref({}) }));
  try {
    await settleDebounce();
    const before = fake.gets();
    for (let latest = 3; latest <= 12; latest += 1) {
      rooms.value = [room("room-c", latest)];
      await nextTick();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await settleDebounce();
    assert.equal(fake.gets() - before, 1, "ten messages, one request");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a server without account unread keeps counting every room from history", async () => {
  const originalWindow = globalThis.window;
  const historyReads: string[] = [];
  globalThis.window = { letagentsDesktop: {
    room: {
      getMessagesAfter: async (id: string) => { historyReads.push(id); return { messages: [message(2), message(3)], hasMore: false }; },
      getAccountUnread: async () => null,
      reportRoomRead: async () => { throw new Error("must not report to an older server"); },
    },
    notifications: { setBadgeCount: async () => {} },
  } } as never;
  const scope = effectScope();
  const counts = scope.run(() => useDesktopUnreadCounts({
    account: ref(accountA), rooms: ref([room("room-a", 3)]), readMarkers: ref({ "room-a": "msg_1" }), storageMode: ref("cloud"),
  }))!;
  try {
    await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 2);
    assert.deepEqual(historyReads, ["room-a"]);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a room ending in a thread reply clears on both devices once one of them reads to the bottom", async () => {
  const originalWindow = globalThis.window;
  // msg_10 is a thread reply the main list does not show; the person saw msg_9 at the bottom.
  const fake = fakeServer({ "room-t": { read: 5, unread: 5, latest: 10 } });
  globalThis.window = fake.window as never;
  const scopeA = effectScope();
  const scopeB = effectScope();
  const confirmedA = ref<Record<string, string>>({});
  const revisionB = ref(0);
  let lastReadB: { roomId: string; lastMessageId: string | null } | null = null;
  const deviceA = scopeA.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-t", 10)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads: confirmedA }))!;
  const deviceB = scopeB.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-t", 10)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads: ref({}), readRevision: () => revisionB.value, lastRead: () => lastReadB }))!;
  try {
    await settleDebounce();
    assert.equal(deviceA.roomCounts.value["room-t"], 5);
    assert.equal(deviceB.roomCounts.value["room-t"], 5);
    // At the bottom, the proven read is the room's newest message (provenRoomRead), msg_10.
    confirmedA.value = { "room-t": "msg_10" };
    await settleDebounce();
    assert.deepEqual(fake.reports.at(-1), ["room-t", "msg_10", "msg_6"]);
    assert.equal(deviceA.roomCounts.value["room-t"], 0);
    // The other device hears of a read that is not its own.
    lastReadB = { roomId: "room-t", lastMessageId: "msg_10" };
    revisionB.value += 1;
    await settleDebounce();
    assert.equal(deviceB.roomCounts.value["room-t"], 0);
  } finally { scopeA.stop(); scopeB.stop(); globalThis.window = originalWindow; }
});

test("a read part of the way asks the server once for the count that is left", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-p": { read: 10, unread: 20, latest: 30 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const confirmedReads = ref<Record<string, string>>({});
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-p", 30)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads }))!;
  try {
    await settleDebounce();
    assert.equal(counts.roomCounts.value["room-p"], 20);
    confirmedReads.value = { "room-p": "msg_20" };
    await settleDebounce(); await settleDebounce();
    assert.deepEqual(fake.reports, [["room-p", "msg_20", "msg_11"]]);
    assert.equal(counts.roomCounts.value["room-p"], 10, "the badge follows the read");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a marker kept before this version lowers the server's count but is never reported", async () => {
  const originalWindow = globalThis.window;
  // Read here up to msg_8 before the upgrade; on the web only up to msg_2 long ago.
  const fake = fakeServer({ "room-l": { read: 2, unread: 7 }, "room-n": { read: 2, unread: 7 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-l", 9), room("room-n", 9)]),
    // The current marker moved on to msg_9 (the end of the open room) without proof; the saved one is msg_8.
    readMarkers: ref({ "room-l": "msg_9", "room-n": "msg_8" }), storageMode: ref("cloud"), confirmedReads: ref({}),
    legacyReadMarkers: () => ({ "room-l": "msg_8" }) }))!;
  try {
    await settleDebounce(); await counts.refresh(); await nextTick();
    assert.equal(counts.roomCounts.value["room-l"], 1, "the lower of 7 (server) and 1 (from the saved marker, not the current one)");
    assert.equal(counts.roomCounts.value["room-n"], 7, "a marker this version set (a baseline) does not lower anything");
    assert.deepEqual(fake.reports, []);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("an account switch stops a batch of reports; a closing window sends what is still owed", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-1": { read: 1, unread: 4 }, "room-2": { read: 1, unread: 4 }, "room-3": { read: 1, unread: 4 },
    "room-4": { read: 1, unread: 4 }, "room-5": { read: 1, unread: 4 } });
  const listeners = new Map<string, () => void>();
  Object.assign(fake.window, {
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  const report = fake.window.letagentsDesktop.room.reportRoomRead;
  const account = ref<DesktopAuthAccount | null>(accountA);
  fake.window.letagentsDesktop.room.reportRoomRead = async (id: string, messageId: string, from?: string | null) => {
    await report(id, messageId, from);
    // The person switches account while the first batch of four is in flight
    // (the app also forgets the proven reads of the old account).
    account.value = { ...accountA, id: "account-b" };
    confirmedReads.value = {};
  };
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const rooms = ref(["room-1", "room-2", "room-3", "room-4", "room-5"].map((id) => room(id, 5)));
  const confirmedReads = ref<Record<string, string>>({});
  scope.run(() => useDesktopUnreadCounts({ account, rooms, readMarkers: ref({}), storageMode: ref("cloud"), confirmedReads }));
  try {
    await settleDebounce();
    confirmedReads.value = Object.fromEntries(rooms.value.map((r) => [r.roomIdentifier, "msg_5"]));
    await settleDebounce();
    assert.equal(fake.reports.length, 4, "the first batch of four was in flight; the fifth read, of account A, is not sent after the switch");
  } finally { scope.stop(); globalThis.window = originalWindow; }

  // Closing the window: a read seen just now goes out without waiting for the debounce.
  const fake2 = fakeServer({ "room-q": { read: 1, unread: 4 } });
  const listeners2 = new Map<string, () => void>();
  Object.assign(fake2.window, { addEventListener: (name: string, listener: () => void) => listeners2.set(name, listener), removeEventListener: () => {} });
  globalThis.window = fake2.window as never;
  const scope2 = effectScope();
  const confirmed2 = ref<Record<string, string>>({});
  scope2.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-q", 5)]), readMarkers: ref({}), storageMode: ref("cloud"), confirmedReads: confirmed2 }));
  try {
    await settleDebounce();
    confirmed2.value = { "room-q": "msg_5" };
    await nextTick();
    listeners2.get("pagehide")?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(fake2.reports, [["room-q", "msg_5", "msg_2"]]);
  } finally { scope2.stop(); globalThis.window = originalWindow; }
});

test("only the echo of this device's own report is ignored, matched by room and message", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-e": { read: 1, unread: 4 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const confirmedReads = ref<Record<string, string>>({});
  const readRevision = ref(0);
  let lastRead: { roomId: string; lastMessageId: string | null } | null = null;
  scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-e", 9)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads, readRevision: () => readRevision.value, lastRead: () => lastRead }));
  try {
    await settleDebounce();
    confirmedReads.value = { "room-e": "msg_5" };
    await settleDebounce(); await settleDebounce();
    const asked = fake.gets();
    // Another device's read lands first (its report wrote a new range); it is news.
    lastRead = { roomId: "room-e", lastMessageId: "msg_7" };
    readRevision.value += 1;
    await settleDebounce();
    assert.equal(fake.gets(), asked + 1);
    // Then this device's own echo: not news.
    lastRead = { roomId: "ROOM-E", lastMessageId: "msg_5" };
    readRevision.value += 1;
    await settleDebounce();
    assert.equal(fake.gets(), asked + 1);
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a saved marker stops lowering the count once the server's read point reaches it", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-s": { read: 8, unread: 3 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-s", 11)]),
    readMarkers: ref({ "room-s": "msg_11" }), storageMode: ref("cloud"), confirmedReads: ref({}),
    legacyReadMarkers: () => ({ "room-s": "msg_8" }) }))!;
  try {
    await settleDebounce(); await counts.refresh(); await nextTick();
    assert.equal(counts.roomCounts.value["room-s"], 3, "messages after the upgrade are counted by the server alone");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("two room_read frames in one tick: a foreign read behind this device's echo is not lost", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-f": { read: 1, unread: 4 }, "room-g": { read: 1, unread: 4 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const confirmedReads = ref<Record<string, string>>({});
  const readRevision = ref(0);
  let queue: Array<{ roomId: string; lastMessageId: string | null } | null> = [];
  scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-f", 9), room("room-g", 9)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads, readRevision: () => readRevision.value, takeReads: () => queue.splice(0, queue.length) }));
  try {
    await settleDebounce();
    confirmedReads.value = { "room-f": "msg_5" };
    await settleDebounce(); await settleDebounce();
    const asked = fake.gets();
    // A read on another device and this device's echo land together; Vue sees one revision change.
    queue = [{ roomId: "room-g", lastMessageId: "msg_9" }, { roomId: "room-f", lastMessageId: "msg_5" }];
    readRevision.value += 2;
    await settleDebounce();
    assert.equal(fake.gets(), asked + 1, "the foreign read is news");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("the room being read shows no count while a burst arrives, even when the server's count lands first", async () => {
  const originalWindow = globalThis.window;
  const fake = fakeServer({ "room-r": { read: 5, unread: 11 } });
  globalThis.window = fake.window as never;
  const scope = effectScope();
  const reading = ref<string | null>("room-r");
  const counts = scope.run(() => useDesktopUnreadCounts({ account: ref(accountA), rooms: ref([room("room-r", 16)]), readMarkers: ref({}),
    storageMode: ref("cloud"), confirmedReads: ref({}), readingRoom: () => reading.value }))!;
  try {
    await settleDebounce();
    assert.equal(counts.roomCounts.value["room-r"], 0, "open, shown and focused: no badge");
    reading.value = null;
    await nextTick();
    assert.equal(counts.roomCounts.value["room-r"], 11, "left without proof of reading: the server's count");
    assert.deepEqual(fake.reports, [], "showing no badge reports nothing");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});

test("a sidebar that reorders or gains a cloud room keeps every count", async () => {
  const settings = { mode: "cloud" };
  const key = unreadStorageModeKey(settings, [["room-a", "cloud"], ["room-b", "cloud"], ["room-l", "local"]]);
  // The open room moves to the front; a cloud room is added; a cloud room leaves.
  assert.equal(unreadStorageModeKey(settings, [["room-l", "local"], ["room-b", "cloud"], ["room-a", "cloud"]]), key);
  assert.equal(unreadStorageModeKey(settings, [["room-a", "cloud"], ["room-b", "cloud"], ["room-c", "cloud"], ["room-l", "local"]]), key);
  assert.equal(unreadStorageModeKey(settings, [["room-a", "cloud"], ["room-l", "local"]]), key);
  // Where a room's history lives, or the storage settings, changed: the counts start again.
  assert.notEqual(unreadStorageModeKey(settings, [["room-a", "local"], ["room-b", "cloud"], ["room-l", "local"]]), key);
  assert.notEqual(unreadStorageModeKey(settings, [["room-a", "cloud"], ["room-b", "cloud"], ["room-l", "cloud"]]), key);
  assert.notEqual(unreadStorageModeKey({ mode: "local" }, [["room-a", "cloud"], ["room-b", "cloud"], ["room-l", "local"]]), key);

  const originalWindow = globalThis.window;
  let loads = 0;
  globalThis.window = { letagentsDesktop: {
    room: { getMessagesAfter: async () => { loads += 1; return { messages: [message(2), message(3)], hasMore: false }; } },
    notifications: { setBadgeCount: async () => {} },
  } } as never;
  const scope = effectScope();
  const rooms = ref([room("room-a", 3), room("room-b", 3)]);
  const seen: number[] = [];
  const counts = scope.run(() => useDesktopUnreadCounts({
    account: ref(accountA), rooms, readMarkers: ref({ "room-a": "msg_1", "room-b": "msg_1" }),
    // As the sidebar builds it: from the rooms in their current order.
    storageMode: computed(() => unreadStorageModeKey(settings, rooms.value.map((entry) => [entry.roomIdentifier, "cloud"] as const))),
  }))!;
  try {
    await counts.refresh(); await nextTick();
    assert.equal(counts.totalCount.value, 4);
    const loadsBefore = loads;
    const stop = scope.run(() => watchTotals(counts.totalCount, seen))!;
    rooms.value = [room("room-b", 3), room("room-a", 3)];
    await nextTick(); await counts.refresh(); await nextTick();
    stop();
    assert.deepEqual(seen, [], "no count changed while the rooms swapped places");
    assert.equal(counts.totalCount.value, 4);
    assert.equal(loads, loadsBefore, "no room was counted again");
  } finally { scope.stop(); globalThis.window = originalWindow; }
});
