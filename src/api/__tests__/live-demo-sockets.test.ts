import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import WebSocket from 'ws';

import { liveDemoColor } from '../../../shared/live-demo.mjs';
import type { LiveDemoAccess, LiveRoomDecision } from '../live-demos/access.js';
import { createLiveDemoHub, LIVE_DEMO_HUB_LIMITS } from '../live-demos/hub.js';
import { attachLiveDemoSockets, type LiveDemoSocketLimits } from '../live-demos/sockets.js';
import { closedWith as closed, joinLive as live, openLive, openLive as open, pause, until } from './live-demo-client.js';

// The upgrade handler on a real HTTP server with real `ws` clients. Access is
// a stub here; live-demos-db.test.ts runs the same checks against Postgres.

const DEMO = 'msg_1/att_1';

function account(id: string, login: string, displayName: string | null = null) {
  return { id: `ses_${id}`, account_id: id, login, display_name: displayName, provider: 'github', provider_user_id: id,
    avatar_url: null, token_hash: '', provider_access_token: null, expires_at: '', created_at: '' };
}

async function start(limits: Partial<LiveDemoSocketLimits> = {}) {
  const tokens = new Map(Object.entries({
    'tok-ada': account('acct_ada', 'ada', 'Ada Lovelace'),
    'tok-bea': account('acct_bea', 'bea'),
    'tok-cy': account('acct_cy', 'cy', 'Cy'),
    'tok-stranger': account('acct_stranger', 'stranger'),
  }));
  const members = new Set(['room-a:acct_ada', 'room-a:acct_bea', 'room-b:acct_cy']);
  const rooms = new Map([['room-a', { id: 'room-a', focus_key: null }], ['room-b', { id: 'room-b', focus_key: null }],
    ['github.com/acme/app', { id: 'github.com/acme/app', focus_key: null }]]);
  const calls: string[] = [];
  let repoDecision: LiveRoomDecision = 'unavailable';
  // While set, a check decides at once but answers only when the gate opens.
  let gate: Promise<void> | null = null;
  const access: LiveDemoAccess = {
    authenticate: async (token) => { calls.push(`auth:${token}`); return (tokens.get(token) ?? null) as any; },
    findRoom: async (id) => (rooms.get(id) ?? null) as any,
    canView: async (room, person, options) => {
      calls.push(`view:${room.id}:${person.account_id}:${options?.fresh ? 'fresh' : 'cached'}`);
      const decision: LiveRoomDecision = room.id.startsWith('github.com/')
        ? repoDecision
        : members.has(`${room.id}:${person.account_id}`) ? 'allow' : 'deny';
      if (gate) await gate;
      return { decision, accessRoomName: room.id };
    },
    demoExists: async (_roomId, demo) => demo === DEMO,
  };
  const hub = createLiveDemoHub({ demoExists: access.demoExists, onError: () => {} });
  const server: Server = createServer((_req, res) => { res.statusCode = 200; res.end('plain'); });
  const sockets = attachLiveDemoSockets(server, { access, hub, limits, onError: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    port, hub, sockets, members, tokens, calls,
    setRepoDecision: (decision: LiveRoomDecision) => { repoDecision = decision; },
    /** Holds every access check until the returned function is called. */
    closeGate() {
      let open!: () => void;
      gate = new Promise<void>((resolve) => { open = resolve; });
      return () => { gate = null; open(); };
    },
    async stop() {
      await sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('every refusal is a plain HTTP answer before the upgrade', async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const { port } = server;
  const cases: Array<[string, Parameters<typeof open>[2], number, string]> = [
    ['/rooms/room-a/live', {}, 401, 'auth_required'],
    ['/rooms/room-a/live', { headers: { cookie: 'letagents_session=tok-ada' } }, 401, 'auth_required'],
    ['/rooms/room-a/live', { token: 'tok-ada', headers: { origin: 'https://evil.example' } }, 403, 'origin_refused'],
    ['/rooms/room-a/live', { token: 'tok-ada', headers: { origin: 'null' } }, 403, 'origin_refused'],
    ['/rooms/room-a/live', { token: 'tok-ada', protocol: null }, 400, 'protocol_required'],
    ['/rooms/room-a/live', { token: 'tok-ada', protocol: 'other_v1' }, 400, 'protocol_required'],
    ['/rooms/room-a/live', { token: 'owner-token-or-agent-bearer' }, 401, 'auth_required'],
    ['/rooms/nowhere/live', { token: 'tok-ada' }, 404, 'room_not_found'],
    ['/rooms/room-a/live', { token: 'tok-stranger' }, 403, 'room_access_required'],
    ['/rooms/room-b/live', { token: 'tok-ada' }, 403, 'room_access_required'],
    ['/rooms/github.com%2Facme%2Fapp/live', { token: 'tok-ada' }, 503, 'repo_access_unavailable'],
    ['/rooms/room-a/messages', { token: 'tok-ada' }, 404, 'not_found'],
  ];
  for (const [path, options, status, error] of cases) {
    const answer = await open(port, path, options);
    assert.equal(answer.status, status, `${path} ${JSON.stringify(options)}`);
    assert.equal((answer as any).body.error, error);
  }
  assert.equal(server.calls.filter((call) => call === 'auth:tok-ada').length, 3, 'cheap refusals read nothing');
  assert.deepEqual(server.hub.stats(), { rooms: 0, connections: 0 });
  assert.deepEqual(server.sockets.stats(), { sockets: 0, handshakes: 0, queuedBytes: 0 });
  assert.ok(server.calls.filter((call) => call.startsWith('view:')).every((call) => call.endsWith(':fresh')),
    'the upgrade asks GitHub afresh, never a cached answer');
  const badClient = await open(port, '/rooms/room-a/live', { token: 'tok-ada', headers: { 'x-letagents-live-client': 'not ok!' } });
  assert.deepEqual([badClient.status, (badClient as any).body.error], [400, 'invalid_client_id']);

  // A plain request still reaches the app.
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/rooms/room-a/live`)).text(), 'plain');
  server.setRepoDecision('allow');
  assert.equal((await open(port, '/rooms/github.com/acme/app/live', { token: 'tok-ada' })).status, 101, 'a repo room id keeps its slashes');
});

test('two members see each other; a member of another room with the same demo key does not', async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const bea = await live(server.port, 'room-a', 'tok-bea');
  const cy = await live(server.port, 'room-b', 'tok-cy');
  assert.deepEqual([ada.hello.name, ada.hello.color], ['Ada Lovelace', liveDemoColor('acct_ada')]);
  assert.equal(bea.hello.name, 'bea', 'the login when there is no display name');

  for (const person of [ada, bea, cy]) person.send({ t: 'join', demo: DEMO });
  const presence = await ada.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);
  assert.deepEqual(presence.people.map((p: any) => p.cid).sort(), [ada.hello.cid, bea.hello.cid].sort());
  const cyPresence = await cy.frames.next((frame) => frame.t === 'presence');
  assert.deepEqual(cyPresence.people.map((p: any) => p.cid), [cy.hello.cid]);

  ada.send({ t: 'cur', demo: DEMO, x: 380, y: 1200 });
  assert.deepEqual(await bea.frames.next((frame) => frame.t === 'cur'), { t: 'cur', demo: DEMO, cid: ada.hello.cid, x: 380, y: 1200 });
  bea.send({ t: 'cur', demo: DEMO, x: 10, y: 20 });
  assert.equal((await ada.frames.next((frame) => frame.t === 'cur')).cid, bea.hello.cid);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cy.frames.frames.filter((frame) => frame.t === 'cur').length, 0, 'room-b sees no room-a cursor');

  const gone = closed(bea.ws);
  bea.ws.close();
  await gone;
  assert.deepEqual(await ada.frames.next((frame) => frame.t === 'cur' && frame.gone), { t: 'cur', demo: DEMO, cid: bea.hello.cid, gone: true });
  const after = await ada.frames.next((frame) => frame.t === 'presence');
  assert.deepEqual(after.people.map((p: any) => p.cid), [ada.hello.cid]);
});

test('sockets are capped per account per room and per process', async (t) => {
  const server = await start({ perAccountRoom: 2, perProcess: 3 });
  t.after(() => server.stop());
  await live(server.port, 'room-a', 'tok-ada');
  await live(server.port, 'room-a', 'tok-ada');
  const third = await open(server.port, '/rooms/room-a/live', { token: 'tok-ada' });
  assert.equal(third.status, 429);
  await live(server.port, 'room-a', 'tok-bea');
  const full = await open(server.port, '/rooms/room-b/live', { token: 'tok-cy' });
  assert.equal(full.status, 503);
});

test('a revoked membership or ended session closes the socket with 4403', async (t) => {
  const server = await start({ recheckMs: 60 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const bea = await live(server.port, 'room-a', 'tok-bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await ada.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);

  const beaClosed = closed(bea.ws);
  server.members.delete('room-a:acct_bea');
  assert.deepEqual(await beaClosed, { code: 4403, reason: 'Access ended' });
  const after = await ada.frames.next((frame) => frame.t === 'presence');
  assert.deepEqual(after.people.map((p: any) => p.cid), [ada.hello.cid]);

  const adaClosed = closed(ada.ws);
  server.tokens.delete('tok-ada');
  assert.equal((await adaClosed).code, 4403, 'signed out');
  await until(() => server.hub.stats().connections === 0);
  assert.deepEqual(server.hub.stats(), { rooms: 0, connections: 0 });
});

test('a membership event re-checks the matching sockets at once', async (t) => {
  const server = await start({ recheckMs: 60_000 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const bea = await live(server.port, 'room-a', 'tok-bea');
  server.members.delete('room-a:acct_bea');
  server.members.delete('room-a:acct_ada');
  const beaClosed = closed(bea.ws);
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'bea' });
  assert.equal((await beaClosed).code, 4403);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ada.ws.readyState, WebSocket.OPEN, 'another person is left to the periodic check');
});

test('a peer that stops answering pings is closed', async (t) => {
  const server = await start({ pingMs: 40 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  // Stop reading: pongs stop, as with a sleeping laptop.
  (ada.ws as any)._socket.pause();
  await until(() => server.sockets.stats().sockets === 0);
  assert.equal(server.hub.stats().connections, 0);
  (ada.ws as any)._socket.destroy();
});

test('shutdown closes every socket with 1001 and refuses new upgrades', async () => {
  const server = await start();
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const adaClosed = closed(ada.ws);
  await server.sockets.close();
  assert.equal((await adaClosed).code, 1001);
  await server.stop();
});

test('one account holds a fixed number of sockets over all rooms', async (t) => {
  const server = await start({ perAccount: 2 });
  t.after(() => server.stop());
  server.members.add('room-b:acct_ada');
  await live(server.port, 'room-a', 'tok-ada');
  await live(server.port, 'room-b', 'tok-ada');
  const third = await open(server.port, '/rooms/room-a/live', { token: 'tok-ada' });
  assert.equal(third.status, 429);
  assert.match((third as any).body.message, /too many rooms/);
  assert.ok(!server.calls.slice(-1)[0]!.startsWith('view:'), 'a capped account costs no access check');
  await live(server.port, 'room-a', 'tok-bea');
});

test('a new socket from the same app replaces the old one at once (4409)', async (t) => {
  const server = await start({ perAccountRoom: 1 });
  t.after(() => server.stop());
  const client = { 'x-letagents-live-client': 'run_7f3a-room-a' };
  const bea = await live(server.port, 'room-a', 'tok-bea');
  const first = await live(server.port, 'room-a', 'tok-ada', client);
  bea.send({ t: 'join', demo: DEMO });
  first.send({ t: 'join', demo: DEMO });
  await bea.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);

  const firstClosed = closed(first.ws);
  const second = await live(server.port, 'room-a', 'tok-ada', client);
  assert.deepEqual(await firstClosed, { code: 4409, reason: 'Replaced by a newer connection' });
  assert.deepEqual(await bea.frames.next((frame) => frame.t === 'cur'), { t: 'cur', demo: DEMO, cid: first.hello.cid, gone: true });
  assert.deepEqual((await bea.frames.next((frame) => frame.t === 'presence')).people.map((p: any) => p.cid), [bea.hello.cid]);
  second.send({ t: 'join', demo: DEMO });
  const both = await bea.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);
  assert.deepEqual(both.people.map((p: any) => p.cid).sort(), [bea.hello.cid, second.hello.cid].sort(), 'Ada shows once');

  const other = await open(server.port, '/rooms/room-a/live', { token: 'tok-ada', headers: { 'x-letagents-live-client': 'another-run' } });
  assert.equal(other.status, 429, 'another app run replaces nothing');
  assert.equal(second.ws.readyState, WebSocket.OPEN);
});

test('pongs the server did not ask for do not keep a silent peer alive', async (t) => {
  const server = await start({ pingMs: 50 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const raw = (ada.ws as any)._socket;
  raw.pause();
  const spam = setInterval(() => ada.ws.pong(Buffer.from('alive')), 5);
  t.after(() => { clearInterval(spam); raw.destroy(); });
  await until(() => server.sockets.stats().sockets === 0, 3_000);
});

test('probe: a client that stops reading and floods joins keeps nothing queued and is dropped', async (t) => {
  const server = await start({ pingMs: 200 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  ada.send({ t: 'join', demo: DEMO });
  await ada.frames.next((frame) => frame.t === 'presence');
  const raw = (ada.ws as any)._socket;
  raw.pause();
  t.after(() => raw.destroy());
  let peak = 0;
  for (let round = 0; round < 20 && server.sockets.stats().sockets; round += 1) {
    for (let i = 0; i < 1_000; i += 1) ada.send({ t: 'join', demo: DEMO });
    await pause(20);
    peak = Math.max(peak, server.sockets.stats().queuedBytes);
  }
  t.diagnostic(`peak queue during the join flood: ${peak} bytes`);
  assert.ok(peak < 16 * 1024, `about ${LIVE_DEMO_HUB_LIMITS.joins} small replies, not one per join (peak ${peak} bytes)`);
  await until(() => server.sockets.stats().sockets === 0, 3_000);
});

test('probe: a viewer that stops reading under a flood of frames is closed at the queue cap', async (t) => {
  const server = await start({ closeGraceMs: 200 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const bea = await live(server.port, 'room-a', 'tok-bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await bea.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);
  const raw = (ada.ws as any)._socket;
  raw.pause();
  t.after(() => raw.destroy());

  const mark = {
    id: 'dmk_floodmark', demo: DEMO, kind: 'stroke' as const, anchor: null, createdAt: new Date(0).toISOString(),
    author: { accountId: 'acct_bea', name: 'bea', color: liveDemoColor('acct_bea') },
    points: Array.from({ length: 2_000 }, (_, i) => [i % 760, i] as [number, number]),
  };
  const frameBytes = Buffer.byteLength(JSON.stringify({ t: 'mark', demo: DEMO, mark }));
  let peak = 0;
  let sent = 0;
  // Far more than the kernel buffers hold: the queue in the server must fill.
  while (server.hub.stats().connections === 2 && sent < 4_000) {
    server.hub.broadcast('room-a', DEMO, { t: 'mark', demo: DEMO, mark });
    sent += 1;
    peak = Math.max(peak, server.sockets.stats().queuedBytes);
    // One turn of the event loop per frame, so the reading viewer keeps up.
    await new Promise((resolve) => setImmediate(resolve));
  }
  t.diagnostic(`dropped after ${sent} frames of ${frameBytes} bytes; peak queue ${peak} bytes`);
  assert.equal(server.hub.stats().connections, 1, `the silent viewer was dropped after ${sent} frames`);
  assert.ok(peak <= LIVE_DEMO_HUB_LIMITS.maxQueuedBytes + 2 * frameBytes, `queued at most the cap (peak ${peak} bytes)`);
  assert.deepEqual((await bea.frames.next((frame) => frame.t === 'presence' && frame.people.length === 1)).people[0].cid, bea.hello.cid);
  await until(() => server.sockets.stats().sockets === 1, 3_000);
});

test('an invalidation during an allowing check holds the socket and runs one more check', async (t) => {
  const server = await start({ recheckMs: 60_000 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const bea = await live(server.port, 'room-a', 'tok-bea');
  ada.send({ t: 'join', demo: DEMO });
  bea.send({ t: 'join', demo: DEMO });
  await bea.frames.next((frame) => frame.t === 'presence' && frame.people.length === 2);

  // A check that allows: Bea is held during it and released after.
  let open = server.closeGate();
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'bea' });
  ada.send({ t: 'cur', demo: DEMO, x: 5, y: 5 });
  await pause(100);
  assert.equal(bea.frames.frames.filter((frame) => frame.t === 'cur').length, 0, 'nothing while held');
  open();
  await bea.frames.next((frame) => frame.t === 'presence', 2_000);
  ada.send({ t: 'cur', demo: DEMO, x: 6, y: 6 });
  assert.equal((await bea.frames.next((frame) => frame.t === 'cur')).x, 6, 'released');

  // Bea is removed while a check that read "member" is still running.
  open = server.closeGate();
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'bea' });
  await pause(20);
  server.members.delete('room-a:acct_bea');
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'bea' });
  const beaClosed = closed(bea.ws);
  open();
  assert.equal((await beaClosed).code, 4403, 'the stale allow was dropped and the next check refused');
  assert.equal(ada.ws.readyState, WebSocket.OPEN);
});

test('the app\'s pings get a pong; a ping flood from a client that stops reading closes it with nothing queued', async (t) => {
  const server = await start({ closeGraceMs: 200 });
  t.after(() => server.stop());
  const ada = await live(server.port, 'room-a', 'tok-ada');
  const pong = new Promise<Buffer>((resolve) => ada.ws.once('pong', resolve));
  ada.ws.ping(Buffer.from('desktop'));
  assert.equal(String(await pong), 'desktop', 'the desktop app keeps seeing the server alive');

  const bea = await live(server.port, 'room-a', 'tok-bea');
  const raw = (bea.ws as any)._socket;
  raw.pause();
  t.after(() => raw.destroy());
  let peak = 0;
  for (let round = 0; round < 10 && server.sockets.stats().sockets === 2; round += 1) {
    for (let i = 0; i < 1_000; i += 1) bea.ws.ping(Buffer.alloc(125, 7));
    await pause(10);
    peak = Math.max(peak, server.sockets.stats().queuedBytes);
  }
  t.diagnostic(`peak queue during the ping flood: ${peak} bytes`);
  await until(() => server.hub.stats().connections === 1, 3_000);
  await until(() => server.sockets.stats().sockets === 1, 3_000);
  assert.ok(peak < 4 * 1024, `a few pongs, not one per ping (peak ${peak} bytes)`);
  assert.equal(ada.ws.readyState, WebSocket.OPEN);
});

test('an invalidation during an upgrade\'s access check is not lost', async (t) => {
  const server = await start();
  t.after(() => server.stop());
  const views = (who: string) => server.calls.filter((call) => call.startsWith(`view:room-a:${who}:`)).length;

  // Bea is removed while her upgrade's check, which read "member", is running.
  let open = server.closeGate();
  const refused = (async () => openLive(server.port, '/rooms/room-a/live', { token: 'tok-bea' }))();
  await until(() => views('acct_bea') === 1);
  server.members.delete('room-a:acct_bea');
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'bea' });
  open();
  const answer = await refused;
  assert.equal(answer.status, 403, 'the stale allow was not used');
  assert.equal(views('acct_bea'), 2);
  assert.deepEqual(server.hub.stats(), { rooms: 0, connections: 0 });

  // An invalidation for someone else costs Ada's upgrade nothing.
  open = server.closeGate();
  const admitted = (async () => openLive(server.port, '/rooms/room-a/live', { token: 'tok-ada' }))();
  await until(() => views('acct_ada') === 1);
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'cy' });
  open();
  const first = await admitted;
  assert.equal(first.status, 101);
  assert.equal(views('acct_ada'), 1);
  (first as any).ws.close();
  await until(() => server.sockets.stats().sockets === 0);

  // A change that leaves Ada a member: checked again, then admitted.
  open = server.closeGate();
  const again = (async () => openLive(server.port, '/rooms/room-a/live', { token: 'tok-ada' }))();
  await until(() => views('acct_ada') === 2);
  server.sockets.recheckWhere({ accessRoomName: 'room-a', login: 'ada' });
  open();
  assert.equal((await again).status, 101);
  assert.equal(views('acct_ada'), 3);
});
