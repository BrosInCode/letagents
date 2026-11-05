import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';

import type { LiveRoomDecision } from '../live-demos/access.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerDemoMarkRoutes } = await import('../routes/rooms/demo-marks.js');

// The marks routes with stub access and store; live-demos-db.test.ts runs them
// on the real server and Postgres.

type Auth = 'session' | 'owner_token' | 'agent_session' | null;
const DEMO = 'msg_1/att_1';
const stroke = { demo: DEMO, kind: 'stroke', points: [[1, 1], [2, 2]], anchor: null };

function harness(options: { decision?: LiveRoomDecision; full?: 'marks' | 'points'; saved?: 'exists' | 'id_taken' } = {}) {
  const broadcasts: string[] = [];
  const routes: Array<{ method: string; path: RegExp; handler: Function }> = [];
  const app = Object.fromEntries(['get', 'post', 'delete'].map((method) => [
    method,
    (path: RegExp, handler: Function) => routes.push({ method, path, handler }),
  ])) as unknown as Express;
  const calls: string[] = [];
  let clock = 1_000_000;
  registerDemoMarkRoutes(app, {
    access: {
      findRoom: async (id) => {
        calls.push(`find:${id}`);
        return id === 'design-lounge' ? { id, display_name: 'Design lounge', focus_key: null } as any : null;
      },
      canView: async () => ({ decision: options.decision ?? 'allow', accessRoomName: 'design-lounge' }),
    },
    demoMarkStore: {
      listDemoMarks: async () => [],
      createDemoMark: async () => (options.full
        ? { kind: 'full', reason: options.full }
        : options.saved === 'id_taken'
          ? { kind: 'id_taken' }
          : { kind: options.saved ?? 'created', mark: { id: 'dmk_12345678', demo: DEMO } as any }),
      getDemoMarkOwner: async () => ({ accountId: 'ada', demo: DEMO }),
      deleteDemoMark: async () => true,
    },
    resolveProjectRole: async () => 'participant',
    liveDemoHub: { broadcast: (_room: string, _demo: string, frame: { t: string }) => { broadcasts.push(frame.t); } } as any,
    writeLimit: { burst: 3, perSecond: 1, now: () => clock },
  });

  async function request(method: string, path: string, options: { auth?: Auth; account?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const route = routes.find((candidate) => candidate.method === method && candidate.path.test(path.split('?')[0]!));
    assert.ok(route, `${method} ${path} is routed`);
    const [pathname, query = ''] = path.split('?');
    const matches = pathname!.match(route.path)!;
    const auth = options.auth === undefined ? 'session' : options.auth;
    const headers: Record<string, string> = options.headers ?? { authorization: 'Bearer app-token' };
    const req = {
      method: method.toUpperCase(),
      params: Object.fromEntries(matches.slice(1).map((value, index) => [index, value])),
      query: Object.fromEntries(new URLSearchParams(query)),
      body: options.body ?? {},
      authKind: auth,
      sessionAccount: auth && auth !== 'agent_session' ? { account_id: options.account ?? 'ada', login: options.account ?? 'ada' } : null,
      headers,
      protocol: 'http',
      get: () => 'localhost:3001',
    };
    let status = 200;
    let body: any;
    const sent: Record<string, string> = {};
    const res = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
      setHeader(name: string, value: string) { sent[name.toLowerCase()] = value; },
      end() { return this; },
    };
    await route.handler(req, res);
    return { status, body, headers: sent };
  }

  return { request, calls, broadcasts, tick: (ms: number) => { clock += ms; } };
}

test('the person is checked before the room is looked up', async () => {
  const { request, calls } = harness();
  for (const [method, path, body] of [
    ['get', `/rooms/design-lounge/demo-marks?demo=${encodeURIComponent(DEMO)}`, undefined],
    ['post', '/rooms/design-lounge/demo-marks', stroke],
    ['delete', '/rooms/design-lounge/demo-marks/dmk_12345678', undefined],
  ] as const) {
    assert.equal((await request(method, path, { auth: null, body })).status, 401, `${method} without a sign-in`);
    assert.equal((await request(method, path, { auth: 'agent_session', body })).status, 403, `${method} by an agent`);
    assert.equal((await request(method, path, { auth: 'owner_token', body })).status, 403, `${method} by an owner token`);
    assert.equal((await request(method, path.replace('design-lounge', 'no-such-room'), { auth: null, body })).status, 401,
      'an unknown room looks the same as a known one');
  }
  assert.deepEqual(calls, [], 'no room was looked up');
});

