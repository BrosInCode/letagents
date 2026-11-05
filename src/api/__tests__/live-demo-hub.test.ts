import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_DEMO, liveDemoColor, parseLiveServerFrame, type DemoMark } from '../../../shared/live-demo.mjs';
import { createInMemoryLiveDemoBus, createLiveDemoHub, LIVE_DEMO_HUB_LIMITS, type LiveDemoHubOptions } from '../live-demos/hub.js';

const DEMO = 'msg_1/att_1';
const OTHER_DEMO = 'msg_2/att_1';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  /** A peer that stops reading: every frame stays queued. */
  reading = true;
  sent: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string) {
    const frame = JSON.parse(data);
    assert.ok(parseLiveServerFrame(frame), `the app can read ${data}`);
    if (!this.reading) this.bufferedAmount += Buffer.byteLength(data);
    this.sent.push(frame);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  take(t?: string) {
    const frames = this.sent.filter((frame) => !t || frame.t === t);
    this.sent = [];
    return frames;
  }
}

function harness(options: Partial<LiveDemoHubOptions> & { known?: string[] } = {}) {
  let clock = 1_000_000;
  const lookups: string[] = [];
  const known = new Set(options.known ?? [DEMO, OTHER_DEMO]);
  const hub = createLiveDemoHub({
    demoExists: async (roomId, demo) => {
      lookups.push(`${roomId}:${demo}`);
      return known.has(demo);
    },
    now: () => clock,
    bus: createInMemoryLiveDemoBus(),
    onError: () => {},
    ...options,
  });
  const people = new Map<string, { socket: FakeSocket; connection: ReturnType<typeof hub.connect> }>();
  const connect = (name: string, roomId = 'room-a', accountId = `acct_${name}`) => {
    const socket = new FakeSocket();
    const connection = hub.connect({ roomId, accountId, name, color: liveDemoColor(accountId), socket });
    people.set(name, { socket, connection });
    return { socket, connection, send: (frame: unknown) => connection.receive(JSON.stringify(frame)) };
  };
  return { hub, connect, lookups, tick: (ms: number) => { clock += ms; } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a new connection gets hello with its cid, name and colour', () => {
  const { connect } = harness();
  const ada = connect('Ada');
  const [hello] = ada.socket.take();
  assert.equal(hello.t, 'hello');
  assert.equal(hello.cid, ada.connection.cid);
  assert.match(hello.cid, /^[A-Za-z0-9_-]{4,64}$/);
  assert.equal(hello.name, 'Ada');
  assert.equal(hello.color, liveDemoColor('acct_Ada'));
});

