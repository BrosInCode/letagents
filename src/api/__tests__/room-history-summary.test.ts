import assert from "node:assert/strict";
import test from "node:test";

import { clipUtf8, parseRoomHistoryNodeId, utf8Bytes } from "../../../shared/room-history-summary.mjs";
import { planRoomHistoryView, type RoomHistoryPart } from "../history-summary/view-plan.js";
import {
  RoomHistorySummarizerError,
  readRoomHistorySummarizer,
  writeRoomHistoryLine,
  type RoomHistorySummarizerConfig,
} from "../history-summary/summarizer.js";

const span = (part: RoomHistoryPart) => 2 ** part.level;
const covered = (parts: RoomHistoryPart[]) => parts.flatMap((part) =>
  Array.from({ length: span(part) }, (_, offset) => part.idx * span(part) + offset));

test("a view covers every message once, oldest first, within its line budget", () => {
  for (const leafCount of [1, 2, 3, 7, 64, 100, 1000, 2047]) {
    for (const maxLines of [8, 40, 160]) {
      const { parts, omittedOlderLines } = planRoomHistoryView(leafCount, [], maxLines);
      assert.equal(omittedOlderLines, 0);
      assert.ok(parts.length <= Math.max(maxLines, Math.ceil(Math.log2(leafCount)) + 1), `${leafCount}/${maxLines}`);
      assert.deepEqual(covered(parts), Array.from({ length: leafCount }, (_, index) => index), `${leafCount}/${maxLines}`);
    }
  }
});

test("recent messages get their own lines and older stretches broader ones", () => {
  const { parts } = planRoomHistoryView(2000, [], 160);
  assert.equal(parts.at(-1)!.level, 0, "the newest message is its own line");
  assert.ok(parts[0]!.level >= 4, "the oldest stretch is a broad line");
  // Lines never get broader towards the end.
  for (let index = 1; index < parts.length; index += 1) {
    assert.ok(parts[index]!.level <= parts[index - 1]!.level + 1, JSON.stringify(parts.slice(index - 1, index + 1)));
  }
});

