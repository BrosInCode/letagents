import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Express } from 'express';
import {
  MESSAGE_REACTION_EMOJI_MAX_BYTES,
  MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE,
  MESSAGE_REACTION_MAX_REACTORS_LISTED,
  MESSAGE_REACTION_QUICK_EMOJI,
  describeMessageReaction,
  normalizeMessageReactionEmoji,
  normalizeMessageReactions,
  toggleViewerMessageReaction,
  viewerReactedWith,
  type MessageReaction,
} from '../../../shared/message-reactions.mjs';
import {
  ROOM_RESOURCE_MESSAGE_REACTIONS,
  parseRoomResourceInvalidation,
} from '../../../shared/room-resource-invalidation.mjs';
import { requiredAgentSessionRouteCapability } from '../request/agent-session-route-capabilities.js';
process.env.DB_URL ??= 'postgresql://test:test@127.0.0.1:1/test';
const { registerRoomMessageRoutes } = await import('../routes/rooms/messages/index.js');
const { createRoomEventBroker, MESSAGE_CREATED_EVENT_KINDS } = await import('../server/room-event-broker.js');

const room = 'github.com/org/repo';
type Auth = 'session' | 'owner_token' | 'agent_session' | null;

function harness(options: { denied?: boolean; storeFails?: unknown; nextFirst?: number } = {}) {
  const routes: Array<{ method: string; path: RegExp; handler: Function }> = [];
  // message number -> emoji -> account ids, in reaction order
  const stored = new Map<number, Map<string, string[]>>([[7, new Map()]]);
  const invalidated: string[] = [];
  const viewerReads: Array<[string, string, number, number]> = [];
  const summarize = (messageNumber: number): MessageReaction[] =>
    Array.from(stored.get(messageNumber) ?? [], ([emoji, accounts]) => ({
      emoji, count: accounts.length, reactors: accounts.map((login) => ({ login, name: login, avatar_url: null })),
    })).filter((reaction) => reaction.count > 0);
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [
    method, (path: RegExp, handler: Function) => routes.push({ method, path, handler }),
  ])) as unknown as Express;
  registerRoomMessageRoutes(app, {
    emitProjectMessage: () => { throw new Error('A reaction must never emit a room message'); },
    resolveCanonicalRoomRequestId: async (id: string) => id,
    resolveRoomOrReply: async (id: string) => ({ id } as any),
    requireParticipant: async (_req: unknown, res: any) => {
      if (options.denied) { res.status(403).json({ error: 'Forbidden' }); return false; }
      return true;
    },
    queueMessageReactionInvalidation: (roomId: string) => { invalidated.push(roomId); },
    messageReactionStore: {
      add: async ({ messageNumber, accountId, emoji }) => {
        if (options.storeFails) throw options.storeFails;
        const reactions = stored.get(messageNumber);
        if (!reactions) return 'message_not_found';
        if (!reactions.has(emoji) && reactions.size >= MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE) return 'limit_reached';
        const accounts = reactions.get(emoji) ?? [];
        if (accounts.includes(accountId)) return 'exists';
        reactions.set(emoji, [...accounts, accountId]);
        return 'added';
      },
      remove: async ({ messageNumber, accountId, emoji }) => {
        const accounts = stored.get(messageNumber)?.get(emoji) ?? [];
        if (!accounts.includes(accountId)) return false;
        stored.get(messageNumber)!.set(emoji, accounts.filter((id) => id !== accountId));
        return true;
      },
      forMessage: async (_roomId, messageNumber) => summarize(messageNumber),
      inRange: async (_roomId, first, last) => ({
        reactions: new Map([...stored.keys()].filter((n) => n >= first && n <= last && (!options.nextFirst || n < options.nextFirst) && summarize(n).length)
          .map((n) => [n, summarize(n)] as const)),
        nextFirst: options.nextFirst ?? null,
      }),
      byViewer: async (roomId, accountId, first, last) => {
        viewerReads.push([roomId, accountId, first, last]);
        return new Map([...stored.entries()]
          .filter(([n]) => n >= first && n <= last)
          .map(([n, reactions]) => [n, [...reactions].filter(([, accounts]) => accounts.includes(accountId)).map(([emoji]) => emoji)] as const)
          .filter(([, emoji]) => emoji.length));
      },
    },
  } as any);
  async function request(method: string, path: string, auth: Auth = 'session', query: Record<string, unknown> = {}) {
    const route = routes.find((candidate) => candidate.method === method && candidate.path.test(path));
    assert.ok(route, `${method} ${path} is routed`);
    const matches = path.match(route.path)!;
    const req = {
      params: Object.fromEntries(matches.slice(1).map((value, index) => [index, decodeURIComponent(value)])),
      query,
      authKind: auth ?? undefined,
      sessionAccount: auth === 'session' || auth === 'owner_token' ? { account_id: 'emmy', login: 'Emmy' } : null,
      headers: {},
    };
    const res = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await route.handler(req, res);
    return res;
  }
  const reactionPath = (message: string, emoji: string) => `/rooms/${room}/messages/${message}/reactions/${encodeURIComponent(emoji)}`;
  return { request, reactionPath, invalidated, routes, viewerReads };
}

