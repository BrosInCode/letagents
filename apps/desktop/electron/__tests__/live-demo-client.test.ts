import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { WebSocketServer } from "ws";

import type { DesktopLiveDemoEvent } from "../ipc-types.js";
import {
  connectLiveDemoSocket,
  LIVE_DEMO_CLOSE_REPLACED,
  LIVE_DEMO_IDLE_CLOSE_MS,
  LIVE_DEMO_PING_MS,
  LIVE_DEMO_REJOIN_MAX_MS,
  LIVE_DEMO_REJOIN_MIN_MS,
  LIVE_DEMO_REJOIN_MS,
  LIVE_DEMO_RETRY_MAX_MS,
  LIVE_DEMO_STABLE_MS,
  LiveDemoClient,
  liveDemoRejoinDelayMs,
  liveDemoRetryDelayMs,
  liveDemoSocketUrl,
  type LiveDemoPointer,
} from "../main/rooms/live-demo-client.js";

const ROOM = "github.com/BrosInCode/letagents";
const DEMO = "msg_1/att_1";
const OTHER = "msg_2/att_2";

/** A `ws` socket the test drives: it opens, closes and answers only when told to. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  pings = 0;
  /** A live server answers every ping. */
  answersPings = true;
  closedWith: number | null = null;
  terminated = false;
  constructor(readonly url: string, readonly token: string, readonly clientId: string) { super(); }
  send(data: string) {
    assert.equal(this.readyState, 1, "nothing is sent on a socket that is not open");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  ping() {
    this.pings += 1;
    if (this.answersPings) this.emit("pong");
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    this.emit("close", code);
  }
  terminate() {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit("error", new Error("terminated"));
    this.emit("close", 1006);
  }
  open() { this.readyState = 1; this.emit("open"); }
  serverClose(code: number) { this.readyState = 3; this.emit("close", code); }
  refuse(statusCode: number) { this.emit("unexpected-response", {}, { statusCode }); }
  receive(frame: unknown, isBinary = false) {
    this.emit("message", Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame)), isBinary);
  }
  types() { return this.sent.map((frame) => `${frame.t}:${frame.demo}`); }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { token?: string | null; cloudRoom?: string | null } = {}) {
  const sockets: FakeSocket[] = [];
  const events: DesktopLiveDemoEvent[] = [];
  const pointers = new Map<string, (pointer: LiveDemoPointer) => void>();
  const unwatched: string[] = [];
  const state = { token: options.token === undefined ? "app_session" : options.token };
  const client = new LiveDemoClient({
    apiUrl: "https://api.example.test/",
    connect: (url, token, clientId) => {
      const socket = new FakeSocket(url, token, clientId);
      sockets.push(socket);
      return socket;
    },
    cloudRoom: async (room) => (options.cloudRoom === undefined ? room : options.cloudRoom),
    token: async () => state.token,
    emit: (event) => events.push(event),
    watchPointer: (leaseUrl, listener) => {
      pointers.set(leaseUrl, listener);
      return () => {
        unwatched.push(leaseUrl);
        if (pointers.get(leaseUrl) === listener) pointers.delete(leaseUrl);
      };
    },
    // The longest wait each time, so the test knows exactly when a retry comes.
    random: () => 1,
  });
  const statuses = () => events.flatMap((event) => (event.type === "status" ? [event.reason ? `${event.status} (${event.reason})` : event.status] : []));
  const frames = () => events.flatMap((event) => (event.type === "frame" ? [event.frame] : []));
  return { client, sockets, events, pointers, unwatched, state, statuses, frames, last: () => sockets.at(-1)! };
}

const presence = (demo: string) => ({ t: "presence", demo, people: [{ cid: "c_abcd", name: "Ada", color: "#e5484d" }] });

test("the socket URL keeps the room id as one encoded segment and uses wss for https", () => {
  assert.equal(liveDemoSocketUrl("https://letagents.chat", ROOM), "wss://letagents.chat/rooms/github.com%2FBrosInCode%2Fletagents/live");
  assert.equal(liveDemoSocketUrl("http://127.0.0.1:3000/", "focus_27"), "ws://127.0.0.1:3000/rooms/focus_27/live");
});

