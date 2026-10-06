import assert from 'node:assert/strict';
import test from 'node:test';
import type { Express } from 'express';
import {
  MESSAGE_SEARCH_MAX_QUERY_CHARS,
  MESSAGE_SEARCH_MAX_TERMS,
  parseMessageSearchQuery,
  textMatchesMessageSearch,
} from '../../../shared/message-search.mjs';
import { requiredAgentSessionRouteCapability } from '../request/agent-session-route-capabilities.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerMessageSearchRoute } = await import('../routes/rooms/messages/search.js');

const room = 'github.com/org/repo';

function harness(options: { denied?: boolean; fails?: unknown; accessFails?: unknown } = {}) {
  const routes: Array<{ path: RegExp; handler: Function }> = [];
  const calls: Array<{ roomId: string; terms: readonly string[]; options: unknown }> = [];
  const app = { get: (path: RegExp, handler: Function) => routes.push({ path, handler }) } as unknown as Express;
  registerMessageSearchRoute(app, {
    resolveCanonicalRoomRequestId: async (id: string) => { if (options.accessFails) throw options.accessFails; return id; },
    resolveRoomOrReply: async (id: string) => ({ id } as any),
    requireParticipant: async (_req: unknown, res: any) => {
      if (options.denied) { res.status(403).json({ error: 'Forbidden' }); return false; }
      return true;
    },
    searchRoomMessages: async (roomId: string, terms: readonly string[], searchOptions: unknown) => {
      if (options.fails) throw options.fails;
      calls.push({ roomId, terms, options: searchOptions });
      return { messages: [{ id: 'msg_9', text: 'needle' }] as any, has_more: true, next_before: 'msg_9' };
    },
  } as any);
  async function get(query: Record<string, unknown>, account: string | null = 'emmy') {
    const path = `/rooms/${room}/messages/search`;
    const route = routes.find((candidate) => candidate.path.test(path));
    assert.ok(route, 'the search path is routed');
    const req = {
      params: Object.fromEntries(path.match(route.path)!.slice(1).map((value, index) => [index, value])),
      query,
      sessionAccount: account ? { account_id: account } : null,
      headers: {},
    };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await route.handler(req, res);
    return res;
  }
  return { get, calls };
}

test('shared rules: a query is words and quoted phrases, deduplicated', () => {
  assert.deepEqual(parseMessageSearchQuery('  lock_timeout   mint  '), { terms: ['lock_timeout', 'mint'] });
  assert.deepEqual(parseMessageSearchQuery('"statement timeout" 57014'), { terms: ['statement timeout', '57014'] });
  assert.deepEqual(parseMessageSearchQuery('"unclosed phrase stays whole'), { terms: ['unclosed phrase stays whole'] });
  assert.deepEqual(parseMessageSearchQuery('Mint mint MINT "mint"'), { terms: ['Mint'] }, 'case does not make a new term');
  assert.deepEqual(parseMessageSearchQuery('"  spaced   out  "'), { terms: ['spaced out'] });
  assert.deepEqual(parseMessageSearchQuery('100% a_b c\\d'), { terms: ['100%', 'a_b', 'c\\d'] }, 'wildcard characters are ordinary text');
  assert.deepEqual(parseMessageSearchQuery('src/api/db.ts:34'), { terms: ['src/api/db.ts:34'] });
});

test('shared rules: a query that cannot be searched says why', () => {
  for (const tooShort of ['', '   ', 'a', '""', '" "', null, undefined, 42, ['ab']]) {
    assert.deepEqual(parseMessageSearchQuery(tooShort), { error: 'too_short' }, JSON.stringify(tooShort));
  }
  assert.deepEqual(parseMessageSearchQuery('a b'), { terms: ['a', 'b'] }, 'two one-letter words are enough together');
  assert.deepEqual(parseMessageSearchQuery('x'.repeat(MESSAGE_SEARCH_MAX_QUERY_CHARS)).terms?.length, 1);
  assert.deepEqual(parseMessageSearchQuery('x'.repeat(MESSAGE_SEARCH_MAX_QUERY_CHARS + 1)), { error: 'too_long' });
  const words = Array.from({ length: MESSAGE_SEARCH_MAX_TERMS + 1 }, (_, index) => `w${index}`);
  assert.deepEqual(parseMessageSearchQuery(words.join(' ')), { error: 'too_many_terms' });
  assert.equal(parseMessageSearchQuery(words.slice(1).join(' ')).terms?.length, MESSAGE_SEARCH_MAX_TERMS);
});

