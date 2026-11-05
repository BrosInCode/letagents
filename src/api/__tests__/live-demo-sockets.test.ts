import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import WebSocket from 'ws';

import { liveDemoColor } from '../../../shared/live-demo.mjs';
import type { LiveDemoAccess, LiveRoomDecision } from '../live-demos/access.js';
import { createLiveDemoHub } from '../live-demos/hub.js';
import { attachLiveDemoSockets, type LiveDemoSocketLimits } from '../live-demos/sockets.js';
import { closedWith as closed, joinLive as live, openLive as open, until } from './live-demo-client.js';

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
  const access: LiveDemoAccess = {
    authenticate: async (token) => { calls.push(`auth:${token}`); return (tokens.get(token) ?? null) as any; },
    findRoom: async (id) => (rooms.get(id) ?? null) as any,
    canView: async (room, person) => ({
      decision: room.id.startsWith('github.com/') ? repoDecision : members.has(`${room.id}:${person.account_id}`) ? 'allow' : 'deny',
      accessRoomName: room.id,
    }),
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
  assert.deepEqual(server.sockets.stats(), { sockets: 0, handshakes: 0 });

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