test("the retry wait doubles from a second, has jitter, and stops growing at the cap", () => {
  assert.equal(liveDemoRetryDelayMs(0, () => 0), 500);
  assert.equal(liveDemoRetryDelayMs(0, () => 1), 1000);
  assert.equal(liveDemoRetryDelayMs(3, () => 1), 8000);
  assert.equal(liveDemoRetryDelayMs(5, () => 1), LIVE_DEMO_RETRY_MAX_MS);
  assert.equal(liveDemoRetryDelayMs(500, () => 1), LIVE_DEMO_RETRY_MAX_MS);
  assert.equal(liveDemoRetryDelayMs(500, () => 0), LIVE_DEMO_RETRY_MAX_MS / 2);
});

test("one socket per room carries the app's bearer, and every join is sent again after a reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  h.client.join(` ${ROOM} `, OTHER, null);
  await settle();
  assert.equal(h.sockets.length, 1, "both demos share the room's socket");
  assert.equal(h.last().url, "wss://api.example.test/rooms/github.com%2FBrosInCode%2Fletagents/live");
  assert.equal(h.last().token, "app_session");
  assert.deepEqual(h.statuses(), ["connecting"]);
  h.last().open();
  assert.deepEqual(h.last().types(), [`join:${DEMO}`, `join:${OTHER}`]);
  assert.deepEqual(h.statuses(), ["connecting", "live"]);

  h.last().serverClose(1006);
  assert.deepEqual(h.statuses(), ["connecting", "live", "reconnecting"]);
  t.mock.timers.tick(999);
  await settle();
  assert.equal(h.sockets.length, 1, "the first retry waits a second");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(h.sockets.length, 2);
  h.last().open();
  assert.deepEqual(h.last().types(), [`join:${DEMO}`, `join:${OTHER}`], "joins survive the reconnect");
  assert.equal(h.statuses().at(-1), "live");

  // A connection the server drops at once does not reset the backoff; a stable one does.
  h.last().serverClose(1011);
  t.mock.timers.tick(1999);
  await settle();
  assert.equal(h.sockets.length, 2, "the second retry waits two seconds");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(h.sockets.length, 3);
  h.last().serverClose(1006);
  t.mock.timers.tick(4000);
  await settle();
  assert.equal(h.sockets.length, 4, "the third waits four");
  h.last().open();
  t.mock.timers.tick(LIVE_DEMO_STABLE_MS);
  h.last().receive(presence(DEMO));
  h.last().serverClose(1001);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(h.sockets.length, 5, "after a stable connection the wait starts over at a second");
});

test("only valid frames for joined demos reach the chat", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  await settle();
  h.last().open();
  const valid = [
    { t: "hello", cid: "c_self", name: "Me", color: "#46a758" },
    presence(DEMO),
    { t: "cur", demo: DEMO, cid: "c_abcd", x: 10.5, y: 4000 },
    { t: "cur", demo: DEMO, cid: "c_abcd", gone: true },
    { t: "ink", demo: DEMO, cid: "c_abcd", id: "stroke_0001", pts: [[1, 2], [3, 4]] },
    { t: "unmark", demo: DEMO, id: "mark_00001" },
    { t: "error", code: "demo_not_found", message: "That demo is gone." },
  ];
  for (const frame of valid) h.last().receive(frame);
  h.last().receive({ t: "cur", demo: DEMO, cid: "c_abcd", x: 761, y: 4 });
  h.last().receive({ t: "ink", demo: DEMO, cid: "c_abcd", id: "short", pts: [] });
  h.last().receive({ t: "presence", demo: OTHER, people: [] });
  h.last().receive({ t: "shout", demo: DEMO });
  h.last().receive("not json");
  h.last().receive(presence(DEMO), true);
  assert.deepEqual(h.frames(), valid);
  assert.ok(h.events.every((event) => event.roomIdentifier === ROOM));
});