test('shared rules: exactly one emoji is a reaction', () => {
  for (const emoji of MESSAGE_REACTION_QUICK_EMOJI) assert.equal(normalizeMessageReactionEmoji(emoji), emoji);
  assert.equal(new Set(MESSAGE_REACTION_QUICK_EMOJI).size, MESSAGE_REACTION_QUICK_EMOJI.length);
  for (const emoji of ['👍🏽', '🇳🇬', '👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '1️⃣', '🧑🏿‍💻']) assert.equal(normalizeMessageReactionEmoji(emoji), emoji);
  assert.equal(normalizeMessageReactionEmoji(' 👍 '), '👍', 'surrounding space is not part of the emoji');
  assert.equal(normalizeMessageReactionEmoji('❤'), '❤️', 'a text-style symbol becomes its emoji form');
  for (const invalid of ['', ' ', 'ok', '+1', ':thumbsup:', '👍👍', '👍 👎', 'a👍', '<b>', '1', '#', '‍', '️', null, undefined, 7, ['👍'], { emoji: '👍' }]) {
    assert.equal(normalizeMessageReactionEmoji(invalid), null, `${JSON.stringify(invalid)} is not a reaction`);
  }
  assert.equal(normalizeMessageReactionEmoji('👍'.repeat(MESSAGE_REACTION_EMOJI_MAX_BYTES)), null);
});

test('shared rules: a reaction list from the server is read defensively', () => {
  const ada = { login: 'ada', name: 'Ada', avatar_url: 'https://avatars.example/ada.png' };
  assert.deepEqual(normalizeMessageReactions([{ emoji: '👍', count: 2, reactors: [ada, { login: 'grace' }] }]), [
    { emoji: '👍', count: 2, reactors: [ada, { login: 'grace', name: 'grace', avatar_url: null }] },
  ]);
  for (const junk of [null, undefined, 'x', {}, [null], [{ emoji: 'not emoji', count: 1 }], [{ emoji: '👍', count: 0, reactors: [] }]]) {
    assert.deepEqual(normalizeMessageReactions(junk), []);
  }
  const [reaction] = normalizeMessageReactions([{
    emoji: '🎉', count: 1, reactors: [{ login: 'x', avatar_url: 'javascript:alert(1)' }, { login: '' }, 'nope', ada],
  }]);
  assert.deepEqual(reaction, { emoji: '🎉', count: 2, reactors: [{ login: 'x', name: 'x', avatar_url: null }, ada] },
    'unsafe avatar urls and nameless reactors are dropped; the count never undercuts the list');
  assert.equal(normalizeMessageReactions([{ emoji: '👍', count: 1 }, { emoji: '👍', count: 4 }]).length, 1, 'a repeated emoji is kept once');
  const many = Array.from({ length: MESSAGE_REACTION_MAX_REACTORS_LISTED + 9 }, (_, index) => ({ login: `p${index}` }));
  const [capped] = normalizeMessageReactions([{ emoji: '👍', count: many.length, reactors: many }]);
  assert.equal(capped!.reactors.length, MESSAGE_REACTION_MAX_REACTORS_LISTED);
  assert.equal(capped!.count, many.length);
});

test('shared rules: the label names the viewer first and counts the rest', () => {
  const reactor = (login: string, name = login) => ({ login, name, avatar_url: null });
  const reaction = (count: number, ...reactors: ReturnType<typeof reactor>[]): MessageReaction => ({ emoji: '👍', count, reactors });
  assert.equal(describeMessageReaction(reaction(1, reactor('ada', 'Ada')), 'emmy'), 'Ada reacted with 👍');
  assert.equal(describeMessageReaction(reaction(1, reactor('Emmy')), 'emmy'), 'You reacted with 👍', 'logins compare without case');
  assert.equal(describeMessageReaction(reaction(2, reactor('ada', 'Ada'), reactor('emmy')), 'emmy'), 'You and Ada reacted with 👍');
  assert.equal(
    describeMessageReaction(reaction(6, reactor('a', 'Ada'), reactor('b', 'Bea'), reactor('c', 'Cy'), reactor('d', 'Di')), null),
    'Ada, Bea, Cy and 3 others reacted with 👍',
  );
  assert.equal(describeMessageReaction(reaction(4, reactor('a', 'Ada'), reactor('b', 'Bea'), reactor('c', 'Cy')), null), 'Ada, Bea, Cy and 1 other reacted with 👍');
  assert.equal(viewerReactedWith(reaction(1, reactor('ada')), ''), false);
  assert.equal(viewerReactedWith(null, 'ada'), false);
});

test('shared rules: toggling is an optimistic add, join, leave or removal', () => {
  const emmy = { login: 'emmy', name: 'Emmy', avatar_url: null };
  const ada = { login: 'ada', name: 'Ada', avatar_url: null };
  const added = toggleViewerMessageReaction([], '👍', emmy);
  assert.deepEqual(added, [{ emoji: '👍', count: 1, reactors: [emmy] }]);
  assert.deepEqual(toggleViewerMessageReaction(added, '👍', emmy), [], 'the last reactor leaving removes the reaction');
  const joined = toggleViewerMessageReaction([{ emoji: '👍', count: 1, reactors: [ada] }], '👍', emmy);
  assert.deepEqual(joined, [{ emoji: '👍', count: 2, reactors: [ada, emmy] }]);
  assert.deepEqual(toggleViewerMessageReaction(joined, '👍', emmy), [{ emoji: '👍', count: 1, reactors: [ada] }]);
  const original: MessageReaction[] = [{ emoji: '👍', count: 1, reactors: [ada] }];
  toggleViewerMessageReaction(original, '🎉', emmy);
  assert.deepEqual(original, [{ emoji: '👍', count: 1, reactors: [ada] }], 'the input list is never mutated');
});

test('a person adds and removes a reaction; each real change invalidates the room once', async () => {
  const api = harness();
  const added = await api.request('put', api.reactionPath('msg_7', '👍'));
  assert.equal(added.code, 200);
  assert.deepEqual(added.body, {
    room_id: room, message_id: 'msg_7', emoji: '👍', changed: true,
    reactions: [{ emoji: '👍', count: 1, reactors: [{ login: 'emmy', name: 'emmy', avatar_url: null }] }],
  });
  const repeated = await api.request('put', api.reactionPath('msg_7', '👍'));
  assert.equal(repeated.body.changed, false, 'repeating a reaction is not a change');
  const removed = await api.request('delete', api.reactionPath('msg_7', '👍'));
  assert.deepEqual([removed.code, removed.body.changed, removed.body.reactions], [200, true, []]);
  const again = await api.request('delete', api.reactionPath('msg_7', '👍'));
  assert.deepEqual([again.code, again.body.changed], [200, false], 'removing what is already gone still succeeds');
  assert.deepEqual(api.invalidated, [room, room]);
});

test('only a signed-in person can react: agents and anonymous callers are refused', async () => {
  const api = harness();
  for (const [auth, code] of [['owner_token', 403], ['agent_session', 403], [null, 401]] as const) {
    for (const method of ['put', 'delete']) {
      const res = await api.request(method, api.reactionPath('msg_7', '👍'), auth);
      assert.equal(res.code, code, `${method} as ${auth}`);
      assert.equal(res.body.code, 'person_required');
    }
  }
  assert.deepEqual(api.invalidated, []);
  // Worker bearers are stopped earlier still: no reaction route is in their allowlist.
  assert.equal(requiredAgentSessionRouteCapability('PUT', api.reactionPath('msg_7', '👍')), null);
  assert.equal(requiredAgentSessionRouteCapability('DELETE', api.reactionPath('msg_7', '👍')), null);
  assert.equal(requiredAgentSessionRouteCapability('GET', `/rooms/${room}/messages/reactions`), null);
});

test('bad input is refused without a write', async () => {
  const api = harness();
  for (const emoji of ['ok', '👍👍', ':tada:', '%E0%A4%A', '%']) {
    const res = await api.request('put', api.reactionPath('msg_7', emoji));
    assert.deepEqual([res.code, res.body.code], [400, 'invalid_emoji'], emoji);
  }
  const missing = await api.request('put', api.reactionPath('msg_8', '👍'));
  assert.deepEqual([missing.code, missing.body.error], [404, 'message does not exist in this room']);
  const overflow = await api.request('put', api.reactionPath('msg_99999999999', '👍'));
  assert.equal(overflow.code, 404, 'an id past the integer range is just a message that does not exist');
  assert.deepEqual(api.invalidated, []);
  assert.equal((await harness({ denied: true }).request('put', api.reactionPath('msg_7', '👍'))).code, 403);
});

test('the different-emoji limit is reported as a conflict the UI can explain', async () => {
  const api = harness();
  const distinct = [...MESSAGE_REACTION_QUICK_EMOJI];
  for (const emoji of distinct.slice(0, MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE)) {
    assert.equal((await api.request('put', api.reactionPath('msg_7', emoji))).code, 200);
  }
  const res = await api.request('put', api.reactionPath('msg_7', distinct[MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE]!));
  assert.deepEqual([res.code, res.body.code], [409, 'reaction_limit']);
});

test('a store failure is a retryable error, and lock contention says so', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const broken = await harness({ storeFails: new Error('connection refused') }).request('put', `/rooms/${room}/messages/msg_7/reactions/${encodeURIComponent('👍')}`);
    assert.equal(broken.code, 500);
    assert.doesNotMatch(JSON.stringify(broken.body), /connection refused/, 'internals are not echoed');
  } finally {
    console.error = quiet;
  }
  const busy = await harness({ storeFails: Object.assign(new Error('lock timeout'), { code: '55P03' }) })
    .request('put', `/rooms/${room}/messages/msg_7/reactions/${encodeURIComponent('👍')}`);
  assert.deepEqual([busy.code, busy.body.code], [503, 'reaction_busy']);
});

