import assert from "node:assert/strict";
import test from "node:test";

test("the attach-files picker is a sheet on the main window", async (t) => {
  const pickerCalls: unknown[][] = [];
  let parentWindow: { isDestroyed(): boolean } | null = { isDestroyed: () => false };
  t.mock.module("electron", { defaultExport: { dialog: { showOpenDialog: async (...args: unknown[]) => {
    pickerCalls.push(args);
    return { canceled: true, filePaths: [] };
  } } } });
  t.mock.module("../main/window.js", { namedExports: {
    focusMainWindow() {},
    getMainWindow: () => parentWindow,
  } });
  t.mock.module("../main/auth.js", { namedExports: {
    apiFetch: async () => { throw new Error("A cancelled picker must not upload"); },
    readStoredAuth: async () => null,
  } });
  t.mock.module("../main/chat-storage/settings.js", { namedExports: { localFilesPath: () => "/unused" } });
  t.mock.module("../main/rooms/local-store.js", { namedExports: {
    resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
    cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
    localRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
  } });

  const { pickAndStageDesktopAttachments } = await import("../main/attachments.js");

  assert.deepEqual(await pickAndStageDesktopAttachments("room_1"), []);
  assert.equal(pickerCalls[0]?.length, 2);
  assert.strictEqual(pickerCalls[0]?.[0], parentWindow);
  assert.deepEqual((pickerCalls[0]?.[1] as { properties: string[] }).properties, ["openFile", "multiSelections"]);

  // A destroyed main window is not a parent: the picker opens detached.
  parentWindow = { isDestroyed: () => true };
  assert.deepEqual(await pickAndStageDesktopAttachments("room_1"), []);
  assert.equal(pickerCalls[1]?.length, 1);

  // Without any main window the picker still opens, detached.
  parentWindow = null;
  assert.deepEqual(await pickAndStageDesktopAttachments("room_1"), []);
  assert.equal(pickerCalls[2]?.length, 1);
});