test("a refusal stops retrying until the chat joins again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  await settle();
  h.last().refuse(403);
  assert.equal(h.last().terminated, true, "the refused upgrade is dropped");
  assert.deepEqual(h.statuses(), ["connecting", "refused (You are not a member of this room.)"]);
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(h.sockets.length, 1, "no retry after a refusal");

  h.client.join(ROOM, DEMO, null);
  await settle();
  assert.equal(h.sockets.length, 2, "the next join tries again");
  assert.equal(h.statuses().at(-1), "connecting");
  h.last().open();
  h.last().serverClose(4403);
  assert.equal(h.statuses().at(-1), "refused (You are not a member of this room.)", "a revoked membership closes with 4403");
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(h.sockets.length, 2);

  h.client.join(ROOM, OTHER, null);
  await settle();
  h.last().refuse(401);
  assert.equal(h.statuses().at(-1), "refused (Your sign-in has expired.)");
  assert.deepEqual(h.client.inspect(ROOM)?.demos, [DEMO, OTHER], "the joins stay for the next try");

  // A room the server does not know, or a protocol it does not speak, gets the same answer every time.
  h.client.join(ROOM, DEMO, null);
  await settle();
  h.last().refuse(404);
  assert.equal(h.statuses().at(-1), "refused (This room is not on the server.)");
  h.client.join(ROOM, DEMO, null);
  await settle();
  h.last().refuse(400);
  assert.equal(h.statuses().at(-1), "refused (Update LetAgents to see who is here.)");

  // A server that is down, busy, or restarting is not a refusal.
  for (const refuse of [(socket: FakeSocket) => socket.refuse(502), (socket: FakeSocket) => socket.refuse(429), (socket: FakeSocket) => socket.refuse(503)]) {
    h.client.join(ROOM, DEMO, null);
    await settle();
    refuse(h.last());
    assert.equal(h.statuses().at(-1), "reconnecting");
  }
  for (const code of [1001, 1008, 1013]) {
    t.mock.timers.tick(LIVE_DEMO_RETRY_MAX_MS);
    await settle();
    h.last().open();
    h.last().serverClose(code);
    assert.equal(h.statuses().at(-1), "reconnecting", String(code));
  }
});

const SELF = { cid: "c_self", name: "Me", color: "#46a758" };
const peer = { cid: "c_peer", name: "Bea", color: "#0090ff" };
const hello = { t: "hello", ...SELF };
const presenceOf = (demo: string, people: unknown[]) => ({ t: "presence", demo, people });