test('join checks the demo once per connection and tells every viewer who is there', async () => {
  const { connect, lookups } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.socket.take();
  bea.socket.take();

  ada.send({ t: 'join', demo: DEMO });
  await settle();
  assert.deepEqual(ada.socket.take('presence').map((frame) => frame.people.map((p: any) => p.name)), [['Ada']]);

  bea.send({ t: 'join', demo: DEMO });
  await settle();
  const [seenByAda] = ada.socket.take('presence');
  const [seenByBea] = bea.socket.take('presence');
  assert.deepEqual(seenByAda.people.map((p: any) => p.name), ['Ada', 'Bea']);
  assert.deepEqual(seenByBea, seenByAda);
  assert.deepEqual(seenByBea.people[1], { cid: bea.connection.cid, name: 'Bea', color: liveDemoColor('acct_Bea') });

  // Leave and join again: the check is cached for this connection.
  bea.send({ t: 'leave', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  assert.deepEqual(lookups, ['room-a:msg_1/att_1', 'room-a:msg_1/att_1']);

  // A second join of a joined demo answers this app only.
  ada.socket.take();
  bea.socket.take();
  bea.send({ t: 'join', demo: DEMO });
  assert.equal(bea.socket.take('presence').length, 1);
  assert.equal(ada.socket.take().length, 0);
});

test('a demo that is not in the room is refused with its key', async () => {
  const { connect, hub } = harness({ known: [] });
  const ada = connect('Ada');
  ada.socket.take();
  ada.send({ t: 'join', demo: DEMO });
  await settle();
  assert.deepEqual(ada.socket.take(), [{ t: 'error', code: 'demo_not_found', message: 'This demo is not in this room.', demo: DEMO }]);
  ada.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  assert.equal(hub.stats().connections, 1);
});

test('cursors and ink go only to the other viewers of the same demo in the same room', async () => {
  const { connect } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  const cy = connect('Cy');
  const dee = connect('Dee', 'room-b');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  cy.send({ t: 'join', demo: OTHER_DEMO });
  dee.send({ t: 'join', demo: DEMO });
  await settle();
  for (const person of [ada, bea, cy, dee]) person.socket.take();

  ada.send({ t: 'cur', demo: DEMO, x: 120.5, y: 300 });
  ada.send({ t: 'ink', demo: DEMO, id: 'stroke_0001', pts: [[1, 2], [3, 4]] });
  ada.send({ t: 'cur', demo: OTHER_DEMO, x: 5, y: 5 });
  assert.deepEqual(bea.socket.take(), [
    { t: 'cur', demo: DEMO, cid: ada.connection.cid, x: 120.5, y: 300 },
    { t: 'ink', demo: DEMO, cid: ada.connection.cid, id: 'stroke_0001', pts: [[1, 2], [3, 4]] },
  ]);
  assert.deepEqual(ada.socket.take(), [], 'never echoed to the sender');
  assert.deepEqual(cy.socket.take(), [], 'another demo, and a cursor for a demo Ada has not joined');
  assert.deepEqual(dee.socket.take(), [], 'the same demo key in another room');
});

test('cursor and ink frames above 30 a second per demo are dropped; gone and stroke ends still pass', async () => {
  const { connect, tick } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  bea.socket.take();

  for (let i = 0; i < 45; i += 1) ada.send({ t: 'cur', demo: DEMO, x: i, y: i });
  assert.equal(bea.socket.take('cur').length, LIVE_DEMO.serverCursorPerSecond);
  ada.send({ t: 'cur', demo: DEMO, gone: true });
  ada.send({ t: 'cur', demo: DEMO, gone: true });
  assert.deepEqual(bea.socket.take(), [{ t: 'cur', demo: DEMO, cid: ada.connection.cid, gone: true }], 'one gone per shown cursor');
  tick(1000);
  ada.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  assert.equal(bea.socket.take('cur').length, 1, 'the next second has room again');

  for (let i = 0; i < 40; i += 1) ada.send({ t: 'ink', demo: DEMO, id: 'stroke_0002', pts: [[i, i]] });
  assert.equal(bea.socket.take('ink').length, LIVE_DEMO.inkFramesPerSecond);
  ada.send({ t: 'ink', demo: DEMO, id: 'stroke_0002', pts: [], end: true });
  assert.deepEqual(bea.socket.take('ink').map((frame) => frame.end), [true], 'the end of the open stroke passes');
  ada.send({ t: 'ink', demo: DEMO, id: 'stroke_0003', pts: [[1, 1]], end: true });
  assert.equal(bea.socket.take('ink').length, 0, 'a new one-frame stroke is still rate limited');
});

test('a live stroke stops growing at the saved-stroke limit', async () => {
  const { connect, tick } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  bea.socket.take();
  const pts = Array.from({ length: LIVE_DEMO.inkPointsPerFrame }, (_, i) => [i, i]);
  for (let i = 0; i < 40; i += 1) {
    tick(100);
    ada.send({ t: 'ink', demo: DEMO, id: 'stroke_long', pts });
  }
  ada.send({ t: 'ink', demo: DEMO, id: 'stroke_long', pts, end: true });
  const frames = bea.socket.take('ink');
  assert.equal(frames.reduce((sum, frame) => sum + frame.pts.length, 0), LIVE_DEMO.strokePoints);
  assert.equal(frames.at(-1).end, true);
});

test('bad frames are dropped, and too many close the socket and leave its demos', async () => {
  const { connect, hub } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  ada.socket.take();
  bea.socket.take();

  const bad: Array<[string | Buffer, boolean?]> = [
    ['not json'],
    [JSON.stringify({ t: 'cur', demo: DEMO, x: 9999, y: 1 })],
    [JSON.stringify({ t: 'nope', demo: DEMO })],
    [JSON.stringify({ t: 'cur', demo: DEMO, x: 1, y: 1, extra: true })],
    [Buffer.from(JSON.stringify({ t: 'cur', demo: DEMO, x: 1, y: 1 })), true],
    [JSON.stringify({ t: 'ink', demo: DEMO, id: 'stroke_0004', pts: [] }) + ' '.repeat(LIVE_DEMO.frameBytes)],
  ];
  for (const [data, binary] of bad) bea.connection.receive(data, binary);
  assert.equal(ada.socket.take().length, 0, 'nothing relayed');
  assert.equal(bea.socket.closed, null, 'a few bad frames are tolerated');

  for (let i = 0; i < 4; i += 1) bea.connection.receive('{');
  assert.equal(bea.socket.closed, null);
  bea.connection.receive('{');
  assert.deepEqual(bea.socket.closed, { code: 1008, reason: 'Too many bad frames' });
  const frames = ada.socket.take();
  assert.deepEqual(frames[0], { t: 'cur', demo: DEMO, cid: bea.connection.cid, gone: true });
  assert.deepEqual(frames[1].people.map((p: any) => p.name), ['Ada']);
  assert.equal(hub.stats().connections, 1);
});

test('leave and disconnect send cur gone and presence, and an empty room is dropped', async () => {
  const { connect, hub } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  for (const demo of [DEMO, OTHER_DEMO]) {
    ada.send({ t: 'join', demo });
    bea.send({ t: 'join', demo });
  }
  await settle();
  ada.socket.take();
  bea.socket.take();

  bea.send({ t: 'leave', demo: OTHER_DEMO });
  assert.deepEqual(ada.socket.take(), [
    { t: 'cur', demo: OTHER_DEMO, cid: bea.connection.cid, gone: true },
    { t: 'presence', demo: OTHER_DEMO, people: [{ cid: ada.connection.cid, name: 'Ada', color: liveDemoColor('acct_Ada') }] },
  ]);
  bea.send({ t: 'cur', demo: OTHER_DEMO, x: 1, y: 1 });
  assert.equal(ada.socket.take().length, 0, 'no cursor after leave');

  bea.connection.disconnect();
  bea.connection.disconnect();
  assert.deepEqual(ada.socket.take().map((frame) => [frame.t, frame.demo]), [['cur', DEMO], ['presence', DEMO]]);
  assert.deepEqual(hub.stats(), { rooms: 1, connections: 1 });
  ada.connection.disconnect();
  assert.deepEqual(hub.stats(), { rooms: 0, connections: 0 });
});

test('a leave or a disconnect during the demo check cancels the join', async () => {
  let release!: (found: boolean) => void;
  const { connect } = harness({ demoExists: () => new Promise((resolve) => { release = resolve; }) });
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.socket.take();
  ada.send({ t: 'join', demo: DEMO });
  ada.send({ t: 'leave', demo: DEMO });
  await settle();
  release(true);
  await settle();
  assert.deepEqual(ada.socket.take(), []);

  bea.send({ t: 'join', demo: DEMO });
  await settle();
  bea.connection.disconnect();
  release(true);
  await settle();
  assert.deepEqual(ada.socket.take(), []);
});

test('a connection views at most eight demos, joins are rate limited, and a demo admits a fixed number of viewers', async () => {
  const known = Array.from({ length: 12 }, (_, i) => `msg_${i + 1}/att_1`);
  const { connect, tick } = harness({ known, limits: { viewersPerDemo: 2, joins: 10 } });
  const ada = connect('Ada');
  ada.socket.take();
  for (const demo of known.slice(0, 9)) ada.send({ t: 'join', demo });
  await settle();
  const frames = ada.socket.take();
  assert.equal(frames.filter((frame) => frame.t === 'presence').length, LIVE_DEMO.demosPerConnection);
  assert.deepEqual(frames.filter((frame) => frame.t === 'error').map((frame) => [frame.code, frame.demo]), [['too_many_demos', known[8]]]);

  for (const demo of known.slice(0, 3)) ada.send({ t: 'leave', demo });
  for (const demo of known.slice(8, 11)) ada.send({ t: 'join', demo });
  const limited = ada.socket.take('error');
  assert.deepEqual(limited.map((frame) => [frame.code, frame.demo, frame.retry_after_ms]), [['rate_limited', undefined, 10_000]],
    'ten joins in ten seconds, the refused ninth one included; one reply for no demo in particular, then silence');
  tick(10_000);
  ada.send({ t: 'join', demo: known[10] });
  await settle();
  assert.equal(ada.socket.take('error').length, 0);

  const bea = connect('Bea');
  const cy = connect('Cy');
  bea.send({ t: 'join', demo: known[3] });
  cy.send({ t: 'join', demo: known[3] });
  await settle();
  assert.equal(cy.socket.take('error')[0].code, 'demo_full');
});

test('a saved-mark change reaches every viewer of that demo, the author included', async () => {
  const { connect, hub } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: OTHER_DEMO });
  await settle();
  ada.socket.take();
  bea.socket.take();
  const mark: DemoMark = {
    id: 'dmk_abcdefgh', demo: DEMO, kind: 'pin', at: [10, 20], text: 'Here', anchor: null, createdAt: new Date(0).toISOString(),
    author: { accountId: 'acct_Ada', name: 'Ada', color: liveDemoColor('acct_Ada') },
  };
  hub.broadcast('room-a', DEMO, { t: 'mark', demo: DEMO, mark });
  hub.broadcast('room-a', DEMO, { t: 'unmark', demo: DEMO, id: mark.id });
  assert.deepEqual(ada.socket.take().map((frame) => frame.t), ['mark', 'unmark']);
  assert.deepEqual(bea.socket.take(), []);
});

