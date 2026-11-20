import type { Request, Response } from "express";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// A consumer this far behind is not draining its socket; buffering more server
// memory will not save it. Drop the connection and let it reconnect + catch up
// via its message cursor.
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;
const SSE_DRAIN_TIMEOUT_MS = 10_000;
const inFlightSseCleanups = new Set<Promise<void>>();

/** Runs a stream cleanup that shutdown waits for; a failure is logged, never thrown. */
export function trackSseCleanup(cleanup: () => void | Promise<void>, label: string): void {
  let pending: Promise<void>;
  try {
    pending = Promise.resolve(cleanup()).catch((error: unknown) => {
      console.error(`[sse] cleanup failed (${label})`, error);
    });
  } catch (error) {
    console.error(`[sse] cleanup failed (${label})`, error);
    return;
  }
  inFlightSseCleanups.add(pending);
  void pending.finally(() => inFlightSseCleanups.delete(pending));
}

/** Drain durable delivery disconnects before the database pool is closed. */
export async function waitForSseCleanupDrain(): Promise<void> {
  while (inFlightSseCleanups.size > 0) {
    await Promise.allSettled([...inFlightSseCleanups]);
  }
}

function startSseStream(res: Response): NodeJS.Timeout {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx will otherwise buffer SSE in front of staging/production.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.socket?.setKeepAlive(true, SSE_HEARTBEAT_INTERVAL_MS);
  res.write(": connected\n\n");

  return setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    if (res.writableNeedDrain) return;
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
}

export interface SseWriterOptions {
  drainTimeoutMs?: number;
  /** Called when the writer drops a consumer that does not read fast enough. */
  onSlowConsumer?: (reason: "buffer_limit" | "drain_timeout") => void;
}

export function createSseWriter(
  res: Response,
  label: string,
  options: SseWriterOptions = {},
): (chunk: string) => Promise<boolean> {
  const drainTimeoutMs = Math.max(1, options.drainTimeoutMs ?? SSE_DRAIN_TIMEOUT_MS);
  return async (chunk: string) => {
    if (res.writableEnded || res.destroyed) {
      return false;
    }
    if (res.writableNeedDrain && !(await waitForDrain(res, label, drainTimeoutMs, options.onSlowConsumer))) return false;
    const accepted = res.write(chunk);
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      console.error(
        `[sse] closing slow consumer (${label}): ${res.writableLength} bytes buffered`
      );
      res.destroy();
      options.onSlowConsumer?.("buffer_limit");
      return false;
    }
    return accepted ? true : waitForDrain(res, label, drainTimeoutMs, options.onSlowConsumer);
  };
}

function waitForDrain(
  res: Response,
  label: string,
  timeoutMs: number,
  onSlowConsumer?: SseWriterOptions["onSlowConsumer"],
): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      console.error(`[sse] closing stalled consumer (${label}): drain timed out after ${timeoutMs}ms`);
      try {
        res.destroy();
      } finally {
        finish(false);
        onSlowConsumer?.("drain_timeout");
      }
    }, timeoutMs);
    timeout.unref?.();
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
    if (res.writableEnded || res.destroyed) finish(false);
  });
}

function stopSseStream(res: Response, heartbeat: NodeJS.Timeout): void {
  clearInterval(heartbeat);
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

export interface SseConnection {
  readonly closed: boolean;
  write(chunk: string): Promise<boolean>;
  tryWrite(chunk: string): boolean;
  addCleanup(cleanup: () => void | Promise<void>): void;
  close(): void;
}

/** Owns the one close path for socket, heartbeat, broker and delivery leases. */
export function openSseConnection(
  req: Pick<Request, "on" | "off">,
  res: Response,
  label: string,
  options: SseWriterOptions = {},
): SseConnection {
  const heartbeat = startSseStream(res);
  const writeChunk = createSseWriter(res, label, options);
  const cleanups = new Set<() => void | Promise<void>>();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    req.off?.("close", close);
    res.off?.("close", close);
    for (const cleanup of cleanups) {
      trackSseCleanup(cleanup, label);
    }
    cleanups.clear();
    stopSseStream(res, heartbeat);
  };
  req.on("close", close);
  res.on?.("close", close);

  return {
    get closed() { return closed; },
    tryWrite(chunk: string) {
      // Hints never queue, wait for drain, or close a connection.
      if (closed || res.writableEnded || res.destroyed || res.writableNeedDrain || res.writableLength > 0) return false;
      return res.write(chunk);
    },
    async write(chunk: string) {
      if (closed) return false;
      const accepted = await writeChunk(chunk);
      if (!accepted) close();
      return accepted;
    },
    addCleanup(cleanup) {
      if (closed) {
        trackSseCleanup(cleanup, `${label}, late`);
        return;
      }
      cleanups.add(cleanup);
    },
    close,
  };
}