test("a join the server refuses for one demo is asked again once, after the wait it gives", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  h.client.join(ROOM, OTHER, null);
  await settle();
  const socket = h.last();
  socket.open();
  socket.receive(hello);
  socket.receive(presenceOf(OTHER, [SELF, peer]));
  socket.sent.length = 0;
  socket.receive({ t: "error", code: "rate_limited", message: "Too many demos opened at once.", demo: DEMO, retry_after_ms: 2000 });
  socket.receive({ t: "error", code: "rate_limited", message: "Too many demos opened at once.", demo: DEMO, retry_after_ms: 2000 });
  socket.receive({ t: "error", code: "demo_not_found", message: "No such demo.", demo: OTHER });
  assert.equal(h.frames().filter((frame) => frame.t === "error").length, 3, "the chat hears every refusal");
  // The harness's jitter is the largest: a quarter more than the wait.
  t.mock.timers.tick(2499);
  assert.deepEqual(socket.types(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(socket.types(), [`join:${DEMO}`], "once; the confirmed demo is not joined again");
  socket.receive({ t: "error", code: "unavailable", message: "Try again.", demo: DEMO });
  h.client.leave(ROOM, DEMO);
  t.mock.timers.tick(LIVE_DEMO_REJOIN_MAX_MS);
  assert.deepEqual(socket.types(), [`join:${DEMO}`, `leave:${DEMO}`], "a demo that was left is not joined again");
});

test("one rate_limited error with no demo sends every unconfirmed join again, once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  const [a, b, c] = ["msg_1/att_1", "msg_2/att_2", "msg_3/att_3"];
  for (const demo of [a, b, c]) h.client.join(ROOM, demo, null);
  await settle();
  const socket = h.last();
  socket.open();
  assert.deepEqual(socket.types(), [`join:${a}`, `join:${b}`, `join:${c}`]);
  socket.receive(hello);
  socket.receive(presenceOf(a, [peer, SELF]));
  // Presence that lists only others does not confirm this app's join.
  socket.receive(presenceOf(b, [peer]));
  socket.sent.length = 0;
  const burst = { t: "error", code: "rate_limited", message: "Too many demos opened at once.", retry_after_ms: 4000 };
  socket.receive(burst);
  socket.receive(burst);
  assert.deepEqual(h.frames().filter((frame) => frame.t === "error"), [burst, burst], "the chat hears it too");
  t.mock.timers.tick(4999);
  assert.deepEqual(socket.types(), []);
  t.mock.timers.tick(1);
  assert.deepEqual(socket.types(), [`join:${b}`, `join:${c}`], "only the joins the server has not confirmed, in one round");
  t.mock.timers.tick(LIVE_DEMO_REJOIN_MAX_MS);
  assert.equal(socket.sent.length, 2);

  // Confirmed now: a later error sends nothing.
  socket.receive(presenceOf(b, [peer, SELF]));
  socket.receive(presenceOf(c, [SELF]));
  socket.receive({ ...burst, retry_after_ms: 0 });
  t.mock.timers.tick(LIVE_DEMO_REJOIN_MAX_MS);
  assert.equal(socket.sent.length, 2);

  // A presence that drops this app (the server lost the join) makes it unconfirmed again.
  socket.receive(presenceOf(c, [peer]));
  socket.receive(burst);
  t.mock.timers.tick(5000);
  assert.deepEqual(socket.types().slice(2), [`join:${c}`]);

  // A round waiting when the socket drops is dropped with it: the new socket joins everything on open.
  socket.receive(burst);
  socket.serverClose(1006);
  t.mock.timers.tick(LIVE_DEMO_RETRY_MAX_MS);
  await settle();
  const next = h.last();
  assert.notEqual(next, socket);
  next.open();
  t.mock.timers.tick(LIVE_DEMO_REJOIN_MAX_MS);
  assert.deepEqual(next.types(), [`join:${a}`, `join:${b}`, `join:${c}`]);
  // The old socket's cid confirms nothing on the new one.
  next.receive({ t: "hello", cid: "c_next", name: "Me", color: "#46a758" });
  next.receive(presenceOf(a, [SELF]));
  next.sent.length = 0;
  next.receive(burst);
  t.mock.timers.tick(5000);
  assert.deepEqual(next.types(), [`join:${a}`, `join:${b}`, `join:${c}`]);
});

test("the wait before a refused join goes again follows the server, within bounds", () => {
  assert.equal(liveDemoRejoinDelayMs(4000, () => 0), 4000);
  assert.equal(liveDemoRejoinDelayMs(4000, () => 1), 5000);
  assert.equal(liveDemoRejoinDelayMs(undefined, () => 0), LIVE_DEMO_REJOIN_MS, "no wait given");
  assert.equal(liveDemoRejoinDelayMs("soon", () => 0), LIVE_DEMO_REJOIN_MS);
  assert.equal(liveDemoRejoinDelayMs(0, () => 0), LIVE_DEMO_REJOIN_MIN_MS, "never at once");
  assert.equal(liveDemoRejoinDelayMs(-5, () => 1), Math.round(LIVE_DEMO_REJOIN_MIN_MS * 1.25));
  assert.equal(liveDemoRejoinDelayMs(10 * 60_000, () => 1), LIVE_DEMO_REJOIN_MAX_MS, "capped, jitter included");
  assert.equal(liveDemoRejoinDelayMs(Number.POSITIVE_INFINITY, () => 0), LIVE_DEMO_REJOIN_MS);
});

