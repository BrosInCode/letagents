import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";

import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import { useDesktopAccountRoomSettings } from "../src/composables/useDesktopAccountRoomSettings";

const settingsEntry: SidebarEntry = {
  id: "system:settings",
  type: "system",
  title: "Settings",
  description: "Settings",
  sectionLabel: "System",
};

function focusRoom(id: string, focusKey = id): RoomEntry {
  return {
    id,
    type: "room",
    kind: "focus",
    roomIdentifier: id,
    title: id,
    meta: "Focus room",
    sectionLabel: "Focus room",
    headline: "Focused work",
    description: "Description",
    focusKey,
    focusStatus: "active",
    parentRoomIdentifier: "parent-room",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
}

function settingsOptions(activeEntry: RoomEntry, refresh: () => Promise<void>) {
  return {
    accountRooms: ref([]),
    activeEntry: ref<SidebarEntry>(activeEntry),
    loading: ref(false),
    recentRootRooms: ref([]),
    recentRootRoomsStorageKey: "test:recent-rooms",
    rootRoomSnapshot: ref(null),
    selectedRootRoomIdentifier: ref(null),
    selectedSnapshot: ref(null),
    settingsAccountRooms: ref([]),
    settingsEntry,
    openRoomSnapshot: () => undefined,
    refresh,
    refreshAccountRooms: refresh,
  };
}

test("batch conclude uses human quick close, refreshes once, and reports partial failures", async (t) => {
  const runtime = globalThis as typeof globalThis & { window?: { letagentsDesktop?: unknown } };
  const previousWindow = runtime.window;
  const calls: unknown[][] = [];
  let refreshCalls = 0;
  runtime.window = {
    letagentsDesktop: {
      room: {
        concludeFocusRoom: async (...args: unknown[]) => {
          calls.push(args);
          if (args[1] === "fail") throw new Error("Focus room is already closed");
          return {};
        },
      },
    },
  };
  t.after(() => {
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  });

  const first = focusRoom("focus-one", "one");
  const second = focusRoom("focus-two", "fail");
  const { batchConcludeSidebarFocusRooms, settingsRoomActionBusyKey } = useDesktopAccountRoomSettings(
    settingsOptions(first, async () => { refreshCalls += 1; }),
  );

  const result = await batchConcludeSidebarFocusRooms([first, second]);

  assert.deepEqual(calls, [
    ["parent-room", "one", "", null, true],
    ["parent-room", "fail", "", null, true],
  ]);
  assert.deepEqual(result, {
    succeededEntryIds: ["focus-one"],
    failures: [{ entryId: "focus-two", message: "Focus room is already closed" }],
    refreshError: null,
  });
  assert.equal(refreshCalls, 1);
  assert.equal(settingsRoomActionBusyKey.value, null);
});

test("batch hide performs all focus mutations before one refresh", async (t) => {
  const runtime = globalThis as typeof globalThis & { window?: { letagentsDesktop?: unknown } };
  const previousWindow = runtime.window;
  const calls: unknown[][] = [];
  let refreshCalls = 0;
  runtime.window = {
    letagentsDesktop: {
      room: {
        archiveFocusRoom: async (...args: unknown[]) => {
          calls.push(args);
          return {};
        },
      },
    },
  };
  t.after(() => {
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  });

  const first = focusRoom("focus-one", "one");
  const second = focusRoom("focus-two", "two");
  const { batchHideSidebarRooms } = useDesktopAccountRoomSettings(
    settingsOptions(first, async () => { refreshCalls += 1; }),
  );

  const result = await batchHideSidebarRooms([first, second]);

  assert.deepEqual(calls, [["parent-room", "one"], ["parent-room", "two"]]);
  assert.deepEqual(result, {
    succeededEntryIds: ["focus-one", "focus-two"],
    failures: [],
    refreshError: null,
  });
  assert.equal(refreshCalls, 1);
});
