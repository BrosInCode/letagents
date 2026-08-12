import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { Response } from "express";

import { createSseWriter, openSseConnection, waitForSseCleanupDrain } from "../http/sse.js";

function fakeSseResponse(options?: { writableLength?: number }) {
  return Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: options?.writableLength ?? 0,
    writableNeedDrain: false,
    chunks: [] as string[],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
  });
}

test("createSseWriter forwards writes while the consumer keeps up", async () => {
  const res = fakeSseResponse();
  const write = createSseWriter(res as unknown as Response, "test");
  await write("data: {}\n\n");
  assert.deepEqual(res.chunks, ["data: {}\n\n"]);
  assert.equal(res.destroyed, false);
});

test("createSseWriter drops writes after the stream ends", async () => {
  const res = fakeSseResponse();
  res.writableEnded = true;
  const write = createSseWriter(res as unknown as Response, "test");
  await write("data: {}\n\n");
  assert.deepEqual(res.chunks, []);
});

test("createSseWriter destroys slow consumers once the buffer cap is exceeded", async () => {
  const res = fakeSseResponse({ writableLength: 2 * 1024 * 1024 });
  const write = createSseWriter(res as unknown as Response, "test");
  await write("data: {}\n\n");
  assert.equal(res.destroyed, true);
  // Subsequent writes are dropped instead of buffering more memory.
  await write("data: {}\n\n");
  assert.deepEqual(res.chunks, ["data: {}\n\n"]);
});

test("createSseWriter waits for socket drain before accepting the next event", async () => {
  const res = fakeSseResponse();
  res.write = function write(chunk: string) {
    this.chunks.push(chunk);
    this.writableNeedDrain = true;
    return false;
  };
  const write = createSseWriter(res as unknown as Response, "test");
  let settled = false;
  const pending = write("data: first\n\n").then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  res.writableNeedDrain = false;
  res.emit("drain");
  await pending;
  assert.equal(settled, true);
});

test("openSseConnection centralizes close listeners, heartbeat, and cleanup", async () => {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    writableNeedDrain: false,
    chunks: [] as string[],
    socket: { setKeepAlive() {} },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const connection = openSseConnection(
    req as unknown as Parameters<typeof openSseConnection>[0],
    res as unknown as Response,
    "test connection",
  );
  let cleanups = 0;
  connection.addCleanup(() => { cleanups += 1; });

  assert.equal(req.listenerCount("close"), 1);
  assert.equal(res.listenerCount("close"), 1);
  req.emit("close");
  res.emit("close");
  connection.close();

  assert.equal(connection.closed, true);
  assert.equal(cleanups, 1);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.writableEnded, true);
  assert.match(res.chunks.join(""), /: connected/);
});

test("the shutdown cleanup drain waits for durable SSE disconnect work", async () => {
  const req = new EventEmitter();
  const res = Object.assign(fakeSseResponse(), {
    socket: { setKeepAlive() {} },
    setHeader() {},
    flushHeaders() {},
    end() { this.writableEnded = true; },
  });
  let release!: () => void;
  let cleaned = false;
  const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
  const connection = openSseConnection(
    req as unknown as Parameters<typeof openSseConnection>[0],
    res as unknown as Response,
    "cleanup drain",
  );
  connection.addCleanup(async () => {
    await cleanupGate;
    cleaned = true;
  });
  connection.close();
  let drained = false;
  const drain = waitForSseCleanupDrain().then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await drain;
  assert.equal(cleaned, true);
});

test("a response that never drains is closed on a bounded deadline with all resources released", async () => {
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: 1,
    writableNeedDrain: false,
    socket: { setKeepAlive() {} },
    setHeader() {},
    flushHeaders() {},
    write() {
      this.writableNeedDrain = true;
      return false;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
    },
  });
  const connection = openSseConnection(
    req as unknown as Parameters<typeof openSseConnection>[0],
    res as unknown as Response,
    "hung test connection",
    { drainTimeoutMs: 5 },
  );
  let cleanups = 0;
  connection.addCleanup(() => { cleanups += 1; });

  assert.equal(await connection.write("data: stalled\n\n"), false);
  assert.equal(connection.closed, true);
  assert.equal(res.destroyed, true);
  assert.equal(cleanups, 1);
  assert.equal(req.listenerCount("close"), 0);
  assert.equal(res.listenerCount("close"), 0);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(res.listenerCount("error"), 0);
});
