import type { Response } from "express";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// A consumer this far behind is not draining its socket; buffering more server
// memory will not save it. Drop the connection and let it reconnect + catch up
// via its message cursor.
const SSE_MAX_BUFFERED_BYTES = 1024 * 1024;

export function startSseStream(res: Response): NodeJS.Timeout {
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
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
}

export function createSseWriter(res: Response, label: string): (chunk: string) => void {
  return (chunk: string) => {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    res.write(chunk);
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      console.error(
        `[sse] closing slow consumer (${label}): ${res.writableLength} bytes buffered`
      );
      res.destroy();
    }
  };
}

export function stopSseStream(res: Response, heartbeat: NodeJS.Timeout): void {
  clearInterval(heartbeat);
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}
