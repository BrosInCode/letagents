import assert from "node:assert/strict";
import test from "node:test";

import { SseClient, type Message, type SseGap } from "../sse-client.js";

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
  const client = new SseClient("https://example.test");
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
  const client = new SseClient("https://example.test");
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
