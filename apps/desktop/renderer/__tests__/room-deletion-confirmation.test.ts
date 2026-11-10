import assert from "node:assert/strict";
import test from "node:test";
import { ref } from "vue";
import type { DesktopRoomSnapshot } from "../../electron/ipc-types.js";
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

test("deleting a sidebar child removes its row and returns an open child to its parent", async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  globalThis.window = { letagentsDesktop: { room: { deleteAccountRoom: async () => {} } } } as never;
  globalThis.localStorage = { setItem() {} } as never;
  try {
    for (const selectedRoom of ["parent-room", "focus-room"]) {
      const rootRoomSnapshot = ref({
        roomIdentifier: "parent-room",
        focusRooms: [{ identifier: "focus-room" }, { identifier: "keep-room" }],
      } as DesktopRoomSnapshot);
      const selectedSnapshot = ref({
        roomIdentifier: selectedRoom,
        focusRooms: selectedRoom === "parent-room" ? rootRoomSnapshot.value.focusRooms : [],
        messages: [{ id: "new-live-message" }],
        tasks: [{ id: "new-live-task" }],
      } as DesktopRoomSnapshot);
      const opened: string[] = [];
      const notices: string[] = [];
      const state = useDesktopAccountRoomSettings({
        accountRooms: ref([]), settingsAccountRooms: ref([]), activeEntry: ref({} as never), loading: ref(false),
        recentRootRooms: ref([]), recentRootRoomsStorageKey: "test-delete-room", rootRoomSnapshot,
        selectedRootRoomIdentifier: ref("parent-room"), selectedSnapshot, settingsEntry: {} as never,
        openRoomSnapshot: (snapshot) => { opened.push(snapshot.roomIdentifier!); },
        refresh: async () => {}, refreshAccountRooms: async () => {},
        notify: (message) => notices.push(message),
      });
      state.deleteAccountRoom({ roomIdentifier: "focus-room", displayName: "Focus room" });
      await state.confirmRoomDeletion("focus-room");
      assert.deepEqual(rootRoomSnapshot.value.focusRooms.map((room) => room.identifier), ["keep-room"]);
      assert.deepEqual(opened, selectedRoom === "focus-room" ? ["parent-room"] : []);
      if (selectedRoom === "parent-room") assert.deepEqual(selectedSnapshot.value.focusRooms, rootRoomSnapshot.value.focusRooms);
      assert.equal(selectedSnapshot.value.messages[0]?.id, "new-live-message");
      assert.equal(selectedSnapshot.value.tasks[0]?.id, "new-live-task");
      assert.deepEqual(notices, ["Deleted Focus room."]);
    }
  } finally { globalThis.window = previousWindow; globalThis.localStorage = previousStorage; }
});