test('a person who cannot read the room gets one plain refusal with no room name', async () => {
  for (const decision of ['deny', 'unavailable'] as const) {
    const { request } = harness({ decision });
    const answer = await request('get', `/rooms/design-lounge/demo-marks?demo=${encodeURIComponent(DEMO)}`);
    if (decision === 'deny') {
      assert.deepEqual(answer, {
        status: 403,
        body: { error: 'room_access_required', message: 'Only people who can open this room can see its demo marks.' },
        headers: {},
      });
    } else {
      assert.equal(answer.status, 503);
      assert.equal(answer.headers['retry-after'], '30');
    }
  }
  const { request } = harness();
  assert.deepEqual((await request('post', '/rooms/elsewhere/demo-marks', { body: stroke })).body.error, 'room_not_found');
  assert.equal((await request('post', '/rooms/%E0%A4%A/demo-marks', { body: stroke })).status, 400);
});

test('saves and removals are rate limited per account; reads are not', async () => {
  const { request, tick } = harness();
  assert.equal((await request('post', '/rooms/design-lounge/demo-marks', { body: stroke })).status, 201);
  assert.equal((await request('delete', '/rooms/design-lounge/demo-marks/dmk_12345678')).status, 204);
  assert.equal((await request('post', '/rooms/design-lounge/demo-marks', { body: { bad: true } })).status, 400, 'a refused write counts too');
  const limited = await request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([limited.status, limited.body.error, limited.headers['retry-after']], [429, 'demo_marks_rate_limited', '1']);
  assert.equal((await request('delete', '/rooms/design-lounge/demo-marks/dmk_12345678')).status, 429);
  assert.equal((await request('get', `/rooms/design-lounge/demo-marks?demo=${encodeURIComponent(DEMO)}`)).status, 200);
  assert.equal((await request('post', '/rooms/design-lounge/demo-marks', { body: stroke, account: 'bea' })).status, 201, 'another account');
  tick(1_000);
  assert.equal((await request('post', '/rooms/design-lounge/demo-marks', { body: stroke })).status, 201, 'one more a second');
});

test('a save sent again returns the saved mark without a second broadcast; an id of another mark is refused', async () => {
  const first = harness();
  const created = await first.request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([created.status, created.body.mark.id, first.broadcasts], [201, 'dmk_12345678', ['mark']]);
  const again = harness({ saved: 'exists' });
  const repeated = await again.request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([repeated.status, repeated.body.mark.id, again.broadcasts], [200, 'dmk_12345678', []]);
  const taken = harness({ saved: 'id_taken' });
  const refused = await taken.request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([refused.status, refused.body.error, taken.broadcasts], [409, 'demo_mark_id_taken', []]);
});

test('a mark id must have the shape the server makes', async () => {
  const { request } = harness();
  const bad = await request('post', '/rooms/design-lounge/demo-marks', { body: { ...stroke, id: 'dmk_short' } });
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_mark']);
  const good = await request('post', '/rooms/design-lounge/demo-marks', { body: { ...stroke, id: 'dmk_AAAAAAAAAAAAAAAAAAAAAA' } });
  assert.equal(good.status, 201);
});

test('a full demo answers 409 with the reason', async () => {
  const marks = await harness({ full: 'marks' }).request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([marks.status, marks.body.error], [409, 'demo_marks_full']);
  const points = await harness({ full: 'points' }).request('post', '/rooms/design-lounge/demo-marks', { body: stroke });
  assert.deepEqual([points.status, points.body.error], [409, 'demo_marks_too_large']);
});

test('a cookie write from another site is refused before anything else', async () => {
  const { request, calls } = harness();
  const answer = await request('post', '/rooms/design-lounge/demo-marks', {
    body: stroke, headers: { cookie: 'letagents_session=x', origin: 'https://evil.example' },
  });
  assert.deepEqual([answer.status, answer.body.error], [403, 'cross_site_write']);
  assert.deepEqual(calls, []);
});
