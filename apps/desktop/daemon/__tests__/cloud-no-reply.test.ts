import assert from "node:assert/strict";
import test from "node:test";
import { productionSupervisedDeliveryHttp } from "../cloud-http.js";

test("no-reply transport uses the exact worker identity and requires an acknowledged receipt", async () => {
  const prior = globalThis.fetch;
  const input = { apiUrl: "https://letagents.test", roomId: "room_1", sourceMessageId: "msg_81", bearer: "worker-only",
    signal: new AbortController().signal };
  let calls = 0;
  let status = 200;
  let body: unknown = { success: true, receipt_id: "rcpt_1", receipt_state: "no_reply" };
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://letagents.test/rooms/room_1/messages/msg_81/agent-receipts/self");
    assert.equal(init?.method, "PUT");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer worker-only");
    assert.deepEqual(JSON.parse(String(init?.body)), { receipt_state: "no_reply" });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    await productionSupervisedDeliveryHttp.reportNoReply!(input);
    for (const malformed of [null, {}, { messages: [] }, { success: true, receipt_state: "no_reply" },
      { success: true, receipt_id: "rcpt_1", receipt_state: "replied" }]) {
      body = malformed;
      await assert.rejects(productionSupervisedDeliveryHttp.reportNoReply!(input), /not acknowledged/);
    }
    status = 409;
    await assert.rejects(productionSupervisedDeliveryHttp.reportNoReply!(input), /HTTP 409/);
    const before = calls;
    await productionSupervisedDeliveryHttp.reportNoReply!({ ...input, apiUrl: "letagents-local://rooms" });
    await productionSupervisedDeliveryHttp.reportNoReply!({ ...input, sourceMessageId: "initial:1" });
    assert.equal(calls, before);
  } finally { globalThis.fetch = prior; }
});

test("no-reply transport aborts stalled requests within its own deadline", async () => {
  const prior = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted = true; reject(init!.signal!.reason); }, { once: true });
  })) as typeof fetch;
  // AbortSignal.timeout is unref'd. Keep the synthetic hanging fetch alive as a real socket would.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(productionSupervisedDeliveryHttp.reportNoReply!({ apiUrl: "https://letagents.test", roomId: "room_1",
      sourceMessageId: "msg_81", bearer: "worker-only", signal: new AbortController().signal }), /timeout|timed out/i);
    assert.equal(aborted, true);
  } finally { clearInterval(keepAlive); globalThis.fetch = prior; }
});
