import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";

// A real HTTP server stands in for the API, so the client is tested over a socket.
const responders: Array<(res: ServerResponse, auth: string | undefined) => void> = [];
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(req.url ?? "");
  const respond = responders.shift();
  if (!respond) { res.writeHead(503).end(); return; }
  respond(res, req.headers.authorization);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

let token: string | null = "session-token";
const published: Array<{ channel: string; payload: any }> = [];
mock.module("../main/auth.js", { namedExports: { readStoredAuth: async () => ({ token }) } });
mock.module("../main/paths.js", { namedExports: { apiUrl } });
mock.module("../main/window.js", {
  namedExports: { emitToMainWindow: (channel: string, payload: unknown) => published.push({ channel, payload }) },
});
const stream = await import("../main/account-activity-stream.js");

before(() => { published.length = 0; });
after(async () => {
  stream.stopAccountActivityStream();
  await new Promise((resolve) => server.close(resolve));
});

function sse(res: ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.write(": connected\n\n");
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("a snapshot, then single-room changes, reach the window as one current state", async () => {
  let send!: (event: string, data: unknown) => void;
  let seenAuth: string | undefined;
  responders.push((res, auth) => { seenAuth = auth; send = sse(res); });
  stream.restartAccountActivityStream();
  await until(() => Boolean(send), "the stream to open");
  assert.equal(seenAuth, "Bearer session-token");
  assert.equal(requests.at(-1), "/account/activity/stream");

  send("snapshot", { rooms: [
    { room_id: "github.com/org/repo", latest_message_id: "msg_4", latest_message_at: "2026-10-01T09:00:00.000Z", working: [] },
    { room_id: "focus_1", latest_message_id: null, latest_message_at: null, working: [{ agent_key: "k1", display_name: "MapleRidge" }] },
  ] });
  await until(() => stream.getAccountActivityState().connected, "the snapshot");
  assert.deepEqual(stream.getAccountActivityState().rooms.focus_1.working, [{ displayName: "MapleRidge" }]);

  send("room", { room_id: "focus_1", latest_message_id: "msg_2", latest_message_at: null, working: [] });
  await until(() => stream.getAccountActivityState().rooms.focus_1.working.length === 0, "the room change");
  assert.equal(stream.getAccountActivityState().rooms.focus_1.latestMessageId, "msg_2");
  assert.equal(stream.getAccountActivityState().rooms["github.com/org/repo"].latestMessageId, "msg_4", "other rooms are kept");
  assert.ok(published.every((entry) => entry.channel === "desktop:account-activity:changed"));
  assert.deepEqual(published.at(-1)?.payload, stream.getAccountActivityState());
});

test("frames that are not activity are ignored, not trusted", async () => {
  let send!: (event: string, data: unknown) => void;
  responders.push((res) => { send = sse(res); });
  stream.restartAccountActivityStream();
  await until(() => Boolean(send), "the stream to open");
  send("snapshot", { rooms: [{ room_id: "room-a", working: [{ display_name: "Oak" }, { display_name: 7 }, null] }, { nope: true }] });
  await until(() => stream.getAccountActivityState().connected, "the snapshot");
  assert.deepEqual(Object.keys(stream.getAccountActivityState().rooms), ["room-a"]);
  assert.deepEqual(stream.getAccountActivityState().rooms["room-a"].working, [{ displayName: "Oak" }]);
});

test("a dropped stream is shown as disconnected and reconnects by itself", async () => {
  let first!: ServerResponse;
  let secondOpened = false;
  responders.push((res) => { first = res; sse(res)("snapshot", { rooms: [] }); });
  responders.push((res) => { secondOpened = true; sse(res)("snapshot", { rooms: [] }); });
  stream.restartAccountActivityStream();
  await until(() => stream.getAccountActivityState().connected, "the first connection");
  first.end();
  await until(() => !stream.getAccountActivityState().connected, "the drop to be noticed");
  await until(() => secondOpened && stream.getAccountActivityState().connected, "the reconnect");
});

test("signed out, or with a refused token, it stays closed instead of retrying", async () => {
  const before = requests.length;
  token = null;
  stream.restartAccountActivityStream();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(requests.length, before, "no request without a session");
  assert.equal(stream.getAccountActivityState().connected, false);

  token = "session-token";
  responders.push((res) => res.writeHead(401).end());
  stream.restartAccountActivityStream();
  await until(() => requests.length === before + 1, "the refused request");
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(requests.length, before + 1, "a 401 is not retried");
});

test("a server without the stream is asked again, but only rarely", async () => {
  const original = stream.accountActivityTiming.missingStreamRetryMs;
  stream.accountActivityTiming.missingStreamRetryMs = 300;
  try {
    const before = requests.length;
    responders.push((res) => res.writeHead(404).end());
    responders.push((res) => sse(res)("snapshot", { rooms: [] }));
    stream.restartAccountActivityStream();
    await until(() => requests.length === before + 1, "the missing stream");
    assert.equal(stream.getAccountActivityState().connected, false);
    await until(() => stream.getAccountActivityState().connected, "the later retry");
  } finally {
    stream.accountActivityTiming.missingStreamRetryMs = original;
  }
});

test("a connection that goes silent is dropped and opened again", async () => {
  const original = stream.accountActivityTiming.idleTimeoutMs;
  stream.accountActivityTiming.idleTimeoutMs = 300;
  try {
    const before = requests.length;
    // The first server sends a snapshot and then nothing, not even heartbeats.
    responders.push((res) => sse(res)("snapshot", { rooms: [] }));
    responders.push((res) => sse(res)("snapshot", { rooms: [] }));
    stream.restartAccountActivityStream();
    await until(() => stream.getAccountActivityState().connected, "the first connection");
    await until(() => !stream.getAccountActivityState().connected, "the silence to be noticed");
    await until(() => requests.length === before + 2 && stream.getAccountActivityState().connected, "the reconnect");
  } finally {
    stream.accountActivityTiming.idleTimeoutMs = original;
    stream.stopAccountActivityStream();
  }
});

test("stopping clears the state and ends the connection", async () => {
  responders.push((res) => sse(res)("snapshot", { rooms: [{ room_id: "room-a", working: [] }] }));
  stream.restartAccountActivityStream();
  await until(() => stream.getAccountActivityState().connected, "the snapshot");
  stream.stopAccountActivityStream();
  assert.deepEqual(stream.getAccountActivityState(), { connected: false, rooms: {} });
});
