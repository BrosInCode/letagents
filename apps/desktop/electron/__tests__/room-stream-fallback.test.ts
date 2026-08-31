import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createElectronTestEnv } from "./harness.js";
import type { DesktopRoomDeliveryRepair, DesktopRoomStreamEvent } from "../ipc-types.js";

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
const managedEmitted: DesktopRoomStreamEvent[] = [];
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
mock.module("../main/agents/codex-supervisor.js", {
  namedExports: {
    dispatchRoomStreamEventToManagedAgents: (event: DesktopRoomStreamEvent) => {
      managedEmitted.push(event);
    },
    listDesktopManagedAgentSessionPopulationForRoom: () => ({
      sessions: [],
      complete: true,
    }),
  },
});

const {
  startDesktopRoomStream,
  stopDesktopRoomStream,
  getActiveRoomIdentifier,
  repairDesktopRoomStreamManagedDelivery,
} =
  await import("../main/room-stream.js");

const ROOM = "focus_fallback_room";

type StreamHandler =
  | { kind: "ok"; sse: ControllableSse }
  | { kind: "fail"; status: number }
  | { kind: "hang" };

type PollRecord = { url: string; after: string | null; timeout: string | null; signal: AbortSignal };
type StreamRecord = { url: string; signal: AbortSignal; headers: Headers };

interface ControllableSse {
  response: Response;
  pushMessage(id: string, text?: string, eventCursor?: string): void;
  pushTask(task: Record<string, unknown>, eventCursor?: string): void;
  pushRoomSync(checkpoint: string | null, gap?: boolean, eventCursor?: string | null): void;
  close(): void;
  error(err?: Error): void;
  pushRaw(chunk: string): void;
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
    pushMessage(id: string, text = "hi", eventCursor?: string) {
      const frame =
        (eventCursor ? `id: ${eventCursor}\n` : "") +
        `event: message\n` +
        `data: ${JSON.stringify({
          id,
          text,
          sender: "human",
          created_at: new Date().toISOString(),
        })}\n\n`;
      controller.enqueue(encoder.encode(frame));
    },
    pushTask(task: Record<string, unknown>, eventCursor?: string) {
      controller.enqueue(encoder.encode(
        (eventCursor ? `id: ${eventCursor}\n` : "")
        + `event: task_update\n`
        + `data: ${JSON.stringify(task)}\n\n`,
      ));
    },
    pushRoomSync(checkpoint: string | null, gap = false, eventCursor?: string | null) {
      const payload: Record<string, unknown> = { room_id: ROOM, checkpoint, gap };
      if (eventCursor !== undefined) payload.event_cursor = eventCursor;
      controller.enqueue(encoder.encode(
        `event: room_sync\n` +
        `data: ${JSON.stringify(payload)}\n\n`,
      ));
    },
    close() {
      controller.close();
    },
    error(err = new Error("sse dropped")) {
      controller.error(err);
    },
    pushRaw(chunk: string) {
      controller.enqueue(encoder.encode(chunk));
    },
  };
}

