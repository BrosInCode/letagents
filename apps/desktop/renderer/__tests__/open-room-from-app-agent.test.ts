import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";

import type { DesktopRoomSnapshot } from "../../electron/ipc-types";
import type { ProjectGroup, RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import { useAppArchivedRooms } from "../src/composables/app/useAppArchivedRooms";

// A notification click, a room link and an Inbox item all open a room by its
// identifier. A focus room the sidebar lists under its parent must open in
// place; opened as a room of its own it got a second, top-level row.

function entry(kind: RoomEntry["kind"], roomIdentifier: string): RoomEntry {
  return {
    id: `room:${kind}:${roomIdentifier}`, type: "room", kind, roomIdentifier, title: roomIdentifier, meta: "", sectionLabel: "",
    headline: "", description: "", latestMessageId: null, latestMessageAt: null, hasUnread: false, pinned: false, source: "account",
  };
}
const snapshot = (roomIdentifier: string, room: Record<string, unknown> = {}) =>
  ({ roomIdentifier, room: { identifier: roomIdentifier, kind: "main", parentRoomId: null, ...room }, access: {} }) as unknown as DesktopRoomSnapshot;

function setup(input: { root?: DesktopRoomSnapshot | null; snapshots?: Record<string, DesktopRoomSnapshot>; listedAfterRefresh?: RoomEntry } = {}) {
  const parent = entry("parent", "design-lounge");
  const projectEntries = ref<ProjectGroup[]>([
    { id: "project:design", roomName: "Design", parent, branchRooms: [], focusRooms: [entry("focus", "focus_30")] },
    { id: "project:other", roomName: "Other", parent: entry("parent", "other-room"), branchRooms: [], focusRooms: [] },
  ]);
  const calls: string[] = [];
  const originalWindow = globalThis.window;
  globalThis.window = { letagentsDesktop: { room: {
    getSnapshot: async (identifier: string) => { calls.push(`snapshot:${identifier}`); return input.snapshots?.[identifier] ?? snapshot(identifier); },
  } } } as never;
  const app = {
    accountRooms: ref([]), settingsAccountRooms: ref([]), attentionIntent: ref(null), loading: ref(false),
    notificationRevealMessageId: ref(null), recentRootRooms: ref([]), recentRootRoomsStorageKey: "recent",
    rootRoomSnapshot: ref(input.root === undefined ? snapshot("other-room") : input.root),
    selectedRootRoomIdentifier: ref(null), selectedSnapshot: ref(null),
    activeEntry: ref<SidebarEntry>(entry("parent", "other-room")), projectEntries,
    selectSidebarEntry: (next: SidebarEntry) => { calls.push(`select:${next.id}`); app.activeEntry.value = next; },
    refreshSelectedSnapshot: async () => { calls.push("load-selected"); },
    refreshAccountRooms: async () => {
      calls.push("list");
      if (input.listedAfterRefresh) projectEntries.value[0]!.focusRooms.push(input.listedAfterRefresh);
    },
    openRoomSnapshot: (opened: DesktopRoomSnapshot) => { calls.push(`open-root:${opened.roomIdentifier}`); },
    clearSelectedSnapshotCache() {}, pushActionToast() {},
  };
  const rooms = useAppArchivedRooms(app);
  return { app, calls, rooms, restore: () => { globalThis.window = originalWindow; } };
}

test("a listed focus room opens in place, without a second root room", async () => {
  const { app, calls, rooms, restore } = setup();
  try {
    await rooms.openRoomFromAppAgent("FOCUS_30");
    assert.deepEqual(calls, ["select:room:focus:focus_30", "load-selected"]);
    assert.equal(app.activeEntry.value.id, "room:focus:focus_30");
    assert.equal(app.loading.value, false);
  } finally { restore(); }
});

test("a top-level room still opens as the root room", async () => {
  const { calls, rooms, restore } = setup();
  try {
    await rooms.openRoomFromAppAgent("design-lounge", { create: false });
    assert.deepEqual(calls, ["snapshot:design-lounge", "open-root:design-lounge"]);
  } finally { restore(); }
});

test("a focus room the sidebar does not list yet is looked up once, then opens in place", async () => {
  const fresh = snapshot("focus_31", { kind: "focus", parentRoomId: "design-lounge" });
  const { calls, rooms, restore } = setup({ snapshots: { focus_31: fresh }, listedAfterRefresh: entry("focus", "focus_31") });
  try {
    await rooms.openRoomFromAppAgent("focus_31");
    assert.deepEqual(calls, ["snapshot:focus_31", "list", "select:room:focus:focus_31", "load-selected"]);
  } finally { restore(); }
});

test("a focus room that stays unlisted, or an app with no open room, keeps the old path", async () => {
  const fresh = snapshot("focus_32", { kind: "focus", parentRoomId: "design-lounge" });
  const unlisted = setup({ snapshots: { focus_32: fresh } });
  try {
    await unlisted.rooms.openRoomFromAppAgent("focus_32");
    assert.deepEqual(unlisted.calls, ["snapshot:focus_32", "list", "open-root:focus_32"]);
  } finally { unlisted.restore(); }
  const cold = setup({ root: null });
  try {
    await cold.rooms.openRoomFromAppAgent("focus_30");
    assert.deepEqual(cold.calls, ["snapshot:focus_30", "open-root:focus_30"]);
  } finally { cold.restore(); }
});