test('a socket that is far behind skips cursors but still gets presence', async () => {
  const { connect } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  bea.socket.take();
  // Behind, but under the hard cap.
  bea.socket.bufferedAmount = (LIVE_DEMO_HUB_LIMITS.slowSocketBytes + LIVE_DEMO_HUB_LIMITS.maxQueuedBytes) / 2;
  ada.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  ada.send({ t: 'leave', demo: DEMO });
  assert.deepEqual(bea.socket.take().map((frame) => frame.t), ['presence']);
});

test('a closed connection (for example after a revoke) is gone from every demo at once', async () => {
  const { connect, hub } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  ada.socket.take();
  // The socket layer closes with 4403 and then reports the close.
  bea.socket.close(4403, 'Access ended');
  bea.connection.disconnect();
  bea.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  bea.send({ t: 'join', demo: OTHER_DEMO });
  await settle();
  assert.deepEqual(ada.socket.take().map((frame) => frame.t), ['cur', 'presence']);
  assert.deepEqual(hub.stats(), { rooms: 1, connections: 1 });
});

test('a flood of repeated or refused joins gets at most one window of replies', async () => {
  const { connect, tick } = harness({ known: [DEMO] });
  const ada = connect('Ada');
  ada.send({ t: 'join', demo: DEMO });
  await settle();
  ada.socket.take();
  for (let i = 0; i < 2_000; i += 1) {
    ada.send({ t: 'join', demo: DEMO });
    ada.send({ t: 'join', demo: `msg_${i + 2}/att_1` });
  }
  await settle();
  const replies = ada.socket.take();
  assert.equal(replies.length, LIVE_DEMO_HUB_LIMITS.joins, 'the first join of the window was the real one');
  const limited = replies.filter((frame) => frame.code === 'rate_limited');
  assert.equal(limited.length, 1);
  assert.equal(limited[0].demo, undefined, 'it names no demo: the app re-sends every unconfirmed join');
  assert.equal(limited[0].retry_after_ms, LIVE_DEMO_HUB_LIMITS.joinWindowMs);
  tick(4_000);
  ada.send({ t: 'join', demo: DEMO });
  assert.deepEqual(ada.socket.take(), [], 'still one reply per window');
  tick(LIVE_DEMO_HUB_LIMITS.joinWindowMs - 4_000);
  ada.send({ t: 'join', demo: DEMO });
  assert.deepEqual(ada.socket.take().map((frame) => frame.t), ['presence'], 'the next window has room again');
});

