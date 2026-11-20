import assert from "node:assert/strict";
import test from "node:test";

import {
  SSE_HEALTHY_STREAM_MS,
  SSE_RETRY_BASE_MS,
  SSE_RETRY_MAX_MS,
  SseClient,
  sseRetryWaitMs,
  sseStreamEarnsShortRetry,
  type Message,
  type SseGap,
} from "../sse-client.js";

test("SSE client reconnects with the broker cursor and surfaces room gaps", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Headers }> = [];
  let sawReconnect!: () => void;
  const reconnectSeen = new Promise<void>((resolve) => { sawReconnect = resolve; });
  let sawResubscribe!: () => void;
  const resubscribeSeen = new Promise<void>((resolve) => { sawResubscribe = resolve; });
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(input), headers });
    if (requests.length === 1) {
      const body = [
        "id: broker_1",
        "event: message",
        'data: {"id":"msg_1","sender":"agent","text":"hello","timestamp":"now"}',
        "",
        "event: room_sync",
        'data: {"gap":true,"room_id":"room_1","event_cursor":"broker_2"}',
        "",
        "",
      ].join("\n");
      return new Response(body, { status: 200 });
    }
    if (requests.length === 2) sawReconnect();
    if (requests.length === 3) sawResubscribe();
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const messages: Message[] = [];
  const gaps: SseGap[] = [];
  const client = new SseClient("https://example.test", () => "token_1");
  try {
    client.subscribe(
      { roomId: "room_1" },
      (message) => messages.push(message),
      (gap) => gaps.push(gap),
    );
    await withTestDeadline(reconnectSeen, 2_000, "SSE did not reconnect");

    assert.deepEqual(messages.map((message) => message.id), ["msg_1"]);
    assert.deepEqual(gaps.map((gap) => gap.event_cursor), ["broker_2"]);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.headers.get("Last-Event-ID"), "broker_2");
    assert.equal(requests[1]?.headers.get("Authorization"), "Bearer token_1");
    assert.match(requests[1]?.url ?? "", /include_prompt_only=1/);

    client.unsubscribe("room_1");
    client.subscribe({ roomId: "room_1" }, () => undefined);
    await withTestDeadline(resubscribeSeen, 500, "SSE did not resubscribe");
    assert.equal(
      requests[2]?.headers.get("Last-Event-ID"),
      "broker_2",
      "a same-process room resubscribe preserves its broker cursor",
    );
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});