test("no socket opens without the app's sign-in, or for a room kept on this computer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const signedOut = harness({ token: null });
  signedOut.client.join(ROOM, DEMO, null);
  await settle();
  assert.equal(signedOut.sockets.length, 0);
  assert.deepEqual(signedOut.statuses(), ["connecting", "refused (Sign in to see who is here.)"]);

  const local = harness({ cloudRoom: null });
  local.client.join("local_room", DEMO, null);
  await settle();
  assert.equal(local.sockets.length, 0);
  assert.deepEqual(local.statuses(), ["connecting", "offline (This room is only on this computer.)"]);
});

test("the socket closes a minute after the last demo leaves; a join in that minute keeps it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  await settle();
  const socket = h.last();
  socket.open();
  h.client.leave(ROOM, DEMO);
  assert.deepEqual(socket.types(), [`join:${DEMO}`, `leave:${DEMO}`]);
  t.mock.timers.tick(LIVE_DEMO_IDLE_CLOSE_MS - 1000);
  h.client.join(ROOM, DEMO, null);
  await settle();
  assert.equal(h.sockets.length, 1, "the open socket is used again");
  assert.deepEqual(socket.types().at(-1), `join:${DEMO}`);
  t.mock.timers.tick(LIVE_DEMO_IDLE_CLOSE_MS);
  assert.equal(socket.readyState, 1, "a joined demo keeps the socket open");

  h.client.leave(ROOM, DEMO);
  h.client.leave(ROOM, DEMO);
  h.client.leave("another room", DEMO);
  t.mock.timers.tick(LIVE_DEMO_IDLE_CLOSE_MS);
  assert.equal(socket.closedWith, 1000);
  assert.equal(h.statuses().at(-1), "offline");
  assert.equal(h.client.inspect(ROOM), null);
});

test("joins are checked and capped per room", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  assert.throws(() => h.client.join("", DEMO, null), /room/);
  assert.throws(() => h.client.join(ROOM, "msg_1", null), /cannot go live/);
  assert.throws(() => h.client.join(ROOM, DEMO, 42), /link/);
  for (let index = 0; index < 8; index += 1) h.client.join(ROOM, `msg_${index}/att_${index}`, null);
  assert.throws(() => h.client.join(ROOM, "msg_9/att_9", null), /At most 8 demos/);
  assert.doesNotThrow(() => h.client.join(ROOM, "msg_0/att_0", null), "a demo already joined joins again");
  await settle();
  assert.equal(h.sockets.length, 1);
});

test("the chat may send only cursor and ink frames, for joined demos, at the server's rates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  const cur = (x: number) => ({ t: "cur", demo: DEMO, x, y: 5 });
  assert.throws(() => h.client.send(ROOM, cur(1)), /not live/);
  h.client.join(ROOM, DEMO, null);
  await settle();
  const socket = h.last();
  h.client.send(ROOM, cur(1));
  assert.equal(socket.sent.length, 0, "a frame before the socket opens is dropped");
  socket.open();
  socket.sent.length = 0;

  for (const frame of [
    { t: "join", demo: DEMO },
    { t: "leave", demo: DEMO },
    { t: "cur", demo: DEMO, x: 761, y: 5 },
    { t: "cur", demo: DEMO, x: 1, y: 5, name: "Mallory" },
    { t: "ink", demo: DEMO, id: "short", pts: [] },
    { t: "ink", demo: DEMO, id: "stroke_0001", pts: Array.from({ length: 65 }, () => [1, 1]) },
    { t: "cur", demo: OTHER, x: 1, y: 1 },
    null,
  ]) {
    assert.throws(() => h.client.send(ROOM, frame), JSON.stringify(frame));
  }
  assert.equal(socket.sent.length, 0);

  h.client.send(ROOM, { t: "cur", demo: DEMO, gone: true });
  h.client.send(ROOM, { t: "ink", demo: DEMO, id: "stroke_0001", pts: [[1, 2]], end: true });
  assert.deepEqual(socket.sent, [{ t: "cur", demo: DEMO, gone: true }, { t: "ink", demo: DEMO, id: "stroke_0001", pts: [[1, 2]], end: true }]);
  socket.sent.length = 0;
  for (let index = 0; index < 40; index += 1) {
    h.client.send(ROOM, cur(index));
    h.client.send(ROOM, { t: "ink", demo: DEMO, id: "stroke_0002", pts: [[index, 1]] });
  }
  assert.equal(socket.sent.filter((frame) => frame.t === "cur").length, 30, "30 cursor frames a second");
  assert.equal(socket.sent.filter((frame) => frame.t === "ink").length, 30, "30 ink frames a second");
  // As on the server, a gone cursor and the end of a stroke always pass.
  h.client.send(ROOM, { t: "cur", demo: DEMO, gone: true });
  h.client.send(ROOM, { t: "ink", demo: DEMO, id: "stroke_0002", pts: [], end: true });
  assert.deepEqual(socket.sent.slice(-2), [{ t: "cur", demo: DEMO, gone: true }, { t: "ink", demo: DEMO, id: "stroke_0002", pts: [], end: true }]);
  t.mock.timers.tick(1000);
  h.client.send(ROOM, cur(100));
  assert.deepEqual(socket.sent.at(-1), cur(100), "the next second has room again");
});

