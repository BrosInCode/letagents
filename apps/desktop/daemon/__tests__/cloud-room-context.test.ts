import assert from "node:assert/strict";
import test from "node:test";
import { productionSupervisedDeliveryHttp } from "../cloud-http.js";
import { SupervisedRoomAuthorizationError } from "../supervised-agent-delivery.js";

const input = { apiUrl: "https://letagents.test", roomId: "room_1", bearer: "worker-only",
  signal: new AbortController().signal };

test("context reads use the exact worker and reject activation authority, wrong rooms and malformed results", async () => {
  const prior = globalThis.fetch;
  const messages = [{ id: "msg_189", text: "No borrowing or contact details", attachments: [],
    reply_to: { id: "msg_183", text: "Original request" } }];
  let body: unknown = { room_id: "room_1", context_only: true, messages };
  let status = 200;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://letagents.test/rooms/room_1/messages?before=latest&limit=30&context_only=true");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-only");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    assert.deepEqual(await productionSupervisedDeliveryHttp.context!(input), messages);
    body = { room_id: "room_1", messages };
    assert.equal(await productionSupervisedDeliveryHttp.context!(input), null, "old server is explicitly unsupported");
    for (const invalid of [null, {}, { room_id: "other", context_only: true, messages },
      { room_id: "room_1", context_only: false, messages },
      ...[null, {}, [{ id: "msg_189" }], [{ id: "msg_189", text: "hello", activation: {} }],
        Array.from({ length: 31 }, () => messages[0])].map(messages => ({ room_id: "room_1", context_only: true, messages }))]) {
      body = invalid;
      await assert.rejects(productionSupervisedDeliveryHttp.context!(input), /context response/);
    }
    for (const code of [401, 403, 500]) {
      status = code;
      await assert.rejects(productionSupervisedDeliveryHttp.context!(input), error => {
        assert.match(String(error), new RegExp(`HTTP ${code}`));
        if (code !== 500) {
          assert.ok(error instanceof SupervisedRoomAuthorizationError);
          assert.equal(error.status, code);
        }
        return true;
      });
    }
    const before = calls;
    assert.equal(await productionSupervisedDeliveryHttp.context!({ ...input, apiUrl: "letagents-local://rooms" }), null);
    assert.equal(calls, before);
  } finally { globalThis.fetch = prior; }
});

test("context accepts a slow successful connection within the normal cloud budget", async () => {
  const prior = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      init!.signal!.removeEventListener("abort", abort);
      resolve(new Response(JSON.stringify({ room_id: "room_1", context_only: true, messages: [] })));
    }, 6_000);
    const abort = () => { clearTimeout(timer); reject(init!.signal!.reason); };
    init!.signal!.addEventListener("abort", abort, { once: true });
  })) as typeof fetch;
  try {
    assert.deepEqual(await productionSupervisedDeliveryHttp.context!(input), []);
  } finally { globalThis.fetch = prior; }
});

test("context requests are cancelled by Stop and their own bounded deadline", async () => {
  const prior = globalThis.fetch;
  let aborts = 0;
  globalThis.fetch = (async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborts++; reject(init!.signal!.reason); }, { once: true });
  })) as typeof fetch;
  const keepAlive = setInterval(() => {}, 100);
  try {
    const stop = new AbortController();
    const pending = productionSupervisedDeliveryHttp.context!({ ...input, signal: stop.signal });
    stop.abort(new Error("Stopped"));
    await assert.rejects(pending, /Stopped/);
    await assert.rejects(productionSupervisedDeliveryHttp.context!(input), /Room context read.*TimeoutError/);
    assert.equal(aborts, 2);
  } finally { clearInterval(keepAlive); globalThis.fetch = prior; }
});

