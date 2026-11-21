import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";
import type { DesktopRoomStreamEvent } from "../ipc-types.js";

// While a room is open the app repeats its join when the remembered answer
// ends (five minutes). The join tells the server that the person still has the
// room open, and it is the only place a new room name, role or focus state
// comes from. Until 2026-11 a full room reload every 15 seconds did this by
// accident (the stream's keep-alive comment was read as a damaged frame).

const env = createElectronTestEnv({ prefix: "room-stream-open-join-",
  paths: ["state", "chatStorage", "localChatDb", "localProfile"] });
env.resetState({});

// Read once when room-stream.js is evaluated, so set them before the import.
const FIRST_CHECK_MS = 40;
const RETRY_MS = 60;
process.env.LETAGENTS_OPEN_ROOM_JOIN_FIRST_CHECK_MS = String(FIRST_CHECK_MS);
process.env.LETAGENTS_OPEN_ROOM_JOIN_RETRY_MS = String(RETRY_MS);
test.after(() => {
  delete process.env.LETAGENTS_OPEN_ROOM_JOIN_FIRST_CHECK_MS;
  delete process.env.LETAGENTS_OPEN_ROOM_JOIN_RETRY_MS;
});

const emitted: DesktopRoomStreamEvent[] = [];
mock.module("../main/window.js", {
  namedExports: {
    emitToMainWindow: (channel: string, payload: unknown) => {
      if (channel === "desktop:room:stream-event") emitted.push(payload as DesktopRoomStreamEvent);
    },
    getMainWindow: () => null,
    hasOpenWindows: () => false,
    focusMainWindow: () => {},
    createWindow: () => {},
  },
});

const {
  startDesktopRoomStream,
  stopDesktopRoomStream,
  acknowledgeDesktopRoomStreamGapRepair,
} = await import("../main/room-stream.js");
const roomInfo = await import("../main/rooms/room-info.js");
const localStore = await import("../main/rooms/local-store.js");

const realNow = Date.now.bind(Date);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = realNow();
  while (!predicate()) {
    if (realNow() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(5);
  }
}

type JoinAnswer = { status?: number; body?: unknown } | "no answer";

/**
 * The room server as this suite needs it: a stream that sends its handshake
 * and then stays open, and a join route whose answers the test queues.
 */
function installServer(room: string) {
  const previousFetch = globalThis.fetch;
  const joins: string[] = [];
  const others: string[] = [];
  const answers: JoinAnswer[] = [];
  const encoder = new TextEncoder();
  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const signal = (init?.signal ?? null) as AbortSignal | null;
    if (url.includes("/messages/stream")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          controller.enqueue(encoder.encode(
            `event: room_sync\ndata: ${JSON.stringify({ room_id: room, checkpoint: null, gap: false, event_cursor: null })}\n\n`,
          ));
          signal?.addEventListener("abort", () => {
            try { controller.error(new DOMException("Aborted", "AbortError")); } catch { /* already closed */ }
          });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (/\/rooms\/[^/]+\/join/.test(url)) {
      joins.push(`${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`);
      const answer = answers.shift() ?? "no answer";
      if (answer === "no answer") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status ?? 200, headers: { "Content-Type": "application/json" },
      });
    }
    others.push(new URL(url).pathname);
    return new Response(JSON.stringify({ room_id: room, messages: [] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = routed;
  return {
    joins,
    /** Every request that is neither the stream nor a join. */
    others,
    answer: (next: JoinAnswer) => { answers.push(next); },
    restore: () => { if (globalThis.fetch === routed) globalThis.fetch = previousFetch; },
  };
}

function repairRequests(): Array<Extract<DesktopRoomStreamEvent, { type: "open" }>> {
  return emitted.filter(
    (event): event is Extract<DesktopRoomStreamEvent, { type: "open" }> =>
      event.type === "open" && event.gap === true && event.verified === true && typeof event.deliveryRepairToken === "number",
  );
}

/** Open the room as the app does: the stream starts, and the renderer reads the room once. */
async function openRoom(room: string): Promise<void> {
  emitted.length = 0;
  await startDesktopRoomStream(room);
  await waitUntil(() => repairRequests().length === 1);
  acknowledgeDesktopRoomStreamGapRepair(room, { token: repairRequests()[0]!.deliveryRepairToken as number });
}

/** A clock the test can move forward, so a remembered join ends without a five-minute wait. */
function movableClock(t: test.TestContext): { advance(ms: number): void } {
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  return { advance: (ms) => { offset += ms; } };
}

test.afterEach(async () => {
  await stopDesktopRoomStream();
  roomInfo.clearJoinedRoomInfoCache();
});

test("an open room repeats its join only when the remembered answer ended, and reads the room when the answer changed", async (t) => {
  const room = "design-lounge";
  const clock = movableClock(t);
  const server = installServer(room);
  try {
    // What the room open stored: the room on screen was built from it.
    roomInfo.rememberJoinedRoomInfo(room, { room_id: room, name: "Design lounge", role: "participant" });
    await openRoom(room);
    await sleep(FIRST_CHECK_MS * 3);
    assert.deepEqual(server.joins, [], "a join that still answers is not sent again");
    assert.equal(repairRequests().length, 1);

    // Five minutes later the answer is the same: one join, no room read.
    await stopDesktopRoomStream();
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS + 1);
    server.answer({ body: { room_id: room, name: "Design lounge", role: "participant" } });
    await openRoom(room);
    await waitUntil(() => server.joins.length === 1);
    await sleep(FIRST_CHECK_MS);
    assert.deepEqual(server.joins, [`POST /rooms/${room}/join?create=false`],
      "the join never creates a room: it only says the person is still there");
    assert.equal(repairRequests().length, 1, "the same answer asks for no room read");

    // Five more minutes: an admin made the person an admin.
    await stopDesktopRoomStream();
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS + 1);
    server.answer({ body: { room_id: room, name: "Design lounge", role: "admin" } });
    await openRoom(room);
    await waitUntil(() => repairRequests().length === 2);
    assert.equal(server.joins.length, 2);
    assert.equal(repairRequests()[1]?.roomIdentifier, room, "a changed answer asks the renderer to read the room once");
    assert.deepEqual(server.others, [], "no event was missed, so no message request goes with it");
    assert.equal((await roomInfo.getJoinedRoomInfo(room)).role, "admin", "that read is answered from the new join");
    assert.equal(server.joins.length, 2);
  } finally {
    server.restore();
  }
});

