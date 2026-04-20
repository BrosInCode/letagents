import type { Response } from "express";

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

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
    if (res.writableEnded) {
      return;
    }
    res.write(": heartbeat\n\n");
  }, SSE_HEARTBEAT_INTERVAL_MS);
}

export function stopSseStream(res: Response, heartbeat: NodeJS.Timeout): void {
  clearInterval(heartbeat);
  if (!res.writableEnded) {
    res.end();
  }
}
