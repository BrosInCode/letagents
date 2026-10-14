import assert from "node:assert/strict";
import test from "node:test";
import { productionSupervisedDeliveryHttp } from "../cloud-http.js";

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
      await assert.rejects(productionSupervisedDeliveryHttp.context!(input), new RegExp(`HTTP ${code}`));
    }
    const before = calls;
    assert.equal(await productionSupervisedDeliveryHttp.context!({ ...input, apiUrl: "letagents-local://rooms" }), null);
    assert.equal(calls, before);
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
    await assert.rejects(productionSupervisedDeliveryHttp.context!(input), /timeout|timed out/i);
    assert.equal(aborts, 2);
  } finally { clearInterval(keepAlive); globalThis.fetch = prior; }
});