type MessagePage = Array<{ id: string; text?: string; [key: string]: unknown }>;
type CatchUpHandler =
  | { kind: "page"; messages: MessagePage; hasMore?: boolean }
  | { kind: "fail"; status: number }
  | { kind: "deferred"; response: Promise<Response> };

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
  enqueueDeferredCatchUp(): (messages?: MessagePage, hasMore?: boolean) => void;
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
      streamCalls.push({
        url,
        signal,
        headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      });
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
        if (handler?.kind === "deferred") return handler.response;
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
    enqueueDeferredCatchUp: () => {
      let resolveResponse!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
      catchUpQueue.push({ kind: "deferred", response });
      return (messages: MessagePage = [], hasMore = false) => {
        resolveResponse(new Response(
          JSON.stringify({ room_id: ROOM, messages, has_more: hasMore }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      };
    },
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
  return emitted.flatMap((event) => {
    if (event.type === "message") return [event.message.id];
    if (event.type === "message_batch") return event.messages.map((message) => message.id);
    return [];
  });
}

function lastDeliveryRepairToken(): number | undefined {
  for (let index = emitted.length - 1; index >= 0; index -= 1) {
    const event = emitted[index];
    if (event?.type === "open" && event.deliveryRepairToken !== undefined) {
      return event.deliveryRepairToken;
    }
  }
  return undefined;
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

test("SSE reader drains into a bounded queue while durable catch-up is blocked", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    const releaseCatchUp = router.enqueueDeferredCatchUp();

    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.pollCalls.some((call) => call.timeout === "0"));
    sse.pushRoomSync("msg_1", false, "broker_1");
    sse.pushMessage("msg_2", "live during repair", "broker_2");
    await sleep(20);
    assert.deepEqual(messageIds(), [], "newer SSE bodies wait behind durable history repair");

    releaseCatchUp([{ id: "msg_old", text: "durable first" }]);
    await starting;
    await waitUntil(() => messageIds().includes("msg_2"));
    assert.deepEqual(messageIds(), ["msg_old", "msg_2"]);
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("SSE queue overflow releases frames and forces authoritative gap repair", async () => {
  const router = installFetchRouter();
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    const releaseCatchUp = router.enqueueDeferredCatchUp();
    // The synthetic overflow gap performs one new durable repair pass.
    router.enqueueCatchUp([]);

    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.pollCalls.some((call) => call.timeout === "0"));
    sse.pushRoomSync("msg_1", false, "broker_0");
    for (let index = 0; index < 300; index += 1) {
      sse.pushTask({
        id: `task_${index}`,
        title: `Task ${index}`,
        status: "in_progress",
        updated_at: "2026-08-11T10:00:00.000Z",
      }, `broker_${index + 1}`);
    }
    await sleep(20);
    assert.equal(emitted.some((event) => event.type === "task_update"), false);

    releaseCatchUp([]);
    await starting;
    await waitUntil(() => emitted.some(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ));
    assert.equal(
      emitted.some((event) => event.type === "task_update"),
      false,
      "overflowed frame bodies are discarded instead of replayed",
    );
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("unterminated SSE frame overflow clears the broker cursor and repairs authoritatively", async () => {
  const router = installFetchRouter();
  try {
    const first = makeSse();
    const second = makeSse();
    router.streamQueue.push({ kind: "ok", sse: first }, { kind: "ok", sse: second });
    router.enqueueCatchUp([]);
    router.enqueueCatchUp([]);
    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.pollCalls.some((call) => call.timeout === "0"));
    first.pushRoomSync("msg_1", false, "broker_before_overflow");
    await starting;
    first.pushRaw(`data: ${"x".repeat(1024 * 1024 + 1)}`);
    await waitUntil(() => emitted.some((event) =>
      event.type === "open" && event.gap === true && event.deliveryRepairToken !== undefined));
    const gap = [...emitted].reverse().find((event) =>
      event.type === "open" && event.gap === true && event.deliveryRepairToken !== undefined);
    assert.equal(gap?.type, "open");
    if (gap?.type !== "open" || gap.deliveryRepairToken === undefined) {
      throw new Error("expected an overflow repair token");
    }
    repairDesktopRoomStreamManagedDelivery(ROOM, {
      token: gap.deliveryRepairToken,
      messages: [],
      tasks: [],
    });
    await waitUntil(() => router.streamCalls.length >= 2);
    assert.equal(
      router.streamCalls[1]?.headers.get("Last-Event-ID"),
      null,
      "the unparsed frame makes the prior broker cursor unsafe",
    );
    second.pushRoomSync("msg_1", false, "broker_after_repair");
    await sleep(10);
    second.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("huge durable catch-up yields in bounded passes and windows only human history", async () => {
  const router = installFetchRouter();
  const managedStart = managedEmitted.length;
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    for (let index = 2; index <= 7; index += 1) {
      router.enqueueCatchUp([{ id: `msg_${index}`, text: `backlog ${index}` }], index < 7);
    }
    router.enqueueLatest([{ id: "msg_7", text: "authoritative tail" }]);

    await startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => emitted.some((event) => event.type === "message_window"));
    const catchUps = router.pollCalls.filter((call) => call.timeout === "0");
    assert.equal(catchUps.length, 6, "managed delivery advances through every durable page");
    assert.equal(
      emitted.filter((event) => event.type === "message_window").length,
      1,
      "renderer receives one bounded authoritative tail after the threshold",
    );
    assert.deepEqual(
      managedEmitted.slice(managedStart)
        .filter((event): event is Extract<DesktopRoomStreamEvent, { type: "message" }> => event.type === "message")
        .map((event) => event.message.id),
      ["msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7"],
      "windowing never skips managed-agent delivery",
    );
    sse.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("failed latest-window hydration remains pending after the durable catch-up cursor advances", async () => {
  const router = installFetchRouter();
  const managedStart = managedEmitted.length;
  try {
    const sse = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    for (let index = 2; index <= 7; index += 1) {
      router.enqueueCatchUp([{ id: `msg_${index}`, text: `backlog ${index}` }], index < 7);
    }
    router.enqueueLatestFailure();
    // The scheduled retry resumes from msg_7. There is no further history,
    // but the renderer still requires the authoritative latest window that
    // failed after the first catch-up had already advanced the durable cursor.
    router.enqueueCatchUp([]);
    router.enqueueLatest([{ id: "msg_7", text: "authoritative tail" }]);

    await startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => emitted.some((event) => event.type === "message_window"), 5_000);

    const catchUps = router.pollCalls.filter((call) => call.timeout === "0");
    assert.equal(catchUps.length, 7, "the retry runs even though the first pass advanced to the tail");
    assert.equal(catchUps.at(-1)?.after, "msg_7", "the retry resumes from the durable tail cursor");
    assert.equal(
      emitted.filter((event) => event.type === "message_window").length,
      1,
      "the recovered renderer receives exactly one authoritative window",
    );
    assert.deepEqual(
      managedEmitted.slice(managedStart)
        .filter((event): event is Extract<DesktopRoomStreamEvent, { type: "message" }> => event.type === "message")
        .map((event) => event.message.id),
      ["msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7"],
      "managed delivery remains exactly once while renderer recovery retries",
    );
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

test("SSE reconnect preserves the last broker event cursor", async () => {
  const router = installFetchRouter();
  try {
    const initial = makeSse();
    const reconnected = makeSse();
    const repaired = makeSse();
    router.streamQueue.push({ kind: "ok", sse: initial });
    router.streamQueue.push({ kind: "ok", sse: reconnected });
    router.streamQueue.push({ kind: "ok", sse: repaired });

    await startDesktopRoomStream("focus_cursor_room");
    await waitUntil(() => emitted.some((event) => event.type === "open"));
    initial.pushMessage("msg_1", "hello", "broker_17");
    await waitUntil(() => messageIds().includes("msg_1"));
    router.enqueueCatchUp([]);
    initial.error();

    await waitUntil(() => router.streamCalls.length === 2, 4_000);
    assert.equal(router.streamCalls[1]?.headers.get("Last-Event-ID"), "broker_17");
    const verifiedGapCount = emitted.filter(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ).length;
    router.enqueueCatchUp([]);
    reconnected.pushRoomSync("msg_1", true, null);
    await waitUntil(() => emitted.filter(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ).length > verifiedGapCount);
    const resetRepairToken = lastDeliveryRepairToken();
    assert.equal(typeof resetRepairToken, "number");
    repairDesktopRoomStreamManagedDelivery("focus_cursor_room", {
      token: resetRepairToken as number,
      messages: [],
      tasks: [],
    });
    await waitUntil(() => router.pollCalls.filter((call) => call.timeout === "0").length >= 2);
    reconnected.error();
    await waitUntil(() => router.streamCalls.length === 3, 4_000);
    assert.equal(
      router.streamCalls[2]?.headers.get("Last-Event-ID"),
      null,
      "an explicit null repair cursor clears stale desktop replay state",
    );
    repaired.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("a semantically malformed typed frame gaps instead of committing its broker cursor", async () => {
  const router = installFetchRouter();
  try {
    const initial = makeSse();
    const reconnected = makeSse();
    router.streamQueue.push({ kind: "ok", sse: initial }, { kind: "ok", sse: reconnected });
    router.enqueueCatchUp([]);
    router.enqueueCatchUp([]);
    await startDesktopRoomStream(ROOM, "msg_1");
    initial.pushTask({ id: "task_valid", status: "open" }, "broker_valid");
    await waitUntil(() => emitted.some((event) => event.type === "task_update"));
    initial.pushTask({ status: "open" }, "broker_malformed");
    await waitUntil(() => emitted.some(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ));
    initial.error();
    await waitUntil(() => router.streamCalls.length >= 2, 4_000);
    assert.equal(
      router.streamCalls[1]?.headers.get("Last-Event-ID"),
      "broker_valid",
      "an unapplied typed frame cannot become a reconnect boundary",
    );
    reconnected.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("unknown well-formed frames advance without delivery or gap repair", async () => {
  const router = installFetchRouter();
  try {
    const initial = makeSse();
    const reconnected = makeSse();
    router.streamQueue.push({ kind: "ok", sse: initial }, { kind: "ok", sse: reconnected });
    router.enqueueCatchUp([]);
    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.streamCalls.length === 1);
    initial.pushRoomSync("msg_1", false, "broker_known");
    await starting;
    const emittedCount = emitted.length;
    const managedCount = managedEmitted.length;
    initial.pushRaw("id: broker_future\nevent: future_room_event\ndata: {\"future_field\":true}\n\n");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, emittedCount, "unsupported events are not renderer events or repair requests");
    assert.equal(managedEmitted.length, managedCount, "unsupported events cannot wake agents");
    initial.error();
    await waitUntil(() => router.streamCalls.length >= 2, 4_000);
    assert.equal(router.streamCalls[1]?.headers.get("Last-Event-ID"), "broker_future");
    reconnected.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("malformed or oversized unknown frames cannot advance the broker cursor", async (t) => {
  for (const data of ["null", JSON.stringify({ oversized: "x".repeat(1024 * 1024) })]) {
    await t.test(data === "null" ? "non-object payload" : "complete oversized frame", async () => {
      const router = installFetchRouter();
      try {
        const initial = makeSse();
        const reconnected = makeSse();
        router.streamQueue.push({ kind: "ok", sse: initial }, { kind: "ok", sse: reconnected });
        router.enqueueCatchUp([]);
        const starting = startDesktopRoomStream(ROOM, "msg_1");
        await waitUntil(() => router.streamCalls.length === 1);
        initial.pushRoomSync("msg_1", false, "broker_known");
        await starting;
        const gapCount = emitted.filter((event) => event.type === "open" && event.gap && event.verified).length;
        initial.pushRaw(`id: broker_bad_future\nevent: future_room_event\ndata: ${data}\n\n`);
        await waitUntil(() => emitted.filter((event) => event.type === "open" && event.gap && event.verified).length > gapCount);
        initial.error();
        await waitUntil(() => router.streamCalls.length >= 2, 4_000);
        assert.equal(router.streamCalls[1]?.headers.get("Last-Event-ID"), "broker_known");
        reconnected.close();
      } finally {
        await stopDesktopRoomStream();
        router.restore();
      }
    });
  }
});

for (const messageIds of [["msg_7"], null, []]) test(`message-info ${JSON.stringify(messageIds)} advances without repair while malformed payloads gap`, async () => {
  const router = installFetchRouter();
  try {
    const initial = makeSse();
    const reconnected = makeSse();
    router.streamQueue.push({ kind: "ok", sse: initial }, { kind: "ok", sse: reconnected });
    router.enqueueCatchUp([]);
    router.enqueueCatchUp([]);
    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.streamCalls.length === 1);
    initial.pushRoomSync("msg_1", false, "broker_before_info");
    await starting;
    await new Promise((resolve) => setImmediate(resolve));
    const gapCount = emitted.filter(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ).length;
    const emittedCount = emitted.length;
    const managedCount = managedEmitted.length;
    initial.pushRaw(
      `id: broker_info\nevent: message_info_updated\ndata: ${JSON.stringify({
        room_id: ROOM,
        message_ids: messageIds,
      })}\n\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, emittedCount, "Message Info remains fetched on demand, without new renderer events");
    assert.equal(managedEmitted.length, managedCount, "an invalidation must not deliver work to managed agents");
    assert.equal(emitted.filter(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ).length, gapCount);
    initial.error();
    await waitUntil(() => router.streamCalls.length >= 2, 4_000);
    assert.equal(router.streamCalls[1]?.headers.get("Last-Event-ID"), "broker_info");
    reconnected.pushRaw(
      "id: broker_bad_info\nevent: message_info_updated\ndata: {\"message_ids\":\"bad\"}\n\n",
    );
    await waitUntil(() => emitted.filter(
      (event) => event.type === "open" && event.gap === true && event.verified === true,
    ).length > gapCount);
    reconnected.close();
  } finally {
    await stopDesktopRoomStream();
    router.restore();
  }
});

test("a live broker gap repairs missed targeted messages and tasks exactly once", async () => {
  const router = installFetchRouter();
  const managedStart = managedEmitted.length;
  try {
    const sse = makeSse();
    const reconnected = makeSse();
    router.streamQueue.push({ kind: "ok", sse });
    router.streamQueue.push({ kind: "ok", sse: reconnected });
    router.enqueueCatchUp([]);
    const starting = startDesktopRoomStream(ROOM, "msg_1");
    await waitUntil(() => router.streamCalls.length === 1);
    sse.pushRoomSync("msg_1", false, "broker_repair_1");
    await starting;

    const liveTask = {
      id: "task_live",
      title: "Already delivered",
      status: "in_progress",
      updated_at: "2026-08-11T10:00:00.000Z",
    };
    sse.pushMessage("msg_2", "already delivered");
    sse.pushTask(liveTask, "broker_repair_2");
    await waitUntil(() => managedEmitted.slice(managedStart).some(
      (event) => event.type === "message" && event.message.id === "msg_2",
    ));

    router.enqueueCatchUp([
      { id: "msg_2", sender: "human", source: "browser", text: "duplicate" },
      {
        id: "msg_3",
        sender: "EmmyMay",
        source: "browser",
        text: "[Agent delivery prompt | mention | recipients: Codex] recovered target",
        agent_prompt_kind: "mention",
      },
    ]);
    sse.pushRoomSync("msg_3", true, "broker_repair_3");
    await waitUntil(() => managedEmitted.slice(managedStart).some(
      (event) => event.type === "message" && event.message.id === "msg_3",
    ));
    sse.pushTask({
      id: "task_after_gap",
      title: "Live while repair is pending",
      status: "in_progress",
      updated_at: "2026-08-11T10:00:30.000Z",
    }, "broker_repair_4");

    const recoveredTask = {
      id: "task_recovered",
      title: "Recovered task",
      description: null,
      status: "accepted",
      assignee: "Codex",
      assigneeAgentKey: "emmymay/codex",
      createdBy: "EmmyMay",
      prUrl: null,
      workflowArtifacts: [],
      workflowRefs: [],
      activeLeases: [],
      activeLocks: [],
      stalePromptState: null,
      createdAt: "2026-08-11T09:00:00.000Z",
      updatedAt: "2026-08-11T10:01:00.000Z",
    };
    const deliveryRepairToken = lastDeliveryRepairToken();
    assert.equal(typeof deliveryRepairToken, "number");
    const repair: DesktopRoomDeliveryRepair = {
      token: deliveryRepairToken as number,
      messages: [{
        id: "msg_3",
        sender: "EmmyMay",
        source: "browser",
        text: "recovered target",
        timestamp: "2026-08-11T10:01:00.000Z",
        agentPromptKind: "mention",
        actorLabel: "EmmyMay",
        agentIdentity: null,
        replyTo: null,
        threadRootId: "",
        threadReplyToId: null,
        thread: null,
        attachments: [],
      }],
      tasks: [recoveredTask],
    };
    repairDesktopRoomStreamManagedDelivery(ROOM, repair);
    repairDesktopRoomStreamManagedDelivery(ROOM, repair);

    const repairedEvents = managedEmitted.slice(managedStart);
    assert.equal(repairedEvents.filter(
      (event) => event.type === "message" && event.message.id === "msg_2",
    ).length, 1);
    assert.equal(repairedEvents.filter(
      (event) => event.type === "message" && event.message.id === "msg_3",
    ).length, 1);
    assert.equal(repairedEvents.filter(
      (event) => event.type === "task_update" && event.task.id === "task_recovered",
    ).length, 1);

    router.enqueueCatchUp([]);
    sse.error();
    await waitUntil(() => router.streamCalls.length === 2, 4_000);
    assert.equal(
      router.streamCalls[1]?.headers.get("Last-Event-ID"),
      "broker_repair_4",
      "later live cursors stay staged until both managed-delivery repairs finish",
    );
    reconnected.close();
  } finally {
    router.restore();
    await stopDesktopRoomStream();
  }
});