test('a socket that stops reading skips cursors, then closes before its queue passes the hard cap', async () => {
  const { connect, hub } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  ada.socket.take();
  bea.socket.take();
  ada.socket.reading = false;

  const big: DemoMark = {
    id: 'dmk_bigstroke', demo: DEMO, kind: 'stroke', anchor: null, createdAt: new Date(0).toISOString(),
    author: { accountId: 'acct_Bea', name: 'Bea', color: liveDemoColor('acct_Bea') },
    points: Array.from({ length: LIVE_DEMO.strokePoints }, (_, i) => [i % 760, i]),
  };
  let cursorsBeforeClose = 0;
  for (let i = 0; i < 200 && !ada.socket.closed; i += 1) {
    hub.broadcast('room-a', DEMO, { t: 'mark', demo: DEMO, mark: big });
    const before = ada.socket.sent.length;
    bea.send({ t: 'cur', demo: DEMO, x: i, y: i });
    if (ada.socket.sent.length > before) cursorsBeforeClose += 1;
    assert.ok(ada.socket.bufferedAmount <= LIVE_DEMO_HUB_LIMITS.maxQueuedBytes, 'never queued past the cap');
  }
  assert.deepEqual(ada.socket.closed, { code: 1013, reason: 'Too far behind' });
  assert.ok(cursorsBeforeClose < 5, 'cursors stopped once it fell behind');
  const toBea = bea.socket.take();
  assert.ok(toBea.some((frame) => frame.t === 'cur' && frame.cid === ada.connection.cid && frame.gone));
  assert.deepEqual(toBea.filter((frame) => frame.t === 'presence').at(-1).people.map((p: any) => p.name), ['Bea'],
    'gone from presence at once');
  assert.deepEqual(hub.stats(), { rooms: 1, connections: 1 });
});