test("an explicit null repair cursor clears stale MCP replay state", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Headers[] = [];
  let sawGap!: () => void;
  const gapSeen = new Promise<void>((resolve) => { sawGap = resolve; });
  let sawResubscribe!: () => void;
  const resubscribeSeen = new Promise<void>((resolve) => { sawResubscribe = resolve; });
  globalThis.fetch = (async (_input, init) => {
    requests.push(new Headers(init?.headers));
    if (requests.length === 1) {
      return new Response([
        "id: stale_cursor",
        'data: {"id":"msg_1","sender":"agent","text":"hello","timestamp":"now"}',
        "",
        "event: room_sync",
        'data: {"gap":true,"event_cursor":null}',
        "",
        "",
      ].join("\n"), { status: 200 });
    }
    sawResubscribe();
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const client = new SseClient("https://example.test");
  try {
    client.subscribe({ roomId: "room_null_cursor" }, () => undefined, () => sawGap());
    await withTestDeadline(gapSeen, 500, "SSE did not surface the null-cursor gap");
    client.unsubscribe("room_null_cursor");
    client.subscribe({ roomId: "room_null_cursor" }, () => undefined);
    await withTestDeadline(resubscribeSeen, 500, "SSE did not resubscribe after cursor repair");
    assert.equal(requests[1]?.get("Last-Event-ID"), null);
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});

test("a clean room-sync checkpoint becomes the reconnect baseline without a fake message", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Headers[] = [];
  let reconnect!: () => void;
  const reconnected = new Promise<void>((resolve) => { reconnect = resolve; });
  let messageCallbacks = 0;
  globalThis.fetch = (async (_input, init) => {
    requests.push(new Headers(init?.headers));
    if (requests.length === 1) {
      return new Response([
        "event: room_sync",
        'data: {"gap":false,"event_cursor":"broker_baseline"}',
        "",
        "",
      ].join("\n"), { status: 200 });
    }
    reconnect();
    return new Response("", { status: 200 });
  }) as typeof fetch;

  const client = new SseClient("https://example.test");
  try {
    client.subscribe({ roomId: "room_baseline" }, () => { messageCallbacks += 1; });
    await withTestDeadline(reconnected, 2_000, "SSE did not reconnect from checkpoint");
    assert.equal(requests[1]?.get("Last-Event-ID"), "broker_baseline");
    assert.equal(messageCallbacks, 0);
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});

test("an unterminated oversized frame clears the cursor and forces gap repair", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Headers[] = [];
  const gaps: SseGap[] = [];
  let sawReconnect!: () => void;
  const reconnected = new Promise<void>((resolve) => { sawReconnect = resolve; });
  globalThis.fetch = (async (_input, init) => {
    requests.push(new Headers(init?.headers));
    if (requests.length === 1) {
      return new Response([
        "id: prior_cursor",
        'data: {"id":"msg_1","sender":"agent","text":"ok","timestamp":"now"}',
        "",
        "",
      ].join("\n"), { status: 200 });
    }
    if (requests.length === 2) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1024 * 1024 + 1)}`));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    sawReconnect();
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const client = new SseClient("https://example.test", undefined, { random: () => 0 });
  try {
    client.subscribe({ roomId: "room_overflow" }, () => undefined, (gap) => gaps.push(gap));
    await withTestDeadline(reconnected, 3_000, "SSE did not reconnect after frame overflow");
    assert.equal(gaps.at(-1)?.event_cursor, null);
    assert.equal(requests[2]?.get("Last-Event-ID"), null);
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});

test("a small malformed frame clears the cursor and forces gap repair", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Headers[] = [];
  const gaps: SseGap[] = [];
  let sawReconnect!: () => void;
  const reconnected = new Promise<void>((resolve) => { sawReconnect = resolve; });
  globalThis.fetch = (async (_input, init) => {
    requests.push(new Headers(init?.headers));
    if (requests.length === 1) return new Response([
      "id: prior_cursor",
      'data: {"id":"msg_1","sender":"agent","text":"ok","timestamp":"now"}',
      "", "",
    ].join("\n"), { status: 200 });
    if (requests.length === 2) return new Response([
      "id: malformed_cursor", "data: {malformed", "", "",
    ].join("\n"), { status: 200 });
    sawReconnect();
    return new Response("", { status: 200 });
  }) as typeof fetch;
  // Shortest waits (0.75 s, then 1.1 s): the 3 s deadline below holds on every run.
  const client = new SseClient("https://example.test", undefined, { random: () => 0 });
  try {
    client.subscribe({ roomId: "room_malformed" }, () => undefined, (gap) => gaps.push(gap));
    await withTestDeadline(reconnected, 3_000, "SSE did not reconnect after malformed frame");
    assert.equal(gaps.at(-1)?.event_cursor, null);
    assert.equal(requests[2]?.get("Last-Event-ID"), null);
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
  }
});

test("the reconnect delay starts over only after a stream that worked", () => {
  // A stream the server opened and ended at once: no handshake, no time open.
  assert.equal(sseStreamEarnsShortRetry({ livedMs: 5, endedCleanly: true, deliveredRoomSync: false }), false);
  // The handshake arrived and the stream ended without an error.
  assert.equal(sseStreamEarnsShortRetry({ livedMs: 5, endedCleanly: true, deliveredRoomSync: true }), true);
  // An error soon after the handshake still backs off, as before.
  assert.equal(sseStreamEarnsShortRetry({ livedMs: 5_000, endedCleanly: false, deliveredRoomSync: true }), false);
  // A stream that stayed open long enough worked, however it ended.
  assert.equal(sseStreamEarnsShortRetry({ livedMs: SSE_HEALTHY_STREAM_MS, endedCleanly: false, deliveredRoomSync: false }), true);
  assert.equal(sseStreamEarnsShortRetry({ livedMs: SSE_HEALTHY_STREAM_MS - 1, endedCleanly: false, deliveredRoomSync: false }), false);
});

test("each reconnect wait is spread by a quarter around its delay", () => {
  assert.equal(sseRetryWaitMs(1_000, 0), 750);
  assert.equal(sseRetryWaitMs(1_000, 0.5), 1_000);
  assert.equal(sseRetryWaitMs(1_000, 0.999), 1_250);
  assert.equal(sseRetryWaitMs(SSE_RETRY_MAX_MS, 0.999), 37_485);
});

/** Runs one subscription with instant waits and returns each wait the client asked for. */
async function recordedWaits(input: {
  respond: (request: number) => Response | Promise<Response>;
  waits: number;
  now?: () => number;
}): Promise<number[]> {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const waits: number[] = [];
  let request = 0;
  let enough!: () => void;
  const done = new Promise<void>((resolve) => { enough = resolve; });
  globalThis.fetch = (async () => input.respond(++request)) as typeof fetch;
  console.error = () => undefined;
  const client = new SseClient("https://example.test", () => "token", {
    random: () => 0.5,
    ...(input.now ? { now: input.now } : {}),
    wait: async (signal, delayMs) => {
      waits.push(delayMs);
      if (waits.length >= input.waits) {
        enough();
        // Hold the loop here until the test unsubscribes.
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    },
  });
  try {
    client.subscribe({ roomId: "room_retry" }, () => undefined);
    await withTestDeadline(done, 2_000, "the client did not ask for the expected waits");
    return waits;
  } finally {
    client.unsubscribeAll();
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
}

const roomSyncStream = () => new Response(
  ["event: room_sync", 'data: {"gap":false,"room_id":"room_retry","event_cursor":"c1"}', "", ""].join("\n"),
  { status: 200 },
);

test("a stream the server opens and ends at once backs off instead of reconnecting every second", async () => {
  // HTTP 200, the opening comment, then the end: what a refused stream looked like before the server answered 4xx.
  const waits = await recordedWaits({ respond: () => new Response(": connected\n\n", { status: 200 }), waits: 12 });
  assert.deepEqual(waits.slice(0, 6), [1_000, 1_500, 2_250, 3_375, 5_063, 7_595]);
  assert.equal(waits.at(-1), SSE_RETRY_MAX_MS, "the delay stops at its cap");
  // The first minute of this is 9 opened streams (the 8 waits between them sum to 49 s). With a fixed 1 s wait it was 60.
  let elapsed = 0;
  const opensInOneMinute = 1 + waits.filter((wait) => (elapsed += wait) <= 60_000).length;
  assert.equal(opensInOneMinute, 9);
});

test("a stream that gave its handshake and ended cleanly reconnects after the base delay every time", async () => {
  const waits = await recordedWaits({ respond: roomSyncStream, waits: 5 });
  assert.deepEqual(waits, [SSE_RETRY_BASE_MS, SSE_RETRY_BASE_MS, SSE_RETRY_BASE_MS, SSE_RETRY_BASE_MS, SSE_RETRY_BASE_MS]);
});

test("a refused stream keeps backing off, and one stream that works starts the delay over", async () => {
  const waits = await recordedWaits({
    respond: (request) => (request === 4 ? roomSyncStream() : new Response("{}", { status: 503 })),
    waits: 6,
  });
  assert.deepEqual(waits, [1_000, 1_500, 2_250, 1_000, 1_500, 2_250]);
});

test("a stream that stayed open for 30 seconds starts the delay over even when it ends with an error", async () => {
  let clock = 0;
  const waits = await recordedWaits({
    now: () => clock,
    respond: (request) => {
      if (request !== 3) return new Response("", { status: 200 });
      // The third stream stays open (the clock moves on while it is read) and then breaks.
      // No read-ahead, so the clock moves only once the client reads the open stream.
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          clock += SSE_HEALTHY_STREAM_MS;
          controller.error(new Error("connection lost"));
        },
      }, { highWaterMark: 0 }), { status: 200 });
    },
    waits: 4,
  });
  assert.deepEqual(waits, [1_000, 1_500, 1_000, 1_500]);
});

test("a request that waited 30 seconds for a refusal was never open: the delay keeps growing", async () => {
  let clock = 0;
  const waits = await recordedWaits({
    now: () => clock,
    // A proxy that holds each request for its own limit and then answers 504.
    respond: () => {
      clock += SSE_HEALTHY_STREAM_MS;
      return new Response("{}", { status: 504 });
    },
    waits: 4,
  });
  assert.deepEqual(waits, [1_000, 1_500, 2_250, 3_375]);
});

async function withTestDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
