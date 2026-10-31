import assert from "node:assert/strict";
import test from "node:test";
import { createGiphyClient } from "../../../shared/giphy-client.mjs";
import { normalizeRoomGif, roomGifPageUrl, validReplyGifIntent } from "../../../shared/room-expressions.mjs";

const data = { rating: "pg", id: "abc123", title: "Small win", images: {
  fixed_height_small: { url: "https://media.giphy.com/media/abc123/100.gif?cid=keep-me" },
  fixed_height_still: { url: "https://media.giphy.com/media/abc123/200_s.gif" },
  downsized: { url: "https://media.giphy.com/media/abc123/giphy.gif" },
} };
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });
test("GIPHY search is direct, preserves the exact query, order and media URLs", async () => {
  let requested: URL | undefined;
  const client = createGiphyClient({ fetchImpl: (async (url, options) => {
    requested = new URL(String(url));
    assert.equal(options?.cache, "no-store"); assert.equal(options?.credentials, "omit");
    return response({ meta: { status: 200 }, data: [data, { ...data, id: "second" }], pagination: { offset: 0, count: 2, total_count: 3 } });
  }) as typeof fetch });
  const result = await client.search("private-key", "a & b @artist");
  assert.equal(requested!.origin, "https://api.giphy.com");
  assert.equal(requested!.searchParams.get("q"), "a & b @artist");
  assert.equal(requested!.searchParams.get("rating"), "pg");
  assert.ok(result.ok); assert.deepEqual(result.items.map(item => item.id), ["abc123", "second"]);
  assert.equal(result.items[0].preview_url, data.images.fixed_height_small.url);
  assert.equal(result.next_offset, 2);
  assert.ok(!JSON.stringify(result).includes("private-key"));
});
test("quota exhaustion returns promptly and cools down subsequent calls without retries", async () => {
  let calls = 0; let time = 1000;
  const client = createGiphyClient({ now: () => time, fetchImpl: (async () => {
    calls++; return new Response("", { status: 429, headers: { "Retry-After": "120" } });
  }) as typeof fetch });
  assert.deepEqual(await client.search("key", "yes"), await client.resolve("key", "abc123"));
  assert.equal(calls, 1);
  time += 120_001;
  await client.search("key", "yes"); assert.equal(calls, 2);
});
for (const status of [401, 403, 500, 503]) test(`provider ${status} is a recoverable result and never leaks response details`, async () => {
  let calls = 0;
  const client = createGiphyClient({ fetchImpl: (async () => { calls++; return new Response("secret-provider-data", { status }); }) as typeof fetch });
  const result = await client.search("secret-key", "yes");
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes("secret"));
  await client.search("secret-key", "yes"); assert.equal(calls, 1);
});
test("a timed-out or offline request cannot stall work or disclose its URL", async () => {
  const client = createGiphyClient({ timeoutMs: 10, fetchImpl: (async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("https://api.giphy.com?api_key=secret")), { once: true });
  })) as typeof fetch });
  const result = await client.search("secret", "yes");
  assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes("secret"));
});
test("missing key and invalid input never make a request", async () => {
  const client = createGiphyClient({ fetchImpl: (async () => { throw new Error("must not fetch"); }) as typeof fetch });
  assert.equal((await client.search("", "yes")).ok, false);
  assert.equal((await client.search("key", "a".repeat(51))).ok, false);
  assert.equal((await client.resolve("key", "../bad")).ok, false);
});
test("broken payloads and removed GIFs remain recoverable; unsafe media are not loaded", async () => {
  for (const payload of [{ meta: { status: 404 }, data: [] }, { meta: { status: 200 }, data: [null] }]) {
    const client = createGiphyClient({ fetchImpl: (async () => response(payload)) as typeof fetch });
    assert.equal((await client.resolve("key", "abc123")).ok, false);
  }
  const client = createGiphyClient({ fetchImpl: (async () => response({ meta: { status: 200 }, data: { ...data, images: { fixed_height_small: { url: "http://localhost/private" } } } })) as typeof fetch });
  const result = await client.resolve("key", "abc123");
  assert.ok(result.ok); assert.equal(result.items[0].preview_url, null);
  assert.deepEqual(normalizeRoomGif({ ...data, provider: "giphy", api_key: "secret" }), { provider: "giphy", id: "abc123", title: "Small win" });
  assert.equal(roomGifPageUrl({ provider: "giphy", id: "abc123" }), "https://giphy.com/gifs/abc123");
});

test("reply GIF intents reject unknown nested fields before durable journaling", () => {
  const gif = { provider: "giphy", id: "abc123", title: "Small win" };
  assert.equal(validReplyGifIntent({ gif }), true);
  assert.equal(validReplyGifIntent({ gif: null }), true);
  for (const extra of [{ api_key: "secret" }, { media_url: "https://media.giphy.com/gif" }, { title: 42 }, { title: "a".repeat(201) }, { text_fallback_only: false }]) {
    assert.equal(validReplyGifIntent({ gif: { ...gif, ...extra } }), false);
  }
  assert.equal(validReplyGifIntent({ gif, room_id: "other" }), false);
});