test("the pointer over a demo goes out at most 20 times a second, latest first, and leaves with a gone frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, "letagents-demo://lease-1/");
  await settle();
  const socket = h.last();
  socket.open();
  socket.sent.length = 0;
  const pointer = h.pointers.get("letagents-demo://lease-1/");
  assert.ok(pointer, "the demo's webview pointer is followed");

  pointer({ x: 10, y: 20 });
  assert.deepEqual(socket.sent, [{ t: "cur", demo: DEMO, x: 10, y: 20 }], "the first move goes out at once");
  pointer({ x: 11, y: 21 });
  t.mock.timers.tick(25);
  pointer({ x: 12, y: 22 });
  assert.equal(socket.sent.length, 1);
  t.mock.timers.tick(25);
  assert.deepEqual(socket.sent.at(-1), { t: "cur", demo: DEMO, x: 12, y: 22 }, "only the latest move after 50 ms");
  for (let ms = 0; ms < 1000; ms += 5) {
    pointer({ x: ms / 10, y: 1 });
    t.mock.timers.tick(5);
  }
  assert.ok(socket.sent.length <= 2 + 20, `at most 20 a second (${socket.sent.length})`);

  socket.sent.length = 0;
  t.mock.timers.tick(100);
  socket.sent.length = 0;
  pointer(null);
  pointer(null);
  assert.deepEqual(socket.sent, [{ t: "cur", demo: DEMO, gone: true }], "one gone frame when the pointer leaves");

  // A webview the pointer never crossed sends nothing when it goes.
  h.client.join(ROOM, OTHER, "letagents-demo://lease-2/");
  socket.sent.length = 0;
  h.pointers.get("letagents-demo://lease-2/")!(null);
  t.mock.timers.tick(100);
  assert.equal(socket.sent.length, 0);

  // The chat owns the pointer in draw mode: a cursor main still holds back is dropped.
  t.mock.timers.tick(100);
  pointer({ x: 30, y: 30 });
  pointer({ x: 31, y: 31 });
  h.client.send(ROOM, { t: "cur", demo: DEMO, x: 500, y: 500 });
  t.mock.timers.tick(100);
  assert.deepEqual(socket.sent.map((frame) => frame.x), [30, 500]);

  // A new webview for the same demo: the old one is let go, and its cursor goes.
  socket.sent.length = 0;
  t.mock.timers.tick(100);
  h.client.join(ROOM, DEMO, "letagents-demo://lease-3/");
  assert.deepEqual(h.unwatched, ["letagents-demo://lease-1/"]);
  assert.deepEqual(socket.sent, [{ t: "cur", demo: DEMO, gone: true }]);
  h.pointers.get("letagents-demo://lease-3/")!({ x: 1, y: 1 });
  h.client.leave(ROOM, DEMO);
  assert.deepEqual(socket.sent.slice(-2), [{ t: "cur", demo: DEMO, gone: true }, { t: "leave", demo: DEMO }]);
  assert.deepEqual(h.unwatched, ["letagents-demo://lease-1/", "letagents-demo://lease-3/"]);
});

