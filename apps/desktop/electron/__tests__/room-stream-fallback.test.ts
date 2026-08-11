import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";
import type { DesktopRoomStreamEvent } from "../ipc-types.js";

// `paths.ts` reads LETAGENTS_API_URL once at module-eval time; the shared
// harness pins it to an unroutable address so any un-stubbed fetch fails fast
// instead of reaching prod. Every fetch in this suite is stubbed regardless.
const env = createElectronTestEnv({ prefix: "room-stream-fallback-" });
env.resetState({});

// Shrink the failed-catch-up retry cadence (default 20s) so the retry path is
// testable. Must be set before room-stream.js is imported: the module reads it
// once at evaluation time, same as apiUrl.
const CATCH_UP_RETRY_MS = 50;
process.env.LETAGENTS_ROOM_STREAM_CATCHUP_RETRY_MS = String(CATCH_UP_RETRY_MS);
process.env.LETAGENTS_ROOM_SYNC_HANDSHAKE_TIMEOUT_MS = String(CATCH_UP_RETRY_MS);
test.after(() => {
  delete process.env.LETAGENTS_ROOM_STREAM_CATCHUP_RETRY_MS;
  delete process.env.LETAGENTS_ROOM_SYNC_HANDSHAKE_TIMEOUT_MS;
});

// Capture the exact window-facing stream-event sequence. `emitRoomStreamEvent`
// funnels every emit through `window.emitToMainWindow`, which is a no-op in a
// headless test (there is no BrowserWindow). Mocking the module lets us observe
// the real emitted sequence, including any duplicates. `dispatchRoomStreamEvent`
// to managed agents is left real — with no registered runtimes it is a no-op.
const emitted: DesktopRoomStreamEvent[] = [];
mock.module("../main/window.js", {
  namedExports: {
    emitToMainWindow: (channel: string, payload: unknown) => {
      if (channel === "desktop:room:stream-event") {
        emitted.push(payload as DesktopRoomStreamEvent);
      }
    },
    getMainWindow: () => null,
    hasOpenWindows: () => false,
    focusMainWindow: () => {},
    createWindow: () => {},
  },
});

const { startDesktopRoomStream, stopDesktopRoomStream, getActiveRoomIdentifier } =
  await import("../main/room-stream.js");

const ROOM = "focus_fallback_room";

type StreamHandler =
  | { kind: "ok"; sse: ControllableSse }
  | { kind: "fail"; status: number }
  | { kind: "hang" };

type PollRecord = { url: string; after: string | null; timeout: string | null; signal: AbortSignal };
type StreamRecord = { url: string; signal: AbortSignal };

interface ControllableSse {
  response: Response;
  pushMessage(id: string, text?: string): void;
  pushRoomSync(checkpoint: string | null, gap?: boolean): void;
  close(): void;
  error(err?: Error): void;
}

function makeSse(): ControllableSse {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    pushMessage(id: string, text = "hi") {
      const frame =
        `event: message\n` +
        `data: ${JSON.stringify({
          id,
          text,
          sender: "human",
          created_at: new Date().toISOString(),
        })}\n\n`;
      controller.enqueue(encoder.encode(frame));
    },
    pushRoomSync(checkpoint: string | null, gap = false) {
      controller.enqueue(encoder.encode(
        `event: room_sync\n` +
        `data: ${JSON.stringify({ room_id: ROOM, checkpoint, gap })}\n\n`,
      ));
    },
    close() {
      controller.close();
    },
    error(err = new Error("sse dropped")) {
      controller.error(err);
    },
  };
}

type MessagePage = { id: string; text?: string }[];
type CatchUpHandler = { kind: "page"; messages: MessagePage; hasMore?: boolean } | { kind: "fail"; status: number };

