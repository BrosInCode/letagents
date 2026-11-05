import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { LIVE_DEMO_PROTOCOL, parseLiveServerFrame } from '../../../shared/live-demo.mjs';

// A desktop app's live socket, for tests: real `ws` clients against a real
// HTTP server. Every frame received must parse as the app would parse it.

export type Opened =
  | { status: 101; ws: WebSocket; inbox: Inbox }
  | { status: number; body: any };

export type Inbox = ReturnType<typeof inbox>;

export function inbox(ws: WebSocket) {
  const frames: any[] = [];
  const waiters = new Set<{ match: (frame: any) => boolean; resolve: (frame: any) => void }>();
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data));
    assert.ok(parseLiveServerFrame(frame), `the app can read ${String(data)}`);
    for (const waiter of waiters) {
      if (waiter.match(frame)) { waiters.delete(waiter); waiter.resolve(frame); return; }
    }
    frames.push(frame);
  });
  return {
    frames,
    next(match: (frame: any) => boolean, ms = 3_000): Promise<any> {
      const index = frames.findIndex(match);
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('no matching frame')); }, ms);
        const waiter = { match, resolve: (frame: any) => { clearTimeout(timer); resolve(frame); } };
        waiters.add(waiter);
      });
    },
  };
}

export function openLive(
  port: number,
  path: string,
  options: { token?: string; protocol?: string | null; headers?: Record<string, string> } = {},
): Promise<Opened> {
  const protocols = options.protocol === null ? [] : [options.protocol ?? LIVE_DEMO_PROTOCOL];
  const headers = { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...options.headers };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
    const frames = inbox(ws);
    ws.once('open', () => resolve({ status: 101, ws, inbox: frames }));
    ws.once('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : null });
      });
    });
    ws.once('error', reject);
  });
}

/** An open live socket after its hello. */
export async function joinLive(port: number, room: string, token: string) {
  const opened = await openLive(port, `/rooms/${encodeURIComponent(room)}/live`, { token });
  assert.equal(opened.status, 101, `${token} opens ${room}`);
  const { ws, inbox: frames } = opened as Extract<Opened, { status: 101 }>;
  const hello = await frames.next((frame) => frame.t === 'hello');
  return { ws, frames, hello, send: (frame: unknown) => ws.send(JSON.stringify(frame)) };
}

export function closedWith(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
  });
}

export async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'condition met in time');
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