test("a room that stays open sends the join again when the answer ends, on the same stream", async (t) => {
  const room = "long-visit";
  const clock = movableClock(t);
  const server = installServer(room);
  try {
    roomInfo.rememberJoinedRoomInfo(room, { room_id: room, name: "Long visit", role: "participant" });
    // The remembered answer ends shortly after the room opens.
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS - 300);
    server.answer({ body: { room_id: room, name: "Long visit", role: "participant" } });
    await openRoom(room);
    await sleep(FIRST_CHECK_MS * 3);
    assert.deepEqual(server.joins, [], "the first check finds an answer that still holds");
    // The next check waits for that answer to end (plus one second), with no reopen of the room.
    await waitUntil(() => server.joins.length === 1, 4_000);
    assert.equal(repairRequests().length, 1, "the same answer asks for no room read");
    await sleep(FIRST_CHECK_MS * 3);
    assert.equal(server.joins.length, 1, "the new answer holds for five minutes");
  } finally {
    server.restore();
  }
});

test("a changed answer replaces a room read that is still owed: that read may have used the old answer", async (t) => {
  const room = "busy-start";
  const clock = movableClock(t);
  const server = installServer(room);
  try {
    roomInfo.rememberJoinedRoomInfo(room, { room_id: room, name: "Busy start", role: "participant" });
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS + 1);
    server.answer({ body: { room_id: room, name: "Busy start", role: "admin" } });
    // The room opens, and the renderer has not read it yet (token 1 is owed) when the join answers.
    emitted.length = 0;
    await startDesktopRoomStream(room);
    await waitUntil(() => repairRequests().length === 2);
    assert.deepEqual(repairRequests().map((event) => event.deliveryRepairToken), [1, 2]);
    assert.deepEqual(server.others, [], "the new request repeats no message repair that was done");
  } finally {
    server.restore();
  }
});

test("a join that the server refuses asks for one room read, which shows why the room is closed", async (t) => {
  const room = "members-only";
  const clock = movableClock(t);
  const server = installServer(room);
  try {
    roomInfo.rememberJoinedRoomInfo(room, { room_id: room, name: "Members only", role: "participant" });
    await openRoom(room);
    await stopDesktopRoomStream();
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS + 1);
    server.answer({ status: 403, body: { error: "Membership required", code: "ROOM_MEMBERSHIP_REQUIRED" } });
    server.answer({ status: 403, body: { error: "Membership required", code: "ROOM_MEMBERSHIP_REQUIRED" } });
    await openRoom(room);
    await waitUntil(() => repairRequests().length === 2);
    // The check comes again while the room stays open; the read that is owed is not asked for twice.
    await waitUntil(() => server.joins.length >= 2);
    assert.equal(repairRequests().length, 2);
  } finally {
    server.restore();
  }
});

test("no answer or a server fault leaves the room as it is, and the check comes again", async (t) => {
  const room = "flaky-network";
  const clock = movableClock(t);
  const server = installServer(room);
  try {
    roomInfo.rememberJoinedRoomInfo(room, { room_id: room, name: "Flaky", role: "participant" });
    await openRoom(room);
    await stopDesktopRoomStream();
    clock.advance(roomInfo.JOINED_ROOM_INFO_TTL_MS + 1);
    server.answer("no answer");
    server.answer({ status: 503, body: { error: "unavailable" } });
    server.answer({ body: { room_id: room, name: "Flaky", role: "participant" } });
    await openRoom(room);
    await waitUntil(() => server.joins.length === 3);
    await sleep(RETRY_MS * 2);
    assert.equal(server.joins.length, 3, "after an answer the next check waits for that answer to end");
    assert.equal(repairRequests().length, 1, "neither failure asked for a room read");
  } finally {
    server.restore();
  }
});

test("a room that is closed, or kept on this computer, sends no join", async () => {
  const room = "short-visit";
  const server = installServer(room);
  try {
    await openRoom(room);
    await stopDesktopRoomStream();
    await sleep(FIRST_CHECK_MS * 3);
    assert.deepEqual(server.joins, [], "closing the room cancels the check");

    const local = await localStore.createLocalRoom({ displayName: "On this computer" });
    await startDesktopRoomStream(local.roomIdentifier);
    await sleep(FIRST_CHECK_MS * 3);
    assert.deepEqual(server.joins, [], "a local room has no server to join");
  } finally {
    server.restore();
  }
});