/**
 * Fetch router shared by every test. Stream fetches are answered from a FIFO of
 * handlers. Poll fetches all hit `/messages/poll`, but the fallback long-poll
 * (`timeout=25000`) and the SSE-open catch-up (`timeout=0`) are served from
 * SEPARATE FIFOs so a test can model reality: a real fallback poll is
 * server-held for 25s, so it must NOT race ahead and swallow the catch-up's
 * gap message. When a queue drains, that poll "hangs" like a server-held
 * request until its signal is aborted, which stops the stubbed loop from
 * busy-spinning and lets us assert in-flight aborts.
 */
function installFetchRouter(): {
  streamQueue: StreamHandler[];
  enqueueFallbackPoll(messages: MessagePage): void;
  enqueueLatest(messages: MessagePage): void;
  enqueueLatestFailure(status?: number): void;
  enqueueCatchUp(messages: MessagePage, hasMore?: boolean): void;
  enqueueCatchUpFailure(status?: number): void;
  streamCalls: StreamRecord[];
  pollCalls: PollRecord[];
  restore(): void;
} {
  const previousFetch = globalThis.fetch;
  const streamQueue: StreamHandler[] = [];
  const fallbackQueue: MessagePage[] = [];
  const latestQueue: Array<{ messages?: MessagePage; status?: number }> = [];
  const catchUpQueue: CatchUpHandler[] = [];
  const streamCalls: StreamRecord[] = [];
  const pollCalls: PollRecord[] = [];

  const hangUntilAborted = (signal: AbortSignal) =>
    new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });

  const routed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const signal = (init?.signal ?? (input instanceof Request ? input.signal : null)) as AbortSignal;

    if (url.includes("/messages/stream")) {
      streamCalls.push({ url, signal });
      const handler = streamQueue.shift() ?? { kind: "fail", status: 503 };
      if (handler.kind === "hang") return hangUntilAborted(signal);
      if (handler.kind === "fail") {
        return new Response(null, { status: handler.status });
      }
      return handler.sse.response;
    }

    if (url.includes("/messages/poll")) {
      const parsed = new URL(url);
      const timeout = parsed.searchParams.get("timeout");
      pollCalls.push({
        url,
        after: parsed.searchParams.get("after"),
        timeout,
        signal,
      });
      if (timeout === "0") {
        const handler = catchUpQueue.shift();
        if (handler?.kind === "fail") {
          return new Response(null, { status: handler.status });
        }
        if (handler) {
          return new Response(
            JSON.stringify({ room_id: ROOM, messages: handler.messages, has_more: handler.hasMore === true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return hangUntilAborted(signal);
      }
      const page = fallbackQueue.shift();
      if (page) {
        return new Response(JSON.stringify({ room_id: ROOM, messages: page }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return hangUntilAborted(signal);
    }
    if (url.includes("/messages?") && url.includes("before=latest")) {
      const latest = latestQueue.shift() || { messages: [] };
      if (latest.status) return new Response(null, { status: latest.status });
      return new Response(JSON.stringify({ room_id: ROOM, messages: latest.messages || [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // Any other outbound call in this suite is unexpected; answer benignly so a
    // stray call cannot crash the runtime, but it should never happen.
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = routed;

  return {
    streamQueue,
    enqueueFallbackPoll: (messages) => fallbackQueue.push(messages),
    enqueueLatest: (messages) => latestQueue.push({ messages }),
    enqueueLatestFailure: (status = 500) => latestQueue.push({ status }),
    enqueueCatchUp: (messages, hasMore = false) => catchUpQueue.push({ kind: "page", messages, hasMore }),
    enqueueCatchUpFailure: (status = 500) => catchUpQueue.push({ kind: "fail", status }),
    streamCalls,
    pollCalls,
    restore: () => {
      if (globalThis.fetch === routed) globalThis.fetch = previousFetch;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await sleep(10);
  }
}

function messageIds(): string[] {
  return emitted
    .filter((event): event is Extract<DesktopRoomStreamEvent, { type: "message" }> => event.type === "message")
    .map((event) => event.message.id);
}

function emittedMessage(id: string) {
  return emitted.find(
    (event): event is Extract<DesktopRoomStreamEvent, { type: "message" }> =>
      event.type === "message" && event.message.id === id,
  )?.message;
}

test.beforeEach(() => {
  emitted.length = 0;
});

test.afterEach(async () => {
  await stopDesktopRoomStream();
});

test("healthy SSE with an empty snapshot establishes the first cursor before reading live frames", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });

    // No cursor: on connect there is nothing before stream start to backfill,
    // so the SSE-open catch-up short-circuits and no poll endpoint is touched.
    await startDesktopRoomStream(ROOM);
    await waitUntil(() => emitted.some((event) => event.type === "open"));

    sse.pushMessage("msg_1");
    sse.pushMessage("msg_2");
    await waitUntil(() => messageIds().length === 2);

    assert.deepEqual(messageIds(), ["msg_1", "msg_2"]);
    assert.deepEqual(emittedMessage("msg_1")?.accountAgentRouting, {
      version: 1,
      authority: "invalid",
    }, "an old cloud SSE frame without an envelope stays visible but cannot wake workers");
    assert.equal(router.streamCalls.length, 1, "exactly one SSE transport opened");
    assert.equal(router.pollCalls.length, 0, "initial null cursor never drains room history");

    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("SSE sends the snapshot cursor and forwards the revision handshake", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    router.enqueueCatchUp([]);

    await startDesktopRoomStream(ROOM, "msg_7");
    await waitUntil(() => emitted.some((event) => event.type === "open"));
    assert.match(router.streamCalls[0]?.url || "", /[?&]after=msg_7(?:&|$)/);

    sse.pushRoomSync("msg_7", false);
    await waitUntil(() => emitted.filter((event) => event.type === "open").length === 2);
    const checkpointOpen = emitted.filter(
      (event): event is Extract<DesktopRoomStreamEvent, { type: "open" }> => event.type === "open",
    ).at(-1);
    assert.equal(checkpointOpen?.checkpoint, "msg_7");
    assert.equal(checkpointOpen?.gap, false);
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("SSE catch-up paginates until a reconnect backlog is exhausted", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    router.enqueueCatchUp([{ id: "msg_150" }], true);
    router.enqueueCatchUp([{ id: "msg_151" }], false);

    await startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => messageIds().includes("msg_151"));

    const catchUps = router.pollCalls.filter((call) => call.timeout === "0");
    assert.deepEqual(catchUps.map((call) => call.after), ["msg_1", "msg_150"]);
    assert.deepEqual(messageIds(), ["msg_150", "msg_151"]);
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("older server without room_sync falls back after a bounded handshake timeout", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    router.enqueueCatchUp([]);
    await startDesktopRoomStream(ROOM, "msg_1");

    await waitUntil(() => emitted.some(
      (event) => event.type === "open" && event.gap === true && event.verified === false,
    ));
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("room startup does not block indefinitely when SSE never returns headers", async () => {
  const router = installFetchRouter();
  try {
    router.streamQueue.push({ kind: "hang" });
    const startedAt = Date.now();
    await startDesktopRoomStream(ROOM, null);
    assert.ok(Date.now() - startedAt < CATCH_UP_RETRY_MS * 4);
    assert.equal(router.streamCalls.length, 1);
    assert.equal(router.streamCalls[0]?.signal.aborted, false, "hung SSE remains available for reconnect/stop");
    assert.ok(emitted.some((event) => event.type === "open" && event.gap === true && event.verified === false));
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("SSE failure brings up the fallback poll and messages keep flowing", async () => {
  const router = installFetchRouter();
  try {
    // First (and only, within this test window) SSE connect fails.
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.enqueueFallbackPoll([{ id: "msg_2" }]);

    await startDesktopRoomStream(ROOM, "msg_1");

    assert.ok(emitted.some((event) => event.type === "open" && event.gap === true && event.verified === false));

    await waitUntil(() => messageIds().includes("msg_2"));

    assert.ok(router.pollCalls.length >= 1, "fallback poll issued after SSE failed");
    assert.equal(router.pollCalls[0]?.after, "msg_1", "fallback poll resumes from the cursor");
    assert.equal(router.pollCalls[0]?.timeout, "25000", "fallback uses the long-poll timeout");
    assert.deepEqual(messageIds(), ["msg_2"]);
    assert.deepEqual(emittedMessage("msg_2")?.accountAgentRouting, {
      version: 1,
      authority: "invalid",
    }, "an old cloud poll row without an envelope never falls back to mutable aliases");
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("empty-room SSE outage discovers the first message from a bounded latest page", async () => {
  const router = installFetchRouter();
  try {
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.enqueueLatest([{ id: "msg_1" }]);
    await startDesktopRoomStream(ROOM, null);
    await waitUntil(() => messageIds().includes("msg_1"));
    assert.deepEqual(messageIds(), ["msg_1"]);
    assert.equal(router.pollCalls.length, 0, "null cursor does not request oldest-first poll history");
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("empty-room latest-page fallback retries after a transient failure", async () => {
  const router = installFetchRouter();
  try {
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.enqueueLatestFailure();
    router.enqueueLatest([{ id: "msg_1" }]);
    await startDesktopRoomStream(ROOM, null);
    await waitUntil(() => messageIds().includes("msg_1"), 5_000);
    assert.deepEqual(messageIds(), ["msg_1"]);
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("SSE recovery catches up, retires the poll, and neither drops nor duplicates", async () => {
  const router = installFetchRouter();
  try {
    const recovered = makeSse();
    // Connect #1 fails -> fallback poll. Connect #2 (after backoff) succeeds.
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.streamQueue.push({ kind: "ok", sse: recovered });
    // The fallback long-poll delivers msg_2 then holds; the SSE-open catch-up
    // (a distinct timeout=0 request) delivers the gap message msg_3.
    router.enqueueFallbackPoll([{ id: "msg_2" }]);
    router.enqueueCatchUp([{ id: "msg_3" }]);

    await startDesktopRoomStream(ROOM, "msg_1");

    // Fallback delivered msg_2 and then a second fallback poll is left held.
    await waitUntil(() => messageIds().includes("msg_2"));
    await waitUntil(() => router.pollCalls.length >= 2);
    const heldPoll = router.pollCalls[1];

    // Wait for SSE reconnect (exponential backoff starts at 1s) to open #2.
    await waitUntil(() => router.streamCalls.length === 2, 4000);
    // Catch-up runs on reconnect and delivers the gap message msg_3.
    await waitUntil(() => messageIds().includes("msg_3"), 4000);

    // The held fallback poll was aborted as part of retiring the loop.
    assert.ok(heldPoll?.signal.aborted, "in-flight fallback poll aborted on recovery");

    // The catch-up resumed exactly from the last delivered id (no gap, no rewind).
    const catchUp = router.pollCalls.find((call) => call.timeout === "0");
    assert.ok(catchUp, "a timeout=0 catch-up fetch ran on SSE open");
    assert.equal(catchUp?.after, "msg_2", "catch-up resumes from the last delivered id");

    // Live SSE now carries the next message with no re-open of the poll.
    const pollCountAfterRecovery = router.pollCalls.length;
    recovered.pushMessage("msg_4");
    await waitUntil(() => messageIds().includes("msg_4"), 4000);
    await sleep(50);
    assert.equal(
      router.pollCalls.length,
      pollCountAfterRecovery,
      "no new poll request issued once SSE is healthy again",
    );

    // Full emitted message order across the whole transition: exactly once each.
    assert.deepEqual(messageIds(), ["msg_2", "msg_3", "msg_4"]);

    recovered.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("failed catch-up schedules a retry that retires the fallback poll", async () => {
  const router = installFetchRouter();
  try {
    const recovered = makeSse();
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.streamQueue.push({ kind: "ok", sse: recovered });
    router.enqueueFallbackPoll([{ id: "msg_2" }]);
    // The catch-up on SSE reconnect fails once; the scheduled retry succeeds.
    router.enqueueCatchUpFailure(500);
    router.enqueueCatchUp([{ id: "msg_3" }]);

    await startDesktopRoomStream(ROOM, "msg_1");

    // Fallback delivered msg_2; a second fallback poll is left server-held.
    await waitUntil(() => messageIds().includes("msg_2"));
    await waitUntil(() => router.pollCalls.length >= 2);
    const heldPoll = router.pollCalls[1];

    // SSE reconnects; the first catch-up runs and fails.
    await waitUntil(() => router.streamCalls.length === 2, 4000);
    await waitUntil(
      () => router.pollCalls.some((call) => call.timeout === "0"),
      4000,
    );
    // The failed catch-up must NOT retire the fallback: it is still the only
    // gap-filler until a catch-up succeeds.
    assert.equal(heldPoll?.signal.aborted, false, "fallback poll survives a failed catch-up");

    // The bounded retry fires, succeeds, delivers the gap message, and only
    // then retires the fallback poll.
    await waitUntil(() => messageIds().includes("msg_3"), 4000);
    await waitUntil(() => Boolean(heldPoll?.signal.aborted), 4000);
    const catchUps = router.pollCalls.filter((call) => call.timeout === "0");
    assert.equal(catchUps.length, 2, "exactly one retry after the failed catch-up");
    assert.equal(catchUps[1]?.after, "msg_2", "retry resumes from the last delivered id");

    // SSE now carries live messages with no further poll traffic.
    const pollCountAfterRetirement = router.pollCalls.length;
    recovered.pushMessage("msg_4");
    await waitUntil(() => messageIds().includes("msg_4"), 4000);
    await sleep(CATCH_UP_RETRY_MS * 3);
    assert.equal(router.pollCalls.length, pollCountAfterRetirement, "no poll traffic once retired");
    assert.deepEqual(messageIds(), ["msg_2", "msg_3", "msg_4"]);

    recovered.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("stopDesktopRoomStream clears a pending catch-up retry", async () => {
  const router = installFetchRouter();
  try {
    const recovered = makeSse();
    router.streamQueue.push({ kind: "fail", status: 503 });
    router.streamQueue.push({ kind: "ok", sse: recovered });
    router.enqueueFallbackPoll([{ id: "msg_2" }]);
    // Only a failing catch-up is queued: a retry gets scheduled and would hit
    // the (hanging) catch-up queue again if it ever fired after stop.
    router.enqueueCatchUpFailure(500);

    await startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.streamCalls.length === 2, 4000);
    await waitUntil(
      () => router.pollCalls.some((call) => call.timeout === "0"),
      4000,
    );

    const catchUpsBeforeStop = router.pollCalls.filter((call) => call.timeout === "0").length;
    await stopDesktopRoomStream();

    // Wait well past the retry cadence: a cleared timer means no further
    // catch-up fetch is ever issued for the stopped stream.
    await sleep(CATCH_UP_RETRY_MS * 4);
    const catchUpsAfterStop = router.pollCalls.filter((call) => call.timeout === "0").length;
    assert.equal(catchUpsAfterStop, catchUpsBeforeStop, "no catch-up retry after stop");
    assert.equal(getActiveRoomIdentifier(), null);

    recovered.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("stopDesktopRoomStream aborts both the SSE and the fallback poll", async () => {
  const router = installFetchRouter();
  try {
    router.streamQueue.push({ kind: "fail", status: 503 });
    // No poll page queued -> the fallback poll issues a request that hangs
    // (server-held) until aborted.
    await startDesktopRoomStream(ROOM, "msg_1");

    // The SSE fetch is issued asynchronously (after readStoredAuth), so wait for
    // it to be recorded before capturing its signal.
    await waitUntil(() => router.streamCalls.length >= 1);
    const sseCall = router.streamCalls[0];
    await waitUntil(() => router.pollCalls.length >= 1);
    const pollCall = router.pollCalls[router.pollCalls.length - 1];

    await stopDesktopRoomStream();

    assert.ok(sseCall?.signal.aborted, "SSE request aborted on stop");
    assert.ok(pollCall?.signal.aborted, "fallback poll request aborted on stop");
    assert.equal(getActiveRoomIdentifier(), null, "no active room stream after stop");
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});