test('shared rules: the client-side match is the server rule', () => {
  assert.equal(textMatchesMessageSearch('Set LOCK_TIMEOUT before the mint', ['lock_timeout', 'MINT']), true);
  assert.equal(textMatchesMessageSearch('Set lock_timeout', ['lock_timeout', 'mint']), false, 'every term must be present');
  assert.equal(textMatchesMessageSearch('useDesktopRoomMessages', ['RoomMess']), true, 'part of an identifier matches');
  assert.equal(textMatchesMessageSearch('anything', []), false);
  assert.equal(textMatchesMessageSearch(null, ['x']), false);
});

test('a search passes its terms, cursor, limit and reader to the store', async () => {
  const api = harness();
  const res = await api.get({ q: '"lock timeout" mint', before: 'msg_40', limit: '10' });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, {
    room_id: room,
    terms: ['lock timeout', 'mint'],
    messages: [{ id: 'msg_9', text: 'needle' }],
    has_more: true,
    next_before: 'msg_9',
  });
  assert.deepEqual(api.calls, [{ roomId: room, terms: ['lock timeout', 'mint'], options: { before: 40, limit: 10, accountId: 'emmy' } }]);

  await api.get({ q: 'mint' }, null);
  assert.deepEqual(api.calls[1]!.options, { before: null, limit: undefined, accountId: null }, 'defaults; a reader without an account is still a participant');
});

test('bad input is refused before the store is asked', async () => {
  const api = harness();
  for (const [query, code] of [
    [{}, 'query_too_short'],
    [{ q: 'a' }, 'query_too_short'],
    [{ q: ['two', 'values'] }, 'query_too_short'],
    [{ q: 'x'.repeat(MESSAGE_SEARCH_MAX_QUERY_CHARS + 1) }, 'query_too_long'],
    [{ q: 'a1 b2 c3 d4 e5 f6 g7' }, 'query_too_many_terms'],
  ] as const) {
    const res = await api.get(query);
    assert.deepEqual([res.code, res.body.code], [400, code], JSON.stringify(query));
  }
  for (const before of ['latest', '12', 'msg_0', 'msg_99999999999', ['msg_1']]) {
    assert.equal((await api.get({ q: 'mint', before })).code, 400, `before=${JSON.stringify(before)}`);
  }
  assert.equal((await api.get({ q: 'mint', limit: 'many' })).code, 200, 'an unreadable limit falls back to the default');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]!.options && (api.calls[0]!.options as any).limit, undefined);
});

test('someone who cannot read the room cannot search it', async () => {
  const api = harness({ denied: true });
  assert.equal((await api.get({ q: 'mint' })).code, 403);
  assert.deepEqual(api.calls, []);
});

test('a search that runs out of time says so; other failures stay opaque', async () => {
  for (const timeout of [Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('Failed query'), { cause: { code: '57014' } })]) {
    const res = await harness({ fails: timeout }).get({ q: 'mint' });
    assert.deepEqual([res.code, res.body.code], [503, 'search_timeout']);
  }
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = await harness({ fails: new Error('connection refused') }).get({ q: 'mint' });
    assert.equal(res.code, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /connection refused/);
  } finally {
    console.error = quiet;
  }
});

test('worker bearers have no search route until an agent tool needs one', () => {
  assert.equal(requiredAgentSessionRouteCapability('GET', `/rooms/${room}/messages/search`), null);
});


test('room resolution failures use the same opaque JSON error response', async (t) => {
  t.mock.method(console, 'error', () => {});
  const api = harness({ accessFails: new Error('private database connection details') });
  const res = await api.get({ q: 'mint' });
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { error: 'Messages could not be searched. Please retry.' });
  assert.deepEqual(api.calls, []);
});
