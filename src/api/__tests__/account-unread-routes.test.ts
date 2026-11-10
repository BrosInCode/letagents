import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerAccountUnreadRoutes } = await import('../routes/account/unread.js');

async function server(auth: string | null) {
  const calls: unknown[] = [];
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { authKind: auth, sessionAccount: auth && auth !== 'agent_session' ? { account_id: 'acct-1', login: 'Emmy', display_name: 'Emmy M' } : null });
    next();
  });
  registerAccountUnreadRoutes(app, {
    getAccountRoomsForAccount: (async (accountId: string, options: unknown) => {
      calls.push(['rooms', accountId, options]);
      return [
        { room_id: 'github.com/org/repo', role: 'admin', latest_message_at: 'T1', focus_rooms: [{ room_id: 'focus_1', role: 'participant', latest_message_at: null }] },
        { room_id: 'invite-room', role: 'participant', latest_message_at: 'T2', focus_rooms: [] },
      ];
    }) as never,
    loadAccountRoomUnread: (async (input: unknown) => { calls.push(['unread', input]); return [{ room_id: 'invite-room', read_message_id: 'msg_3', unread_count: 4, github_unread_count: 1 }]; }) as never,
    loadAccountAttention: (async (account: unknown, rooms: unknown) => { calls.push(['attention', rooms]); return { rooms: [], failures: [{ room_id: 'focus_1' }] }; }) as never,
    // GitHub cannot answer for the repo room right now.
    mayCount: async (_accountId: string, roomId: string) => roomId !== 'github.com/org/repo',
  });
  const http = app.listen(0);
  await new Promise(resolve => http.once('listening', resolve));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, calls, close: () => new Promise(resolve => http.close(resolve)) };
}

test('account unread and attention need a signed-in person', async () => {
  for (const auth of [null, 'agent_session']) {
    const s = await server(auth);
    try {
      assert.equal((await fetch(`${s.base}/account/unread`)).status, 401);
      assert.equal((await fetch(`${s.base}/account/attention`)).status, 401);
      assert.deepEqual(s.calls, []);
    } finally { await s.close(); }
  }
});

test('account unread covers the listed rooms and their focus rooms, with the person\'s own names', async () => {
  const s = await server('session');
  try {
    const response = await fetch(`${s.base}/account/unread`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rooms: [
      { room_id: 'github.com/org/repo', read_message_id: null, unread_count: null, github_unread_count: null },
      { room_id: 'focus_1', read_message_id: null, unread_count: null, github_unread_count: null },
      { room_id: 'invite-room', read_message_id: 'msg_3', unread_count: 4, github_unread_count: 1 },
    ], cap: 1000, limited: false });
    assert.equal(s.calls.length, 2);
    const [, unread] = s.calls as [unknown, [string, { roomIds: string[] }]];
    assert.deepEqual({ ...unread[1], roomIds: [...unread[1].roomIds].sort() },
      { accountId: 'acct-1', ownSenderNames: ['Emmy', 'Emmy M'], roomIds: ['focus_1', 'invite-room'] },
      'a room whose access cannot be decided now is not counted');
  } finally { await s.close(); }
});

test('account attention passes each room with its role and latest message time', async () => {
  const s = await server('owner_token');
  try {
    const response = await fetch(`${s.base}/account/attention`);
    assert.deepEqual(await response.json(), { rooms: [], failures: [{ room_id: 'focus_1' }], limited: false });
    assert.deepEqual(s.calls[1], ['attention', [
      { room_id: 'github.com/org/repo', role: 'admin', latest_message_at: 'T1' },
      { room_id: 'focus_1', role: 'participant', latest_message_at: null },
      { room_id: 'invite-room', role: 'participant', latest_message_at: 'T2' },
    ]]);
  } finally { await s.close(); }
});

test('account attention uses at most three connections: three rooms at once, one read at a time per room', async () => {
  const { loadAccountAttention } = await import('../account-unread/attention.js');
  let inFlight = 0;
  let peak = 0;
  const read = async <T>(value: T): Promise<T> => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    return value;
  };
  const rooms = Array.from({ length: 12 }, (_, index) => ({ room_id: `room-${index}`, role: 'admin' as const, latest_message_at: null }));
  const taskReads: string[][] = [];
  const result = await loadAccountAttention({ account_id: 'acct-1', provider: 'github', login: 'Emmy', provider_access_token: null }, rooms, {
    getProject: async (roomId) => read({ id: roomId } as never),
    mayRead: async (project) => read((project as { id: string }).id !== 'room-3'),
    listRequests: async () => read({ records: [], truncated: false }),
    listBoardIntents: async () => read([]),
    getTasks: async (roomIds) => { taskReads.push([...roomIds]); return [{ room_id: 'room-1', id: 'task_1', title: 'T', status: 'blocked', description: null, updated_at: 'U' }]; },
    now: () => 0,
  });
  assert.ok(peak <= 3, `peak ${peak} reads at once`);
  assert.equal(taskReads.length, 1, 'one card read for every room');
  assert.equal(result.rooms.length, 11);
  assert.deepEqual(result.failures, [{ room_id: 'room-3' }]);
  assert.deepEqual(result.rooms.find(room => room.room_id === 'room-1')!.tasks.map(task => task.id), ['task_1']);
});