test('a range read lists reacted messages by id and validates its bounds', async () => {
  const api = harness();
  await api.request('put', api.reactionPath('msg_7', '✅'));
  const read = await api.request('get', `/rooms/${room}/messages/reactions`, 'owner_token', { first: 'msg_1', last: 'msg_20' });
  assert.equal(read.code, 200, 'reading is open to every participant, agents included');
  assert.deepEqual(read.body, {
    room_id: room, first_message_id: 'msg_1', last_message_id: 'msg_20', next_first_message_id: null,
    reactions: { msg_7: [{ emoji: '✅', count: 1, reactors: [{ login: 'emmy', name: 'emmy', avatar_url: null }] }] },
  });
  const empty = await api.request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_8', last: 'msg_20' });
  assert.deepEqual(empty.body.reactions, {});
  assert.deepEqual(empty.body.viewer_reactions, {});
  const mine = await api.request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_1', last: 'msg_20' });
  assert.deepEqual(mine.body.viewer_reactions, { msg_7: ['✅'] });
  assert.deepEqual(api.viewerReads, [[room, 'emmy', 8, 20], [room, 'emmy', 1, 20]], 'agent reads do not request viewer state');
  const boundary = await api.request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_7', last: 'msg_1006' });
  assert.equal(boundary.code, 200, 'exactly 1,000 message numbers fit');
  const tooWide = await api.request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_7', last: 'msg_1007' });
  assert.deepEqual([tooWide.code, tooWide.body.code], [400, 'range_too_wide']);
  for (const query of [{}, { first: 'msg_5' }, { first: 'msg_9', last: 'msg_3' }, { first: '5', last: '9' }, { first: ['msg_1'], last: 'msg_2' }]) {
    assert.equal((await api.request('get', `/rooms/${room}/messages/reactions`, 'session', query)).code, 400, JSON.stringify(query));
  }
  assert.equal((await harness({ denied: true }).request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_1', last: 'msg_2' })).code, 403);
});


test('range continuation returns an exact cursor and viewer state only for the complete portion', async () => {
  const api = harness({ nextFirst: 8 });
  await api.request('put', api.reactionPath('msg_7', '👍'));
  const read = await api.request('get', `/rooms/${room}/messages/reactions`, 'session', { first: 'msg_1', last: 'msg_20' });
  assert.equal(read.body.next_first_message_id, 'msg_8');
  assert.deepEqual(read.body.viewer_reactions, { msg_7: ['👍'] });
  assert.deepEqual(api.viewerReads, [[room, 'emmy', 1, 7]]);
  assert.equal('truncated' in read.body, false);
});

test('the reaction routes never shadow the single-message route', () => {
  const api = harness();
  const matching = (method: string, path: string) => api.routes.filter((route) => route.method === method && route.path.test(path)).length;
  assert.equal(matching('get', `/rooms/${room}/messages/reactions`), 1);
  assert.equal(matching('get', `/rooms/${room}/messages/msg_7`), 1, 'the real single-message route is registered alongside reactions');
  assert.equal(matching('get', `/rooms/${room}/messages/poll`), 1);
  assert.equal(matching('get', `/rooms/${room}/messages/stream`), 1);
  assert.equal(matching('put', `/rooms/${room}/messages/msg_7/reactions/x/y`), 0, 'an emoji is one path segment');
});

test('a reaction change reaches streams as a pointer-only invalidation', async () => {
  assert.deepEqual(parseRoomResourceInvalidation({ room_id: room, resource: ROOM_RESOURCE_MESSAGE_REACTIONS }), {
    status: 'supported', pointer: { room_id: room, resource: 'message_reactions' },
  });
  const messageReactionEvents = new EventEmitter();
  const quiet = () => new EventEmitter();
  const broker = createRoomEventBroker({
    messageEvents: quiet(), taskEvents: quiet(), githubRoomEvents: quiet(), reasoningEvents: quiet(),
    rentalActivityEvents: quiet(), messageInfoEvents: quiet(), messageReactionEvents,
  }, { instanceId: 'broker' });
  const everything = broker.subscribe(room);
  const messagesOnly = broker.subscribe(room, { kinds: MESSAGE_CREATED_EVENT_KINDS });
  messageReactionEvents.emit('message_reactions:invalidated', { projectId: room });
  const delivery = await everything.next();
  assert.equal(delivery?.type, 'event');
  if (delivery?.type === 'event') {
    assert.deepEqual(delivery.envelope.event, { kind: 'resource_invalidated', resource: 'message_reactions', roomId: room });
  }
  // Agents wait on the long poll, which subscribes to message events only. A reaction must not end that wait.
  const woke = await Promise.race([
    messagesOnly.next().then(() => true),
    new Promise<false>((resolveWait) => setImmediate(() => resolveWait(false))),
  ]);
  assert.equal(woke, false, 'a reaction never wakes a message-only subscriber');
  everything.close();
  messagesOnly.close();
  broker.close();
  assert.equal(messageReactionEvents.listenerCount('message_reactions:invalidated'), 0);
});