test("the pointer sends nothing while the socket is down, and the next move after it opens goes out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, "letagents-demo://lease-1/");
  await settle();
  const pointer = h.pointers.get("letagents-demo://lease-1/")!;
  pointer({ x: 1, y: 1 });
  h.last().open();
  assert.deepEqual(h.last().types(), [`join:${DEMO}`]);
  t.mock.timers.tick(100);
  pointer({ x: 2, y: 2 });
  assert.deepEqual(h.last().sent.at(-1), { t: "cur", demo: DEMO, x: 2, y: 2 });
});

test("a socket that stops answering pings is replaced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  await settle();
  const socket = h.last();
  socket.answersPings = false;
  socket.open();
  t.mock.timers.tick(LIVE_DEMO_PING_MS);
  assert.equal(socket.pings, 1);
  socket.emit("pong");
  t.mock.timers.tick(LIVE_DEMO_PING_MS);
  assert.equal(socket.pings, 2, "an answered ping keeps the socket");
  assert.equal(socket.terminated, false);
  t.mock.timers.tick(LIVE_DEMO_PING_MS);
  assert.equal(socket.terminated, true, "an unanswered one ends it");
  assert.equal(h.statuses().at(-1), "reconnecting");
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(h.sockets.length, 2);
});

test("after a sign-in change every room connects again with the new token and keeps its joins", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  h.client.join("focus_27", OTHER, null);
  await settle();
  for (const socket of h.sockets) socket.open();
  h.client.leave("focus_27", OTHER);
  const before = [...h.sockets];
  h.state.token = "next_session";
  h.client.reconnectAll();
  await settle();
  assert.ok(before.every((socket) => socket.readyState === 3), "the old sockets close");
  assert.equal(h.sockets.length, 3, "only the room with a joined demo connects again");
  assert.equal(h.last().token, "next_session");
  h.last().open();
  assert.deepEqual(h.last().types(), [`join:${DEMO}`]);
  assert.equal(h.client.inspect("focus_27"), null);

  h.state.token = null;
  h.client.reconnectAll();
  await settle();
  assert.equal(h.statuses().at(-1), "refused (Sign in to see who is here.)");
  assert.equal(h.sockets.length, 3);
});

test("a reloaded chat leaves every demo", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, "letagents-demo://lease-1/");
  h.client.join(ROOM, OTHER, null);
  await settle();
  h.last().open();
  h.client.leaveAll();
  assert.deepEqual(h.client.inspect(ROOM)?.demos, []);
  assert.deepEqual(h.last().types().slice(-2), [`leave:${DEMO}`, `leave:${OTHER}`]);
  assert.deepEqual(h.unwatched, ["letagents-demo://lease-1/"]);
  t.mock.timers.tick(LIVE_DEMO_IDLE_CLOSE_MS);
  assert.equal(h.last().closedWith, 1000);
});

