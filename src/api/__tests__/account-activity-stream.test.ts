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
async function server(options: { auth?: Auth; roomsFail?: boolean; admin?: boolean } = {}) {
  const working = new Map<string, string[]>();
  const presence = new EventEmitter();
  const messages = new EventEmitter();
  const joinRequestEvents = new EventEmitter();
  const mentionEvents = new EventEmitter();
  const adminChecks: string[] = [];
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
  // The live read re-check, one fake lease per top-level room: `readable`
  // answers it, `invalidate` fires its invalidation handlers.
  const readable = new Map<string, boolean | 'error'>();
  const checks: string[] = [];
  const invalidationHandlers = new Map<string, Set<() => void>>();
  const stale = new Set<string>();
  const leaseChecksSince = new Map<string, number>();
  let credentialValid = true;
  const app = express();
  app.use((req, _res, next) => {
    const auth = options.auth === undefined ? 'session' : options.auth;
    Object.assign(req, { authKind: auth, sessionAccount: auth && auth !== 'agent_session' ? { account_id: 'acct-1', login: 'Emmy' } : null });
    next();
  });
  registerAccountActivityStreamRoute(app, {
    hub,
    joinRequestEvents,
    mentionEvents,
    isRoomAdmin: async (accountId, roomId) => { adminChecks.push(`${accountId}:${roomId}`); return options.admin ?? false; },
    credentialStillValid: async () => credentialValid,
    openRoomAuthorization: async (_req, roomId) => {
      const handlers = invalidationHandlers.get(roomId) ?? new Set<() => void>();
      invalidationHandlers.set(roomId, handlers);
      stale.add(roomId);
      let allowed = true;
      let failed = false;
      return {
        // Like the real lease: a stale lease asks again, a fresh one reuses its answer.
        async check(checkOptions) {
          if (!stale.has(roomId) && !checkOptions?.force) return allowed;
          checks.push(roomId);
          leaseChecksSince.set(roomId, (leaseChecksSince.get(roomId) ?? 0) + 1);
          stale.delete(roomId);
          const answer = readable.get(roomId) ?? true;
          // 'error': GitHub gave no answer; like the real lease, ask again next time.
          failed = answer === 'error';
          if (failed) { stale.add(roomId); allowed = false; return false; }
          allowed = answer as boolean;
          return allowed;
        },
        lastCheckFailed: () => failed,
        onInvalidated(handler) { handlers.add(handler); return () => handlers.delete(handler); },
        release() {},
      };
    },
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
    base, hub, presence, working, listedFor, joinRequestEvents, mentionEvents, adminChecks, readable, checks,
    invalidate(roomId: string) {
      stale.add(roomId);
      for (const handler of invalidationHandlers.get(roomId) ?? []) handler();
    },
    handlerCount: (roomId: string) => invalidationHandlers.get(roomId)?.size ?? 0,
    revokeCredential() { credentialValid = false; },
    async close() { hub.close(); await new Promise(resolve => http.close(resolve)); },
  };
}

const joinRequest = {
  id: 'rjr_1', room_id: 'invite-room', account_id: 'acct-ask', login: 'asker', display_name: 'Asker', avatar_url: null,
  state: 'pending', created_at: '2026-11-07T00:00:00.000Z', decided_at: null, retry_after: null, decided_by_login: null,
};
function emitJoinRequest(s: Awaited<ReturnType<typeof server>>, projectId = 'invite-room', accessRoomId = 'invite-room') {
  s.joinRequestEvents.emit('join_request:changed', { projectId, accessRoomId, roomDisplayName: 'Invite room', request: joinRequest });
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
    const deadline = Date.now() + 5_000;
    while (s.hub.watches('invite-room') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(s.hub.watches('invite-room'), false);
  } finally { await s.close(); }
});

test('a request to join one of the rooms reaches an admin, with the requester and the room name', async () => {
  const s = await server({ admin: true });
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    // Published on the access room and on its focus room: the account stream sends it once.
    emitJoinRequest(s, 'focus_9', 'invite-room');
    emitJoinRequest(s);
    const [, frame] = await reading;
    assert.equal(frame.event, 'join_request');
    assert.deepEqual(frame.data, {
      room_id: 'invite-room', access_room_id: 'invite-room',
      request: { ...joinRequest, room_display_name: 'Invite room' },
    });
    assert.deepEqual(s.adminChecks, ['acct-1:invite-room'], 'the role is checked once per request, for the access room');
  } finally { await s.close(); }
});

