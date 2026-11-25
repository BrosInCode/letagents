import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAttachmentText, readDesktopAttachmentText } from "../main/attachments/text-preview.js";
import { ATTACHMENT_PREVIEW_BYTE_LIMIT } from "../../../../shared/message-attachments.mjs";

test("loads text across chunk boundaries without changing cleartext", async () => {
  const original = "\uFEFFstartup ✓\r\n";
  const bytes = new TextEncoder().encode(original);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  assert.equal(await decodeAttachmentText(new Response(body)), original);
  assert.equal(await decodeAttachmentText(new Response(null)), "");
});

test("rejects unsafe targets, refused responses, binary data and oversized streams", async () => {
  assert.deepEqual(await readDesktopAttachmentText("https://example.invalid/results.txt"), { error: "Preview unavailable for this file." });
  await assert.rejects(decodeAttachmentText(new Response("internal detail", { status: 403 })), /Couldn’t load this file/);
  await assert.rejects(decodeAttachmentText(new Response(Uint8Array.of(0xff))), /isn’t UTF-8 text/);
  await assert.rejects(decodeAttachmentText(new Response("a\0b")), /isn’t UTF-8 text/);
  await assert.rejects(decodeAttachmentText(new Response("short body", {
    headers: { "Content-Length": String(ATTACHMENT_PREVIEW_BYTE_LIMIT + 1) },
  })), /too large/);
  await assert.rejects(decodeAttachmentText(new Response(new Uint8Array(ATTACHMENT_PREVIEW_BYTE_LIMIT + 1))), /too large/);
});

test("cancels a stalled attachment stream on timeout", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const result = decodeAttachmentText(new Response(new ReadableStream({ cancel() { cancelled = true; } })), controller.signal);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
});
