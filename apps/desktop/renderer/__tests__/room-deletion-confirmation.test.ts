import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import { useDesktopAccountRoomSettings } from "../src/composables/useDesktopAccountRoomSettings.js";

test("room deletion requires the exact confirmation and cancelling does not invoke IPC", async () => {
  const calls: unknown[] = [];
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = { letagentsDesktop: { room: { deleteAccountRoom: async (...args: unknown[]) => { calls.push(args); } } } } as never;
  globalThis.localStorage = { setItem() {} } as never;
  try {
    const state = useDesktopAccountRoomSettings({
      accountRooms: ref([]), settingsAccountRooms: ref([]), activeEntry: ref({} as never), loading: ref(false),
      recentRootRooms: ref([]), recentRootRoomsStorageKey: "test-delete-room", rootRoomSnapshot: ref(null), selectedRootRoomIdentifier: ref(null), selectedSnapshot: ref(null), settingsEntry: {} as never,
      openRoomSnapshot() {}, refresh: async () => {}, refreshAccountRooms: async () => {},
    });
    const target = { roomIdentifier: "test-room", displayName: "Test room" };
    state.deleteAccountRoom(target);
    assert.equal(state.pendingRoomDeletion.value?.roomIdentifier, "test-room");
    await state.confirmRoomDeletion("wrong");
    assert.equal(calls.length, 0);
    state.pendingRoomDeletion.value = null;
    await state.confirmRoomDeletion("test-room");
    assert.equal(calls.length, 0);
    state.deleteAccountRoom(target);
    await state.confirmRoomDeletion("test-room");
    assert.deepEqual(calls, [["test-room", "test-room"]]);
    assert.equal(state.pendingRoomDeletion.value, null);
  } finally { globalThis.window = previousWindow; globalThis.localStorage = previousStorage; }
});