test('a member who is not an admin, an owner token, and a room the account is not in get no join request', async () => {
  for (const [options, label] of [[{ admin: false }, 'member'], [{ admin: true, auth: 'owner_token' as const }, 'owner token']] as const) {
    const s = await server(options);
    try {
      const response = await fetch(`${s.base}/account/activity/stream`);
      const reading = readEvents(response, 2);
      await new Promise(resolve => setTimeout(resolve, 100));
      emitJoinRequest(s);
      emitJoinRequest(s, 'someone-elses-room', 'someone-elses-room');
      await new Promise(resolve => setTimeout(resolve, 100));
      s.working.set('invite-room', ['CedarRidge']);
      s.presence.emit(PRESENCE_CHANGED, 'invite-room');
      const events = await reading;
      assert.deepEqual(events.map(e => e.event), ['snapshot', 'room'], `${label}: no join_request frame`);
      if (label === 'owner token') assert.deepEqual(s.adminChecks, [], 'an owner token is never even checked');
      else assert.deepEqual(s.adminChecks, ['acct-1:invite-room'], 'a room the account is not in is never checked');
    } finally { await s.close(); }
  }
});

test('a read the account records in a watched room reaches its stream; others do not', async () => {
  const { accountReadEvents, ACCOUNT_ROOM_READ } = await import('../account-unread/read-events.js');
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    accountReadEvents.emit(ACCOUNT_ROOM_READ, { accountId: 'acct-2', roomId: 'invite-room', lastMessageId: 'msg_1' });
    accountReadEvents.emit(ACCOUNT_ROOM_READ, { accountId: 'acct-1', roomId: 'unwatched-room', lastMessageId: 'msg_1' });
    accountReadEvents.emit(ACCOUNT_ROOM_READ, { accountId: 'acct-1', roomId: 'Focus_1', lastMessageId: 'msg_7' });
    const events = await reading;
    assert.deepEqual(events.map(event => event.event), ['snapshot', 'room_read']);
    assert.deepEqual(events[1]!.data, { room_id: 'Focus_1', last_message_id: 'msg_7' });
  } finally { await s.close(); }
});

async function waitFor(condition: () => boolean, label: string) {
  for (let i = 0; i < 80 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(condition(), label);
}

test('a room the account can no longer read stops appearing in frames after an invalidation, and comes back after one', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 4);
    await new Promise(resolve => setTimeout(resolve, 100));
    s.working.set('focus_1', ['MapleRidge']);
    s.presence.emit(PRESENCE_CHANGED, 'focus_1');
    await waitFor(() => s.checks.length === 1, 'the first frame of a room re-checks it once');
    assert.deepEqual(s.checks, ['focus_1'], 'a focus room is judged by its own lease, as the room gates judge it');

    // GitHub says the person left the repository: the webhook clears the cache.
    s.readable.set('focus_1', false);
    s.readable.set('github.com/org/repo', false);
    s.invalidate('focus_1');
    s.working.set('focus_1', ['MapleRidge', 'Second']);
    s.presence.emit(PRESENCE_CHANGED, 'focus_1');
    await waitFor(() => s.checks.length === 2, 'the next frame after the invalidation re-checks');
    s.working.set('github.com/org/repo', ['Third']);
    s.presence.emit(PRESENCE_CHANGED, 'github.com/org/repo');
    await waitFor(() => s.checks.length === 3, 'the parent room is checked on its own');
    s.working.set('focus_1', ['Again']);
    s.presence.emit(PRESENCE_CHANGED, 'focus_1');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(s.checks.length, 3, 'a refusal is kept for the lease period: no check per frame');

    // Access comes back (a webhook again): the room shows again.
    s.readable.set('focus_1', true);
    s.invalidate('focus_1');
    s.working.set('focus_1', ['Fourth']);
    s.presence.emit(PRESENCE_CHANGED, 'focus_1');
    s.working.set('invite-room', ['CedarRidge']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const events = await reading;
    assert.deepEqual(
      events.map(e => `${e.data.room_id ?? 'snapshot'}${e.data.working ? `:${e.data.working.map((a: any) => a.display_name).join('+')}` : ''}`),
      ['snapshot', 'focus_1:MapleRidge', 'focus_1:Fourth', 'invite-room:CedarRidge'],
      'no frame about a room while it was refused',
    );
  } finally { await s.close(); }
});

test('a check that gets no answer skips that frame only; the next frame asks again', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    s.readable.set('invite-room', 'error');
    s.working.set('invite-room', ['DuringOutage']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    await waitFor(() => s.checks.length === 1, 'checked once');
    s.readable.set('invite-room', true);
    s.working.set('invite-room', ['AfterRecovery']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const events = await reading;
    assert.deepEqual(events.map(e => e.data.working?.[0]?.display_name ?? e.event), ['snapshot', 'AfterRecovery']);
    assert.deepEqual(s.checks, ['invite-room', 'invite-room']);
  } finally { await s.close(); }
});