test("the real ws client offers the protocol with the bearer only, and a refused upgrade stops it", async () => {
  const upgrades: IncomingMessage[] = [];
  let refuse = false;
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    handleProtocols: (protocols) => (protocols.has("live_demo_v1") ? "live_demo_v1" : false),
    verifyClient: (info, done) => {
      upgrades.push(info.req);
      if (refuse) done(false, 403, "Forbidden");
      else done(true);
    },
  });
  await once(server, "listening");
  const received: unknown[] = [];
  server.on("connection", (socket) => {
    socket.on("message", (data) => received.push(JSON.parse(String(data))));
    socket.send(JSON.stringify(presence(DEMO)));
  });
  const events: DesktopLiveDemoEvent[] = [];
  const client = new LiveDemoClient({
    apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connect: connectLiveDemoSocket,
    cloudRoom: async (room) => room,
    token: async () => "app_session",
    emit: (event) => events.push(event),
    watchPointer: () => null,
  });
  const until = async (check: () => boolean) => {
    for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(check());
  };
  try {
    client.join(ROOM, DEMO, null);
    await until(() => received.length > 0 && events.some((event) => event.type === "frame"));
    const upgrade = upgrades[0]!;
    assert.equal(upgrade.url, "/rooms/github.com%2FBrosInCode%2Fletagents/live");
    assert.equal(upgrade.headers.authorization, "Bearer app_session");
    assert.equal(upgrade.headers["sec-websocket-protocol"], "live_demo_v1");
    assert.equal(upgrade.headers.origin, undefined, "no Origin, as from a web page");
    assert.equal(upgrade.headers.cookie, undefined);
    assert.match(String(upgrade.headers["x-letagents-live-client"]), /^[A-Za-z0-9_-]{1,64}$/, "the app's client id for this room");
    assert.deepEqual(received, [{ t: "join", demo: DEMO }]);
    assert.deepEqual(events.find((event) => event.type === "frame"), { type: "frame", roomIdentifier: ROOM, frame: presence(DEMO) });

    refuse = true;
    client.join("focus_27", OTHER, null);
    await until(() => events.some((event) => event.type === "status" && event.roomIdentifier === "focus_27" && event.status === "refused"));
    assert.equal(client.inspect("focus_27")?.connected, false);
  } finally {
    client.leaveAll();
    client.reconnectAll();
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
});

test("each room's socket carries one client id for the app run, the same after every reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  h.client.join("focus_27", OTHER, null);
  await settle();
  const [first, other] = h.sockets;
  const lastForRoom = () => h.sockets.filter((socket) => socket.url === first!.url).at(-1)!;
  assert.match(first!.clientId, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(first!.clientId, other!.clientId, "another room has its own id");
  first!.open();
  first!.serverClose(1006);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(lastForRoom().clientId, first!.clientId, "a reconnect keeps the id");
  h.state.token = "next_session";
  h.client.reconnectAll();
  await settle();
  assert.equal(lastForRoom().clientId, first!.clientId, "a new sign-in keeps it too");
  // A room the app left and joins again later is still the same app.
  lastForRoom().open();
  h.client.leave(ROOM, DEMO);
  t.mock.timers.tick(LIVE_DEMO_IDLE_CLOSE_MS);
  assert.equal(h.client.inspect(ROOM), null);
  h.client.join(ROOM, DEMO, null);
  await settle();
  assert.equal(lastForRoom().clientId, first!.clientId);
});

test("4409 on a socket the app already replaced changes nothing; on the current socket it reconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const h = harness();
  h.client.join(ROOM, DEMO, null);
  await settle();
  const old = h.last();
  old.answersPings = false;
  old.open();
  // A half-open socket after a network change: main gives up on it and opens a new one.
  t.mock.timers.tick(LIVE_DEMO_PING_MS * 2);
  assert.equal(old.terminated, true);
  t.mock.timers.tick(LIVE_DEMO_RETRY_MAX_MS);
  await settle();
  const current = h.last();
  assert.notEqual(current, old);
  current.open();
  const statuses = h.statuses().length;
  // The server sees the new socket and closes the old one late.
  old.serverClose(LIVE_DEMO_CLOSE_REPLACED);
  t.mock.timers.tick(LIVE_DEMO_RETRY_MAX_MS);
  await settle();
  assert.equal(h.statuses().length, statuses, "no status change");
  assert.equal(h.last(), current, "no retry");
  assert.equal(current.readyState, 1);

  current.serverClose(LIVE_DEMO_CLOSE_REPLACED);
  assert.equal(h.statuses().at(-1), "reconnecting");
  t.mock.timers.tick(LIVE_DEMO_RETRY_MAX_MS);
  await settle();
  assert.notEqual(h.last(), current, "the room connects again");
  assert.equal(h.last().clientId, current.clientId);
  h.last().open();
  assert.deepEqual(h.last().types(), [`join:${DEMO}`]);
});
