import assert from "node:assert/strict";
import { test } from "node:test";
import { ref } from "vue";

import type { RoomEntry, SidebarEntry } from "../src/components/desktop/types";
import { useDesktopAccountRoomSettings } from "../src/composables/useDesktopAccountRoomSettings";

function roomEntry(): RoomEntry {
  return {
    id: "room:focus:focus_1",
    type: "room",
    kind: "focus",
    roomIdentifier: "focus_1",
    title: "Focus work",
    meta: "Focus room",
    sectionLabel: "Focus room",
    headline: "Focused work",
    description: "Description",
    focusKey: "task_1",
    focusStatus: "active",
    parentRoomIdentifier: "room_1",
    latestMessageId: null,
    latestMessageAt: null,
    hasUnread: false,
    pinned: false,
    source: "account",
  };
}

const settingsEntry: SidebarEntry = {
  id: "system:settings",
  type: "system",
  title: "Settings",
  description: "Settings",
  sectionLabel: "System",
};

test("a successful conclusion stays successful when the following refresh fails", async (t) => {
  const runtime = globalThis as typeof globalThis & {
    window?: { letagentsDesktop?: unknown };
  };
  const previousWindow = runtime.window;
  let mutationCalls = 0;
  runtime.window = {
    letagentsDesktop: {
      room: {
        concludeFocusRoom: async () => {
          mutationCalls += 1;
          return {};
        },
      },
    },
  };
  t.after(() => {
    if (previousWindow) runtime.window = previousWindow;
    else delete runtime.window;
  });

  const entry = roomEntry();
  const { concludeSidebarFocusRoom, settingsRoomActionBusyKey } = useDesktopAccountRoomSettings({
    accountRooms: ref([]),
    activeEntry: ref<SidebarEntry>(entry),
    loading: ref(false),
    recentRootRooms: ref([]),
    recentRootRoomsStorageKey: "test:recent-rooms",
    rootRoomSnapshot: ref(null),
    selectedRootRoomIdentifier: ref(null),
    selectedSnapshot: ref(null),
    settingsAccountRooms: ref([]),
    settingsEntry,
    openRoomSnapshot: () => undefined,
    refresh: async () => {
      throw new Error("refresh failed");
    },
    refreshAccountRooms: async () => undefined,
  });

  const result = await concludeSidebarFocusRoom(entry, {
    summary: "Done",
    details: null,
  });

  assert.deepEqual(result, { ok: true, refreshError: "refresh failed" });
  assert.equal(mutationCalls, 1);
  assert.equal(settingsRoomActionBusyKey.value, null);
});
