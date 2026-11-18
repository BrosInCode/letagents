import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-invite-room-",
  paths: ["chatStorage", "localChatDb", "localProfile"],
});

mock.module("../main/auth.js", {
  namedExports: {
    DesktopApiError: class extends Error {},
    apiFetch: async (path: string, options: RequestInit) => {
      assert.equal(path, "/projects");
      assert.equal(options.method, "POST");
      assert.equal(options.body, '{"organization_id":"42"}');
      return { id: "room_q4", code: "ROOM-Q4AB" };
    },
  },
});
mock.module("../main/rooms/snapshot.js", {
  namedExports: {
    fetchRoomSnapshot: async (identifier: string) => {
      const { resolveLocalAwareRoomStorageMode } = await import("../main/rooms/local-store.js");
      const storage = await resolveLocalAwareRoomStorageMode(identifier);
      assert.equal(storage.defaultMode, "local");
      assert.equal(storage.effectiveMode, "cloud");
      return { roomIdentifier: identifier, storage };
    },
  },
});

test("a newly created company room opens in cloud storage even when local is the default", async () => {
  const { setChatStorageMode } = await import("../main/chat-storage/settings.js");
  const { createDesktopInviteRoom } = await import("../main/rooms/invite-room.js");
  await setChatStorageMode("local");
  const result = await createDesktopInviteRoom({ organizationId: "42" });
  assert.equal(result.roomIdentifier, "room_q4");
  assert.equal(result.snapshot.roomIdentifier, "room_q4");
  assert.equal(result.code, "ROOM-Q4AB");
});
