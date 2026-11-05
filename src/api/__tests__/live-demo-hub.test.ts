import assert from 'node:assert/strict';
import test from 'node:test';

import { LIVE_DEMO, liveDemoColor, parseLiveServerFrame, type DemoMark } from '../../../shared/live-demo.mjs';
import { createInMemoryLiveDemoBus, createLiveDemoHub, type LiveDemoHubOptions } from '../live-demos/hub.js';

const DEMO = 'msg_1/att_1';
const OTHER_DEMO = 'msg_2/att_1';

class FakeSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string) {
    const frame = JSON.parse(data);
    assert.ok(parseLiveServerFrame(frame), `the app can read ${data}`);
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
  const [limited] = ada.socket.take('error');
  assert.equal(limited.code, 'rate_limited', 'ten joins in ten seconds');
  assert.equal(limited.demo, known[10]);
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
  bea.socket.bufferedAmount = 10 * 1024 * 1024;
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
