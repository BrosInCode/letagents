import assert from 'node:assert/strict';
import test from 'node:test';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerRoomNotificationPreferenceRoutes } = await import('../routes/rooms/notification-preferences.js');

function harness(options: { denied?: boolean; error?: unknown; invalidTime?: boolean } = {}) {
  const routes: any[] = [];
  const calls: any[] = [];
  const app = Object.fromEntries(['get', 'put'].map(method => [method, (path: string | RegExp, handler: Function) => routes.push({ method, path, handler })]));
  const preference = { room_id: 'canonical-room', level: 'all', snoozed_until: null };
  registerRoomNotificationPreferenceRoutes(app as any, {
    resolveCanonicalRoomRequestId: async () => 'canonical-room',
    resolveRoomOrReply: async (id: string) => ({ id }),
    requireParticipant: async (_req: unknown, res: any) => {
      if (options.denied) { res.status(403).json({ error: 'Forbidden' }); return false; }
      return true;
    },
    emitProjectMessage: () => assert.fail('preferences must not emit messages'),
    notificationPreferenceStore: {
      getRoomNotificationPreference: async (...args: any[]) => { calls.push(['get', ...args]); return preference; },
      listRoomNotificationPreferences: async (...args: any[]) => { calls.push(['list', ...args]); return { preferences: [], truncated: false }; },
      setRoomNotificationPreference: async (...args: any[]) => {
        calls.push(['put', ...args]); if (options.error) throw options.error;
        return options.invalidTime ? null : { ...preference, ...args[2] };
      },
    },
  } as any);
  async function request(method: string, path: string, body?: unknown, auth: string | null = 'session', accountId = 'person-a') {
    const route = routes.find(r => r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path)));
    assert.ok(route);
    const params = typeof route.path === 'string' ? {} : Object.fromEntries(path.match(route.path)!.slice(1).map((p, i) => [i, decodeURIComponent(p)]));
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(value: any) { this.body = value; return this; } };
    await route.handler({ params, body, authKind: auth, headers: {}, query: { account_id: 'victim' }, sessionAccount: { account_id: accountId, login: accountId } }, res);
    return res;
  }
  return { request, calls };
}
const roomPath = '/rooms/alias/notification-preferences';
const bulkPath = '/account/room-notification-preferences';

test('all preference routes require a person, even when an agent holds an owner token', async () => {
  const api = harness();
  for (const [auth, status] of [[null, 401], ['owner_token', 403], ['agent_session', 403]] as const) {
    for (const [method, path] of [['get', roomPath], ['put', roomPath], ['get', bulkPath]]) {
      assert.equal((await api.request(method, path, { level: 'muted' }, auth)).code, status);
    }
  }
  assert.deepEqual(api.calls, []);
});

test('room routes resolve access and canonical ID; account always comes from the session', async () => {
  const api = harness();
  assert.equal((await api.request('get', roomPath)).code, 200);
  assert.equal((await api.request('put', roomPath, { level: 'mentions' }, 'session', 'person-b')).code, 200);
  assert.equal((await api.request('get', bulkPath, undefined, 'session', 'person-b')).code, 200);
  assert.deepEqual(api.calls, [['get', 'person-a', 'canonical-room'], ['put', 'person-b', 'canonical-room', { level: 'mentions' }], ['list', 'person-b']]);
  const denied = harness({ denied: true });
  assert.equal((await denied.request('get', roomPath)).code, 403);
  assert.equal((await denied.request('put', roomPath, { level: 'muted' })).code, 403);
  assert.deepEqual(denied.calls, []);
});

test('PUT validates changed fields and sends independent updates and absolute time to the DB', async () => {
  const api = harness();
  for (const body of [{}, [], { level: 'loud' }, { account_id: 'victim', level: 'muted' }, { snoozed_until: 'tomorrow' }, { snoozed_until: '2026-10-02T09:00:00' }, { snoozed_until: 9 }]) {
    assert.equal((await api.request('put', roomPath, body)).code, 400, JSON.stringify(body));
  }
  assert.deepEqual(api.calls, []);
  assert.equal((await api.request('put', roomPath, { snoozed_until: '2026-10-03T09:00:00+01:00' })).code, 200);
  assert.deepEqual(api.calls.at(-1)[3], { snoozed_until: '2026-10-03T08:00:00.000Z' });
  assert.equal((await api.request('put', roomPath, { snoozed_until: null })).code, 200);
  assert.deepEqual(api.calls.at(-1)[3], { snoozed_until: null });
  assert.equal((await harness({ invalidTime: true }).request('put', roomPath, { snoozed_until: '2026-10-03T09:00:00Z' })).code, 400);
  assert.equal((await harness({ error: { code: '55P03' } }).request('put', roomPath, { level: 'muted' })).code, 503);
});