test('a frame within the lease period reuses the answer; a revoked credential closes the stream', async () => {
  const s = await server();
  try {
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 10);
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const name of ['A', 'B', 'C']) {
      s.working.set('invite-room', [name]);
      s.presence.emit(PRESENCE_CHANGED, 'invite-room');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await waitFor(() => s.checks.length >= 1, 'checked');
    assert.deepEqual(s.checks, ['invite-room'], 'three frames, one check');

    s.revokeCredential();
    s.readable.set('invite-room', false);
    s.invalidate('invite-room');
    s.working.set('invite-room', ['D']);
    s.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const events = await reading;
    assert.ok(!events.some(e => e.data.working?.[0]?.display_name === 'D'), 'nothing after the refusal');
    assert.equal(events.at(-1)?.data.room_id, 'invite-room');
    await waitFor(() => s.handlerCount('invite-room') === 0, 'the closed stream stops listening for invalidations');
  } finally { await s.close(); }
});

test('targeted room_mention frames reach session streams for unopened and archived rooms after live authorization, and block unauthorized or owner_token streams', async () => {
  const s = await server();
  try {
    s.readable.set('focus_unopened', true);
    s.readable.set('archived-room', true);
    s.readable.set('secret-room', false);
    const response = await fetch(`${s.base}/account/activity/stream`);
    const reading = readEvents(response, 3);
    await new Promise(resolve => setTimeout(resolve, 100));

    // Ignored: another target account, self human publisher, or denied room authorization.
    s.mentionEvents.emit('room_mention:created', {
      projectId: 'focus_unopened',
      roomDisplayName: 'Unopened Focus',
      messageId: 'msg_1',
      threadRootId: null,
      targetAccountIds: ['acct-other'],
      publisherAccountId: null,
    });
    s.mentionEvents.emit('room_mention:created', {
      projectId: 'focus_unopened',
      roomDisplayName: 'Unopened Focus',
      messageId: 'msg_2',
      threadRootId: null,
      targetAccountIds: ['acct-1'],
      publisherAccountId: 'acct-1',
    });
    s.mentionEvents.emit('room_mention:created', {
      projectId: 'secret-room',
      roomDisplayName: 'Secret Room',
      messageId: 'msg_3',
      threadRootId: null,
      targetAccountIds: ['acct-1'],
      publisherAccountId: null,
    });

    // Allowed: unopened Focus Room and archived room (neither is in getAccountRoomsForAccount).
    s.mentionEvents.emit('room_mention:created', {
      projectId: 'focus_unopened',
      roomDisplayName: 'Unopened Focus',
      messageId: 'msg_4',
      threadRootId: null,
      targetAccountIds: ['acct-1'],
      publisherAccountId: null,
    });
    s.mentionEvents.emit('room_mention:created', {
      projectId: 'archived-room',
      roomDisplayName: 'Archived Room',
      messageId: 'msg_9',
      threadRootId: 'msg_5',
      targetAccountIds: ['acct-1'],
      publisherAccountId: null,
    });

    const events = await reading;
    assert.deepEqual(events.map(e => e.event), ['snapshot', 'room_mention', 'room_mention']);
    assert.deepEqual(events[1]!.data, {
      room_id: 'focus_unopened',
      room_display_name: 'Unopened Focus',
      message_id: 'msg_4',
      thread_root_id: null,
    });
    assert.deepEqual(events[2]!.data, {
      room_id: 'archived-room',
      room_display_name: 'Archived Room',
      message_id: 'msg_9',
      thread_root_id: 'msg_5',
    });
    assert.deepEqual(s.checks, ['secret-room', 'focus_unopened', 'archived-room']);
  } finally {
    await s.close();
  }

  // `owner_token` never receives `room_mention` frames.
  const owner = await server({ auth: 'owner_token' });
  try {
    const response = await fetch(`${owner.base}/account/activity/stream`);
    const reading = readEvents(response, 2);
    await new Promise(resolve => setTimeout(resolve, 100));
    owner.mentionEvents.emit('room_mention:created', {
      projectId: 'focus_unopened',
      roomDisplayName: 'Unopened Focus',
      messageId: 'msg_10',
      threadRootId: null,
      targetAccountIds: ['acct-1'],
      publisherAccountId: null,
    });
    owner.working.set('invite-room', ['CedarRidge']);
    owner.presence.emit(PRESENCE_CHANGED, 'invite-room');
    const events = await reading;
    assert.deepEqual(events.map(e => e.event), ['snapshot', 'room']);
  } finally {
    await owner.close();
  }
});
