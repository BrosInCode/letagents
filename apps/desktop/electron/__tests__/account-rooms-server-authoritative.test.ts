import assert from "node:assert/strict";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

createElectronTestEnv({
  prefix: "letagents-account-rooms-",
  paths: ["state", "localChatDb"],
});

const {
  createLocalRoom,
  linkLocalRoomToCloud,
  setLocalRoomPinned,
  getLocalRoomIncludingArchived,
} = await import("../main/rooms/local-store.js");
const { listDesktopAccountRooms, updateDesktopAccountRoom } = await import(
  "../main/rooms/account-rooms.js"
);

type RecordedFetch = { url: string; method: string; body: unknown };

/**
 * Replace globalThis.fetch with a recorder that answers the account-room
 * endpoints apiFetch talks to. Returns the recorded calls plus a restore hook.
 */
function installFetchRecorder(handler: {
  rooms?: Record<string, unknown>[];
  patchResponse?: (roomId: string, body: Record<string, unknown>) => Record<string, unknown>;
}): { calls: RecordedFetch[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: RecordedFetch[] = [];
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body });
    const jsonResponse = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.includes("/account/rooms")) {
      if (method === "GET") {
        return jsonResponse({ rooms: handler.rooms ?? [] });
      }
      if (method === "PATCH") {
        const match = url.match(/\/account\/rooms\/([^/?]+)/);
        const roomId = match ? decodeURIComponent(match[1]) : "";
        const payload = handler.patchResponse
          ? handler.patchResponse(roomId, body ?? {})
          : { room_id: roomId, ...(body ?? {}) };
        return jsonResponse(payload);
      }
    }
    return jsonResponse({ error: `unexpected ${method} ${url}` }, 500);
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub;
  return {
    calls,
    restore: () => {
      if (globalThis.fetch === stub) globalThis.fetch = previous;
    },
  };
}

function cloudRoomPayload(
  roomIdentifier: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    room_id: roomIdentifier,
    display_name: roomIdentifier,
    name: roomIdentifier,
    role: "admin",
    pinned: false,
    archived: false,
    ...overrides,
  };
}

test("archiving a cloud-linked local room PATCHes the server (no early return)", async () => {
  const local = await createLocalRoom({ displayName: "Linked room" });
  await linkLocalRoomToCloud({
    roomIdentifier: local.roomIdentifier,
    cloudRoomIdentifier: "room_cloud_linked",
  });

  const recorder = installFetchRecorder({
    patchResponse: (roomId) => ({ room_id: roomId, archived: true }),
  });
  try {
    const result = await updateDesktopAccountRoom("room_cloud_linked", {
      archived: true,
    });
    const patchCalls = recorder.calls.filter((call) => call.method === "PATCH");
    assert.equal(patchCalls.length, 1, "the server PATCH must run for linked rooms");
    assert.match(patchCalls[0].url, /\/account\/rooms\/room_cloud_linked/);
    assert.deepEqual(patchCalls[0].body, { archived: true });
    assert.equal(result.archived, true);
  } finally {
    recorder.restore();
  }
});

test("updating a linked room by its LOCAL id PATCHes the cloud id", async () => {
  const local = await createLocalRoom({ displayName: "Linked room (local id)" });
  await linkLocalRoomToCloud({
    roomIdentifier: local.roomIdentifier,
    cloudRoomIdentifier: "room_cloud_linked_by_local_id",
  });

  const recorder = installFetchRecorder({
    patchResponse: (roomId) => ({ room_id: roomId, pinned: true }),
  });
  try {
    await updateDesktopAccountRoom(local.roomIdentifier, { pinned: true });
    const patchCalls = recorder.calls.filter((call) => call.method === "PATCH");
    assert.equal(patchCalls.length, 1);
    assert.match(
      patchCalls[0].url,
      /\/account\/rooms\/room_cloud_linked_by_local_id/,
      "the PATCH must target the cloud id the server knows",
    );
    assert.ok(
      !patchCalls[0].url.includes(encodeURIComponent(local.roomIdentifier)),
      "the PATCH must not target the local room id",
    );
  } finally {
    recorder.restore();
  }
});

test("cloud entries show server flags even when a local record disagrees", async () => {
  const local = await createLocalRoom({ displayName: "Overlay room" });
  await linkLocalRoomToCloud({
    roomIdentifier: local.roomIdentifier,
    cloudRoomIdentifier: "room_cloud_overlay",
  });
  // Local record disagrees with the server: locally pinned, server says not.
  await setLocalRoomPinned(local.roomIdentifier, true);

  const recorder = installFetchRecorder({
    rooms: [cloudRoomPayload("room_cloud_overlay", { pinned: false })],
  });
  try {
    const rooms = await listDesktopAccountRooms({ includeArchived: false });
    const entry = rooms.find((room) => room.roomIdentifier === "room_cloud_overlay");
    assert.ok(entry, "cloud room should be listed");
    assert.equal(entry.pinned, false, "server flag wins over the stale local mirror");
    // The linked local mirror must not appear as a separate duplicate entry.
    assert.equal(
      rooms.filter((room) => room.roomIdentifier === "room_cloud_overlay").length,
      1,
    );
  } finally {
    recorder.restore();
  }
});

test("pure local-only room pin/archive stays local with no HTTP", async () => {
  const local = await createLocalRoom({ displayName: "Local only" });

  const recorder = installFetchRecorder({});
  try {
    const pinnedResult = await updateDesktopAccountRoom(local.roomIdentifier, {
      pinned: true,
    });
    assert.equal(pinnedResult.pinned, true);
    const archivedResult = await updateDesktopAccountRoom(local.roomIdentifier, {
      archived: true,
    });
    assert.equal(archivedResult.archived, true);
    assert.equal(
      recorder.calls.length,
      0,
      "local-only rooms have no server copy, so no HTTP should be issued",
    );
    const stored = await getLocalRoomIncludingArchived(local.roomIdentifier);
    assert.ok(stored, "local room should still exist");
  } finally {
    recorder.restore();
  }
});

test("listDesktopAccountRooms({includeArchived:false}) issues exactly one HTTP fetch", async () => {
  const recorder = installFetchRecorder({
    rooms: [cloudRoomPayload("room_cloud_single")],
  });
  try {
    await listDesktopAccountRooms({ includeArchived: false });
    const accountRoomFetches = recorder.calls.filter(
      (call) => call.method === "GET" && call.url.includes("/account/rooms"),
    );
    assert.equal(
      accountRoomFetches.length,
      1,
      "the visible list must fetch /account/rooms exactly once",
    );
    assert.match(accountRoomFetches[0].url, /include_archived=false/);
  } finally {
    recorder.restore();
  }
});
