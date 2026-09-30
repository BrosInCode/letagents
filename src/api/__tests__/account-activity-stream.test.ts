import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { AccountActivityHub } = await import('../account-activity/hub.js');
const { registerAccountActivityStreamRoute } = await import('../routes/account/activity-stream.js');
const { PRESENCE_CHANGED } = await import('../server/presence-change-events.js');
import type { WorkingPresence } from '../account-activity/hub.js';

type Auth = 'session' | 'owner_token' | 'agent_session' | null;

/** A real HTTP server with the stream route, a fake account, and rooms it is a member of. */
async function server(options: { auth?: Auth; roomsFail?: boolean } = {}) {
  const working = new Map<string, string[]>();
  const presence = new EventEmitter();
  const messages = new EventEmitter();
  const hub = new AccountActivityHub({
    async loadWorking(roomIds) {
      const result = new Map<string, WorkingPresence>();
      for (const id of roomIds) {
        const names = working.get(id);
        if (names?.length) result.set(id, { agents: names.map(name => ({ agent_key: name, display_name: name })), oldestHeartbeatMs: Date.now() });
      }
      return result;
    },
    async loadLatest() { return new Map(); },
  }, { coalesceMs: 5 });
  hub.attach({ presence, messages });
  const listedFor: string[] = [];
  const app = express();
  app.use((req, _res, next) => {
    const auth = options.auth === undefined ? 'session' : options.auth;
    Object.assign(req, { authKind: auth, sessionAccount: auth && auth !== 'agent_session' ? { account_id: 'acct-1', login: 'Emmy' } : null });
    next();
  });
  registerAccountActivityStreamRoute(app, {
    hub,
    getAccountRoomsForAccount: (async (accountId: string) => {
      listedFor.push(accountId);
      if (options.roomsFail) throw new Error('database unavailable');
      return [
        { room_id: 'github.com/org/repo', focus_rooms: [{ room_id: 'focus_1' }] },
        { room_id: 'invite-room', focus_rooms: [] },
      ];
    }) as never,
  });
  const http = app.listen(0);
  await new Promise(resolve => http.once('listening', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    base, hub, presence, working, listedFor,
    async close() { hub.close(); await new Promise(resolve => http.close(resolve)); },
  };
}

/** Reads server-sent events until `count` have arrived. */
async function readEvents(response: Response, count: number): Promise<Array<{ event: string; data: any }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: any }> = [];
  let buffer = '';
  const deadline = Date.now() + 3_000;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

test('the stream opens with every room the account is in, focus rooms included', async () => {
  const s = await server();
  s.working.set('focus_1', ['MapleRidge']);
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const [snapshot] = await readEvents(response, 1);
    assert.equal(snapshot.event, 'snapshot');
    assert.deepEqual(snapshot.data.rooms.map((room: any) => room.room_id), ['github.com/org/repo', 'focus_1', 'invite-room']);
    assert.deepEqual(snapshot.data.rooms[1].working, [{ agent_key: 'MapleRidge', display_name: 'MapleRidge' }]);
    assert.deepEqual(s.listedFor, ['acct-1']);
  } finally { await s.close(); }
});

test('an agent starting work in one of the rooms is pushed to the open stream', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    s.working.set('invite-room', ['CedarRidge']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const [, update] = await reading;
    assert.equal(update.event, 'room');
    assert.equal(update.data.room_id, 'invite-room');
    assert.deepEqual(update.data.working.map((agent: any) => agent.display_name), ['CedarRidge']);
  } finally { await s.close(); }
});

test('rooms the account is not in are never sent', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    s.working.set('someone-elses-room', ['Intruder']);
    s.presence.emit(PRESENCE_CHANGED, 'someone-elses-room');
    await new Promise(resolve => setTimeout(resolve, 100));
    s.working.set('invite-room', ['CedarRidge']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const events = await reading;
    assert.deepEqual(events.map(e => e.data.room_id ?? 'snapshot'), ['snapshot', 'invite-room']);
    assert.equal(s.hub.watches('someone-elses-room'), false);
  } finally { await s.close(); }
});

test('only a signed-in account may open the stream; agents may not', async () => {
  for (const auth of [null, 'agent_session'] as const) {
    const s = await server({ auth });
    try {
      const response = await fetch(`${s.base}/account/activity/stream`);
      assert.equal(response.status, 401, `${auth} is refused`);
      assert.deepEqual(s.listedFor, [], 'and no rooms are looked up for it');
    } finally { await s.close(); }
  }
  const owner = await server({ auth: 'owner_token' });
  try { assert.equal((await fetch(`${owner.base}/account/activity/stream`)).status, 200); }
  finally { await owner.close(); }
});

test('a failure to list rooms is answered, not left hanging', async () => {
  const s = await server({ roomsFail: true });
  const original = console.error; console.error = () => undefined;
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /could not be loaded/);
  } finally { console.error = original; await s.close(); }
});

test('closing the stream stops watching its rooms', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    await readEvents(response, 1);
    for (let i = 0; i < 20 && s.hub.watches('invite-room'); i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(s.hub.watches('invite-room'), false);
  } finally { await s.close(); }
});