test('a held socket gets nothing and sends nothing, and gets the current viewers when released', async () => {
  const { connect } = harness();
  const ada = connect('Ada');
  const bea = connect('Bea');
  const cy = connect('Cy');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  for (const person of [ada, bea, cy]) person.socket.take();

  bea.connection.hold(true);
  ada.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  bea.send({ t: 'cur', demo: DEMO, x: 2, y: 2 });
  bea.send({ t: 'ink', demo: DEMO, id: 'stroke_held', pts: [[1, 1]] });
  cy.send({ t: 'join', demo: DEMO });
  await settle();
  assert.deepEqual(bea.socket.take(), [], 'nothing while held');
  assert.deepEqual(ada.socket.take().map((frame) => frame.t), ['presence'], 'only Cy arriving, no cursor or ink from Bea');

  bea.connection.hold(false);
  const [presence, ...rest] = bea.socket.take();
  assert.deepEqual(presence.people.map((p: any) => p.name), ['Ada', 'Bea', 'Cy']);
  assert.deepEqual(rest, []);
  bea.send({ t: 'cur', demo: DEMO, x: 3, y: 3 });
  assert.equal(ada.socket.take('cur').length, 1, 'relayed again');
});

test('a held socket keeps saved-mark changes in a small queue: flushed on release, dropped on revoke, closed on overflow', async () => {
  const { connect, hub } = harness({ limits: { heldFrames: 3 } });
  const ada = connect('Ada');
  const bea = connect('Bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await settle();
  bea.socket.take();
  const mark: DemoMark = {
    id: 'dmk_heldmark', demo: DEMO, kind: 'pin', at: [1, 2], text: 'Here', anchor: null, createdAt: new Date(0).toISOString(),
    author: { accountId: 'acct_Ada', name: 'Ada', color: liveDemoColor('acct_Ada') },
  };

  bea.connection.hold(true);
  hub.broadcast('room-a', DEMO, { t: 'mark', demo: DEMO, mark });
  hub.broadcast('room-a', DEMO, { t: 'unmark', demo: DEMO, id: mark.id });
  ada.send({ t: 'cur', demo: DEMO, x: 1, y: 1 });
  assert.deepEqual(bea.socket.take(), []);
  bea.connection.hold(false);
  assert.deepEqual(bea.socket.take().map((frame) => frame.t), ['presence', 'mark', 'unmark'], 'nothing saved was missed');

  bea.connection.hold(true);
  hub.broadcast('room-a', DEMO, { t: 'mark', demo: DEMO, mark });
  bea.socket.close(4403, 'Access ended');
  bea.connection.disconnect();
  bea.connection.hold(false);
  assert.deepEqual(bea.socket.take(), [], 'a revoked socket gets nothing it was kept');

  const cy = connect('Cy');
  cy.send({ t: 'join', demo: DEMO });
  await settle();
  cy.socket.take();
  cy.connection.hold(true);
  for (let i = 0; i < 4; i += 1) hub.broadcast('room-a', DEMO, { t: 'unmark', demo: DEMO, id: `dmk_gone_${i}` });
  assert.deepEqual(cy.socket.closed, { code: 1013, reason: 'Too far behind' }, 'past the queue: reconnect and reload');
  assert.deepEqual(hub.stats(), { rooms: 1, connections: 1 });
});

test('pings from the app are answered within a budget; a flood is a bad-frame flood', () => {
  const { connect, tick } = harness();
  const ada = connect('Ada');
  const answered = Array.from({ length: LIVE_DEMO_HUB_LIMITS.pings }, () => ada.connection.ping(8));
  assert.deepEqual(answered, Array(LIVE_DEMO_HUB_LIMITS.pings).fill(true));
  for (let i = 0; i < LIVE_DEMO_HUB_LIMITS.badFrames; i += 1) assert.equal(ada.connection.ping(8), false);
  assert.equal(ada.socket.closed, null);
  assert.equal(ada.connection.ping(8), false);
  assert.deepEqual(ada.socket.closed, { code: 1008, reason: 'Too many bad frames' });

  const bea = connect('Bea');
  assert.equal(bea.connection.ping(8), true);
  tick(LIVE_DEMO_HUB_LIMITS.pingWindowMs);
  bea.socket.bufferedAmount = LIVE_DEMO_HUB_LIMITS.maxQueuedBytes - 4;
  assert.equal(bea.connection.ping(8), false, 'no pong past the queue cap');
  assert.deepEqual(bea.socket.closed, { code: 1013, reason: 'Too far behind' });
});