test("context body reads retain Stop cancellation and omit response text from errors", async () => {
  const prior = globalThis.fetch;
  let opened!: () => void;
  const bodyOpened = new Promise<void>(resolve => { opened = resolve; });
  globalThis.fetch = (async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
      opened();
    },
  }))) as typeof fetch;
  try {
    const stop = new AbortController();
    const pending = productionSupervisedDeliveryHttp.context!({ ...input, signal: stop.signal });
    await bodyOpened;
    stop.abort(new Error("Stopped during body"));
    await assert.rejects(pending, /Stopped during body/);
    globalThis.fetch = (async () => new Response("not-json-private-response")) as typeof fetch;
    await assert.rejects(productionSupervisedDeliveryHttp.context!(input), error => {
      assert.match(String(error), /Room context read failed during response/);
      assert.doesNotMatch(String(error), /private-response/);
      return true;
    });
  } finally { globalThis.fetch = prior; }
});

test("reply-turn yield uses only the authenticated scheduling operation and validates acknowledgment", async () => {
  const prior = globalThis.fetch;
  let body: unknown = { success: true, receipt_id: "receipt_1", reply_turn_yielded: true };
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://letagents.test/rooms/room_1/messages/msg_1/agent-receipts/self");
    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-only");
    assert.deepEqual(JSON.parse(String(init?.body)), { yield_reply_turn: true });
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
  try {
    const request = { ...input, sourceMessageId: "msg_1" };
    await productionSupervisedDeliveryHttp.yieldReplyTurn!(request);
    for (const invalid of [{ success: true, receipt_id: "receipt_1", receipt_state: "blocked" }, null, { success: true, reply_turn_yielded: true, receipt_id: "" }]) {
      body = invalid;
      await assert.rejects(productionSupervisedDeliveryHttp.yieldReplyTurn!(request), /not acknowledged/);
    }
    const before = calls;
    await productionSupervisedDeliveryHttp.yieldReplyTurn!({ ...request, sourceMessageId: "synthetic" });
    await productionSupervisedDeliveryHttp.yieldReplyTurn!({ ...request, apiUrl: "letagents-local://rooms" });
    assert.equal(calls, before);
  } finally { globalThis.fetch = prior; }
});

test("the history summary read is optional: none for an old server, off or local room; a failure throws for a later retry", async () => {
  const prior = globalThis.fetch;
  const line = { node: "3:0", level: 3, first_message_id: "msg_1", last_message_id: "msg_8", first_at: "2026-10-18T09:00:00.000Z",
    last_at: "2026-10-19T09:00:00.000Z", messages: 8, text: "Emmy and Ada chose Postgres.", pending: false };
  let body: unknown = { room_id: "room_1", state: "ready", note: "n", lines: [line], covered_through_message_id: "msg_8" };
  let status = 200;
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://letagents.test/rooms/room_1/history-summary?max_lines=60");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-only");
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    assert.deepEqual(await productionSupervisedDeliveryHttp.historySummary!(input), {
      lines: [{ node: "3:0", first_message_id: "msg_1", last_message_id: "msg_8", last_at: "2026-10-19T09:00:00.000Z",
        text: "Emmy and Ada chose Postgres.", pending: false }],
      covered_through_message_id: "msg_8",
    });
    for (const none of [{ ...body as object, state: "off", lines: [] }, { ...body as object, state: "unavailable", lines: [] },
      { ...body as object, lines: [] }, { ...body as object, room_id: "other" }, { ...body as object, lines: [{ ...line, node: "x" }] }]) {
      body = none;
      assert.equal(await productionSupervisedDeliveryHttp.historySummary!(input), null);
    }
    for (const code of [404, 409]) {
      status = code;
      assert.equal(await productionSupervisedDeliveryHttp.historySummary!(input), null, `HTTP ${code} means no summary`);
    }
    status = 503;
    await assert.rejects(productionSupervisedDeliveryHttp.historySummary!(input), /HTTP 503/);
    const before = calls;
    assert.equal(await productionSupervisedDeliveryHttp.historySummary!({ ...input, apiUrl: "letagents-local://rooms" }), null);
    assert.equal(calls, before);
  } finally { globalThis.fetch = prior; }
});