test("a line waiting for the summarizer is never shown; its messages are", () => {
  // Leaf 5 waits, so (1,2), (2,1) and (3,0) cannot have text.
  const { parts } = planRoomHistoryView(8, [{ level: 0, idx: 5 }], 8);
  assert.deepEqual(covered(parts), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(parts.some((part) => part.level === 0 && part.idx === 5));
  assert.ok(!parts.some((part) => part.level > 0 && part.idx * span(part) <= 5 && 5 < (part.idx + 1) * span(part)));
  // A higher line waiting splits too.
  const higher = planRoomHistoryView(16, [{ level: 2, idx: 1 }], 4).parts;
  assert.ok(!higher.some((part) => part.level >= 2 && part.idx * span(part) <= 4 && 4 < (part.idx + 1) * span(part)));
  assert.deepEqual(covered(higher), Array.from({ length: 16 }, (_, index) => index));
});

test("more waiting messages than the budget keep the newest lines", () => {
  const waiting = Array.from({ length: 50 }, (_, idx) => ({ level: 0, idx }));
  const { parts, omittedOlderLines } = planRoomHistoryView(50, waiting, 10);
  assert.equal(parts.length, 10);
  assert.equal(omittedOlderLines, 40);
  assert.deepEqual(parts.map((part) => part.idx), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
});

test("node ids and UTF-8 clipping", () => {
  assert.deepEqual(parseRoomHistoryNodeId("4:12"), { level: 4, index: 12 });
  assert.equal(parseRoomHistoryNodeId("41:0"), null);
  assert.equal(parseRoomHistoryNodeId("-1:2"), null);
  assert.equal(parseRoomHistoryNodeId("a:b"), null);
  const text = "é".repeat(300);
  const clipped = clipUtf8(text, 511);
  assert.ok(utf8Bytes(clipped) <= 511);
  assert.equal(clipped, "é".repeat(255));
  assert.equal(clipUtf8("short", 512), "short");
});

const config: RoomHistorySummarizerConfig = { apiKey: "test-key", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", timeoutMs: 1000 };
const message = { kind: "message" as const, messageId: "msg_7", sender: "Emmy", timestamp: "2026-10-19T10:00:00.000Z", threadRootId: null, text: "x".repeat(3000) };

function fakeFetch(answers: Array<{ status?: number; content?: string; finish_reason?: string }>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const answer = answers.shift() ?? { content: "ok" };
    return new Response(JSON.stringify({ choices: [{ finish_reason: answer.finish_reason ?? "stop", message: { content: answer.content ?? "" } }] }),
      { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("the summarizer reads its key and model from the environment, and is off without a key", () => {
  assert.equal(readRoomHistorySummarizer({}), null);
  assert.deepEqual(readRoomHistorySummarizer({ LETAGENTS_ROOM_HISTORY_API_KEY: " k " }),
    { apiKey: "k", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-6-luna", timeoutMs: 30_000 });
  assert.equal(readRoomHistorySummarizer({ LETAGENTS_ROOM_HISTORY_API_KEY: "k", LETAGENTS_ROOM_HISTORY_MODEL: "m",
    LETAGENTS_ROOM_HISTORY_BASE_URL: "https://example.test/v1/" })!.baseUrl, "https://example.test/v1");
});

test("one call writes one line, sent to OpenRouter with no data collection and the room text as data", async () => {
  const { fetchImpl, calls } = fakeFetch([{ content: "  \"Emmy asked for the release notes.\"\n" }]);
  assert.equal(await writeRoomHistoryLine(config, message, { fetchImpl }), "Emmy asked for the release notes.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0]!.headers.authorization, "Bearer test-key");
  assert.equal(calls[0]!.body.model, "openai/gpt-6-luna");
  assert.deepEqual(calls[0]!.body.provider, { data_collection: "deny" });
  const prompt = (calls[0]!.body.messages as Array<{ content: string }>)[1]!.content;
  assert.match(prompt, /msg_7 from Emmy/);
  assert.match(prompt, /<message>/);
  // Another OpenAI-compatible endpoint gets no OpenRouter-only fields.
  const other = fakeFetch([{ content: "fine" }]);
  await writeRoomHistoryLine({ ...config, baseUrl: "https://api.example.test/v1" }, message, { fetchImpl: other.fetchImpl });
  assert.equal(other.calls[0]!.body.provider, undefined);
  assert.equal(other.calls[0]!.body.reasoning, undefined);
});

test("a line too long is asked for once more, then clipped; a refusal gives the source clipped", async () => {
  const long = "word ".repeat(200);
  const twice = fakeFetch([{ content: long }, { content: long }]);
  const line = await writeRoomHistoryLine(config, message, { fetchImpl: twice.fetchImpl });
  assert.equal(twice.calls.length, 2);
  assert.ok(utf8Bytes(line) <= 512);
  const refused = fakeFetch([{ finish_reason: "content_filter", content: "" }]);
  assert.equal(await writeRoomHistoryLine(config, { ...message, text: "secret plans" }, { fetchImpl: refused.fetchImpl }), "Emmy: secret plans");
  const empty = fakeFetch([{ content: "   " }]);
  assert.equal(await writeRoomHistoryLine(config, { kind: "merge", firstMessageId: "msg_1", lastMessageId: "msg_4", left: "a", right: "b" },
    { fetchImpl: empty.fetchImpl }), "a b");
});

test("provider failures throw for a later retry, and never carry the provider's body", async () => {
  const limited = fakeFetch([{ status: 429, content: "room text echoed" }]);
  await assert.rejects(writeRoomHistoryLine(config, message, { fetchImpl: limited.fetchImpl }), (error: unknown) =>
    error instanceof RoomHistorySummarizerError && error.kind === "retry" && !error.message.includes("echoed"));
  const refusedKey = fakeFetch([{ status: 401 }]);
  await assert.rejects(writeRoomHistoryLine(config, message, { fetchImpl: refusedKey.fetchImpl }), (error: unknown) =>
    error instanceof RoomHistorySummarizerError && error.kind === "auth");
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  await assert.rejects(writeRoomHistoryLine(config, message, { fetchImpl: down }), (error: unknown) =>
    error instanceof RoomHistorySummarizerError && error.kind === "retry");
});
