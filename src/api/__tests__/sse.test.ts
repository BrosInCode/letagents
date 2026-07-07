import assert from "node:assert/strict";
import test from "node:test";

import type { Response } from "express";

import { createSseWriter } from "../http/sse.js";

function fakeSseResponse(options?: { writableLength?: number }) {
  return {
    writableEnded: false,
    destroyed: false,
    writableLength: options?.writableLength ?? 0,
    chunks: [] as string[],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("createSseWriter forwards writes while the consumer keeps up", () => {
  const res = fakeSseResponse();
  const write = createSseWriter(res as unknown as Response, "test");
  write("data: {}\n\n");
  assert.deepEqual(res.chunks, ["data: {}\n\n"]);
  assert.equal(res.destroyed, false);
});

test("createSseWriter drops writes after the stream ends", () => {
  const res = fakeSseResponse();
  res.writableEnded = true;
  const write = createSseWriter(res as unknown as Response, "test");
  write("data: {}\n\n");
  assert.deepEqual(res.chunks, []);
});

test("createSseWriter destroys slow consumers once the buffer cap is exceeded", () => {
  const res = fakeSseResponse({ writableLength: 2 * 1024 * 1024 });
  const write = createSseWriter(res as unknown as Response, "test");
  write("data: {}\n\n");
  assert.equal(res.destroyed, true);
  // Subsequent writes are dropped instead of buffering more memory.
  write("data: {}\n\n");
  assert.deepEqual(res.chunks, ["data: {}\n\n"]);
});
