import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageReactionStore } from '../../../shared/message-reaction-store.mjs';
import type { MessageReaction } from '../../../shared/message-reactions.mjs';

const emmy = { login: 'emmy', name: 'Emmy', avatar_url: null };
const ada = { login: 'ada', name: 'Ada', avatar_url: null };
const thumbs = (...reactors: typeof emmy[]): MessageReaction => ({ emoji: '👍', count: reactors.length, reactors });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(t: test.TestContext, options: { viewer?: typeof emmy | null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const loads: Array<{ first: string; last: string; answer: ReturnType<typeof deferred<any>> }> = [];
  const mutations: Array<{ messageId: string; emoji: string; reacted: boolean; answer: ReturnType<typeof deferred<any>> }> = [];
  const errors: Array<[string, string]> = [];
  let changes = 0;
  const store = createMessageReactionStore({
    load: (first, last) => { const answer = deferred<any>(); loads.push({ first, last, answer }); return answer.promise; },
    mutate: (messageId, emoji, reacted) => { const answer = deferred<any>(); mutations.push({ messageId, emoji, reacted, answer }); return answer.promise; },
    viewer: () => (options.viewer === undefined ? emmy : options.viewer),
    onChange: () => { changes += 1; },
    onError: (error, during) => { errors.push([during, (error as Error).message]); },
  });
  t.after(() => store.reset());
  return { store, loads, mutations, errors, changes: () => changes };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('first tracking seeds immediately and schedules one coalesced read', async (t) => {
  const { store, loads, changes } = harness(t);
  store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  store.track({ id: 'msg_2' });
  store.track({ id: 'msg_2', reactions: [thumbs(emmy)] });
  store.track({ id: 'local-draft', reactions: [thumbs(ada)] });
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  assert.equal(store.get('msg_2'), store.get('msg_404'), 'the empty list is stable');
  assert.deepEqual(store.get('local-draft'), []);
  assert.equal(changes(), 1);
  assert.equal(loads.length, 0);
  t.mock.timers.tick(50);
  assert.deepEqual(loads.map(({ first, last }) => [first, last]), [['msg_1', 'msg_2']]);
  loads[0]!.answer.resolve({ reactions: { msg_2: [thumbs(ada, emmy)] }, next_first_message_id: null });
  await settle();
  assert.deepEqual(store.get('msg_1'), [], 'a complete read clears reactions that are gone');
  assert.deepEqual(store.get('msg_2'), [thumbs(ada, emmy)]);
  assert.equal(store.viewerReacted('msg_2', '👍'), true);
  store.track({ id: 'msg_2', reactions: [] });
  t.mock.timers.tick(50);
  assert.equal(loads.length, 1, 'duplicate registration does not read again');
  assert.deepEqual(store.get('msg_2'), [thumbs(ada, emmy)], 'an older copy cannot undo a refresh');
});

test('registrations share ownership and only live messages are refreshed', async (t) => {
  const { store, loads } = harness(t);
  const stop1 = store.track({ id: 'msg_1' });
  const stop2 = store.track({ id: 'msg_1' });
  const stop3 = store.track({ id: 'msg_9' });
  stop1();
  stop1();
  stop3();
  const read = store.refresh();
  assert.deepEqual(loads.map(({ first, last }) => [first, last]), [['msg_1', 'msg_1']]);
  loads[0]!.answer.resolve({ reactions: {}, next_first_message_id: null });
  await read;
  stop2();
  await store.refresh();
  assert.equal(loads.length, 1);
});

test('refreshes collapse while one is in flight and cover the latest tracked ids', async (t) => {
  const { store, loads } = harness(t);
  store.track({ id: 'msg_10' });
  store.track({ id: 'msg_12' });
  const first = store.refresh();
  store.refresh();
  store.track({ id: 'msg_5' });
  store.refresh();
  assert.equal(loads.length, 1);
  loads[0]!.answer.resolve({ reactions: {}, next_first_message_id: null });
  await settle();
  assert.equal(loads.length, 2);
  assert.deepEqual([loads[1]!.first, loads[1]!.last], ['msg_5', 'msg_12']);
  loads[1]!.answer.resolve({ reactions: { msg_5: [thumbs(ada)] }, next_first_message_id: null });
  await first;
  assert.deepEqual(store.get('msg_5'), [thumbs(ada)]);
});

test('a continued read clears only its complete portion before loading the rest', async (t) => {
  const { store, loads } = harness(t);
  for (const id of ['msg_1', 'msg_2', 'msg_3']) store.track({ id, reactions: [thumbs(ada)] });
  const read = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(emmy)] }, viewer_reactions: { msg_1: ['👍'] }, next_first_message_id: 'msg_3' });
  await settle();
  assert.deepEqual(store.get('msg_1'), [thumbs(emmy)]);
  assert.deepEqual(store.get('msg_2'), []);
  assert.deepEqual(store.get('msg_3'), [thumbs(ada)], 'unread tail is retained');
  assert.deepEqual([loads[1]!.first, loads[1]!.last], ['msg_3', 'msg_3']);
  loads[1]!.answer.resolve({ reactions: {}, viewer_reactions: {}, next_first_message_id: null });
  await read;
  assert.deepEqual(store.get('msg_3'), []);
  assert.equal(store.viewerReacted('msg_1', '👍'), true, 'later pages preserve earlier viewer state');
});

test('sparse tracked ids are split into inclusive spans of at most 1,000', async (t) => {
  const { store, loads } = harness(t);
  for (const id of ['msg_3005', 'msg_1001', 'msg_1', 'msg_2000', 'msg_1000']) store.track({ id });
  const read = store.refresh();
  for (const [index, span] of [['msg_1', 'msg_1000'], ['msg_1001', 'msg_2000'], ['msg_3005', 'msg_3005']].entries()) {
    assert.deepEqual([loads[index]!.first, loads[index]!.last], span);
    loads[index]!.answer.resolve({ reactions: {}, next_first_message_id: null });
    await settle();
  }
  await read;
  assert.equal(loads.length, 3);
});

test('a failed read keeps what is shown and reports the error', async (t) => {
  const { store, loads, errors } = harness(t);
  store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  const read = store.refresh();
  loads[0]!.answer.reject(new Error('offline'));
  await read;
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  assert.deepEqual(errors, [['load', 'offline']]);
});

test('a toggle shows at once, then takes the server answer', async (t) => {
  const { store, mutations } = harness(t);
  store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  const toggled = store.toggle('msg_1', '👍');
  await settle();
  assert.deepEqual(store.get('msg_1'), [thumbs(ada, emmy)], 'optimistic');
  assert.deepEqual([mutations[0]!.messageId, mutations[0]!.emoji, mutations[0]!.reacted], ['msg_1', '👍', true]);
  const grace = { login: 'grace', name: 'Grace', avatar_url: null };
  mutations[0]!.answer.resolve({ reactions: [thumbs(ada, grace, emmy)] });
  await toggled;
  assert.deepEqual(store.get('msg_1'), [thumbs(ada, grace, emmy)]);
  const removed = store.toggle('msg_1', '👍');
  await settle();
  assert.equal(mutations[1]!.reacted, false);
  mutations[1]!.answer.resolve({ reactions: [thumbs(ada, grace)] });
  await removed;
  assert.equal(store.viewerReacted('msg_1', '👍'), false);
});

test('a failed toggle rolls back reactions and viewer state, then schedules a read', async (t) => {
  const { store, loads, mutations, errors } = harness(t);
  store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  const read = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(ada)] }, viewer_reactions: {}, next_first_message_id: null });
  await read;
  const toggled = store.toggle('msg_1', '🎉');
  await settle();
  assert.equal(store.viewerReacted('msg_1', '🎉'), true);
  mutations[0]!.answer.reject(new Error('reaction limit'));
  await toggled;
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  assert.equal(store.viewerReacted('msg_1', '🎉'), false);
  assert.deepEqual(errors, [['mutate', 'reaction limit']]);
  assert.equal(loads.length, 1);
  t.mock.timers.tick(50);
  assert.equal(loads.length, 2, 'failed mutation schedules confirmation even without an invalidation');
  loads[1]!.answer.resolve({ reactions: {}, viewer_reactions: {}, next_first_message_id: null });
  await settle();
  assert.deepEqual(store.get('msg_1'), []);
});

test('rapid toggles on one message reach the server in order', async (t) => {
  const { store, mutations } = harness(t);
  const on = store.toggle('msg_1', '👍');
  const off = store.toggle('msg_1', '👍');
  await settle();
  assert.equal(mutations.length, 1);
  mutations[0]!.answer.resolve({ reactions: [thumbs(emmy)] });
  await on;
  await settle();
  assert.deepEqual(mutations.map((mutation) => mutation.reacted), [true, false]);
  mutations[1]!.answer.resolve({ reactions: [] });
  await off;
  assert.deepEqual(store.get('msg_1'), []);
});

for (const completed of [false, true]) {
  test(`a stale read cannot overwrite a ${completed ? 'completed' : 'pending'} toggle`, async (t) => {
    const { store, loads, mutations } = harness(t);
    store.track({ id: 'msg_1' });
    store.track({ id: 'msg_2' });
    const read = store.refresh();
    const toggled = store.toggle('msg_1', '👍');
    await settle();
    if (completed) {
      mutations[0]!.answer.resolve({ reactions: [thumbs(emmy)] });
      await toggled;
    }
    loads[0]!.answer.resolve({ reactions: { msg_2: [thumbs(ada)] }, viewer_reactions: {}, next_first_message_id: null });
    await read;
    assert.deepEqual(store.get('msg_1'), [thumbs(emmy)]);
    assert.equal(store.viewerReacted('msg_1', '👍'), true);
    assert.deepEqual(store.get('msg_2'), [thumbs(ada)], 'other messages still update');
    if (!completed) {
      mutations[0]!.answer.resolve({ reactions: [thumbs(emmy)] });
      await toggled;
    }
  });
}

test('viewer_reactions is authoritative even beyond the reactor cap and when empty', async (t) => {
  const { store, loads, mutations } = harness(t);
  const crowd: MessageReaction = { emoji: '👍', count: 51, reactors: [ada] };
  store.track({ id: 'msg_1', reactions: [crowd] });
  store.track({ id: 'msg_2', reactions: [thumbs(emmy)] });
  const read = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [crowd], msg_2: [thumbs(emmy)] }, viewer_reactions: { msg_1: ['👍'] }, next_first_message_id: null });
  await read;
  assert.equal(store.viewerReacted('msg_1', '👍'), true);
  assert.equal(store.viewerReacted('msg_2', '👍'), false, 'absence from the exact map overrides the named list');
  const removed = store.toggle('msg_1', '👍');
  await settle();
  assert.equal(mutations[0]!.reacted, false, 'first click removes even though the viewer is not listed');
  assert.equal(store.get('msg_1')[0]!.count, 50);
  mutations[0]!.answer.resolve({ reactions: [{ ...crowd, count: 50 }] });
  await removed;
  assert.equal(store.viewerReacted('msg_1', '👍'), false);
  const refreshed = store.refresh();
  loads[1]!.answer.resolve({ reactions: { msg_1: [crowd] }, viewer_reactions: {}, next_first_message_id: null });
  await refreshed;
  assert.equal(store.viewerReacted('msg_1', '👍'), false);
});

test('reset drops in-flight reads and writes without dropping the next room read', async (t) => {
  const { store, loads, mutations } = harness(t);
  const stopOld = store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  const read = store.refresh();
  const toggled = store.toggle('msg_1', '🎉');
  await settle();
  store.reset();
  assert.deepEqual(store.get('msg_1'), []);
  store.track({ id: 'msg_1' });
  stopOld();
  const next = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(ada, emmy)] }, viewer_reactions: { msg_1: ['👍'] }, next_first_message_id: null });
  mutations[0]!.answer.resolve({ reactions: [thumbs(ada, emmy)] });
  await toggled;
  await settle();
  assert.deepEqual(store.get('msg_1'), []);
  assert.equal(store.viewerReacted('msg_1', '👍'), false);
  assert.equal(loads.length, 2);
  assert.deepEqual([loads[1]!.first, loads[1]!.last], ['msg_1', 'msg_1'], 'old disposer cannot unregister the next room');
  loads[1]!.answer.resolve({ reactions: { msg_1: [thumbs(ada)] }, next_first_message_id: null });
  await Promise.all([read, next]);
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
});

test('reset can keep registrations when the signed-in viewer changes', async (t) => {
  const { store, loads } = harness(t);
  const stop = store.track({ id: 'msg_1', reactions: [thumbs(ada)] });
  const oldRead = store.refresh();
  store.reset({ keepTracked: true });
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(emmy)] }, next_first_message_id: null });
  await oldRead;
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  t.mock.timers.tick(50);
  assert.equal(loads.length, 2);
  loads[1]!.answer.resolve({ reactions: {}, viewer_reactions: {}, next_first_message_id: null });
  await settle();
  assert.deepEqual(store.get('msg_1'), []);
  stop();
  await store.refresh();
  assert.equal(loads.length, 2, 'retained registrations still unregister normally');
});

test('nobody signed in means nothing is sent', async (t) => {
  const { store, mutations } = harness(t, { viewer: null });
  await store.toggle('msg_1', '👍');
  assert.equal(mutations.length, 0);
  assert.deepEqual(store.get('msg_1'), []);
});

test('a dense span reads every continuation instead of starving the tail on every refresh', async (t) => {
  const { store, loads } = harness(t);
  for (let number = 1; number <= 1000; number++) store.track({ id: `msg_${number}` });
  const read = store.refresh();
  // Twenty emoji times fifty listed reactors permits only two full messages
  // per 2,000-row page. Even this densest allowed span must converge.
  for (let first = 1; first <= 1000; first += 2) {
    const request = loads[(first - 1) / 2];
    assert.ok(request, `the range must continue at msg_${first}`);
    assert.equal(request.first, `msg_${first}`);
    assert.equal(request.last, 'msg_1000');
    request.answer.resolve({
      reactions: { [`msg_${first}`]: [thumbs(ada)], [`msg_${first + 1}`]: [thumbs(ada)] },
      viewer_reactions: {},
      next_first_message_id: first < 999 ? `msg_${first + 2}` : null,
    });
    await settle();
  }
  await read;
  assert.equal(loads.length, 500);
  assert.deepEqual(store.get('msg_1000'), [thumbs(ada)]);
});

test('a successful continuation is published even if a later page fails', async (t) => {
  const { store, loads, changes } = harness(t);
  store.track({ id: 'msg_1' });
  store.track({ id: 'msg_2' });
  const before = changes();
  const read = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(ada)] }, next_first_message_id: 'msg_2' });
  await settle();
  loads[1]!.answer.reject(new Error('offline'));
  await read;
  assert.deepEqual(store.get('msg_1'), [thumbs(ada)]);
  assert.ok(changes() > before, 'Vue must hear about the completed page');
});

test('reset starts the next room read without waiting for the old room and old cleanup cannot release it', async (t) => {
  const { store, loads } = harness(t);
  store.track({ id: 'msg_1' });
  const old = store.refresh();
  store.reset();
  store.track({ id: 'msg_1' });
  const current = store.refresh();
  assert.equal(loads.length, 2, 'an unresolved old-room request cannot block this room');
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(emmy)] }, next_first_message_id: null });
  await old;
  assert.deepEqual(store.get('msg_1'), []);
  assert.equal(store.refresh(), current, 'old cleanup cannot clear the active refresh');
  assert.equal(loads.length, 2);
  loads[1]!.answer.resolve({ reactions: { msg_1: [thumbs(ada)] }, next_first_message_id: null });
  await settle();
  assert.equal(loads.length, 3, 'overlapping refresh still coalesces into one follow-up');
  loads[2]!.answer.resolve({ reactions: {}, next_first_message_id: null });
  await current;
});

test('a successful toggle confirms exact viewer state when an invalidation landed during the mutation', async (t) => {
  const { store, loads, mutations } = harness(t);
  store.track({ id: 'msg_1', reactions: [thumbs(emmy)] });
  const read = store.refresh();
  loads[0]!.answer.resolve({ reactions: { msg_1: [thumbs(emmy)] }, viewer_reactions: { msg_1: ['👍'] }, next_first_message_id: null });
  await read;
  const toggled = store.toggle('msg_1', '🎉');
  await settle();
  const invalidation = store.refresh();
  // Another tab removed the viewer's thumbs-up while this tab adds confetti.
  loads[1]!.answer.resolve({ reactions: {}, viewer_reactions: {}, next_first_message_id: null });
  await invalidation;
  mutations[0]!.answer.resolve({ reactions: [{ emoji: '🎉', count: 51, reactors: [ada] }] });
  await toggled;
  t.mock.timers.tick(50);
  assert.equal(loads.length, 3, 'success also confirms changes skipped during the toggle');
  loads[2]!.answer.resolve({ reactions: { msg_1: [{ emoji: '🎉', count: 51, reactors: [ada] }] }, viewer_reactions: { msg_1: ['🎉'] }, next_first_message_id: null });
  await settle();
  assert.equal(store.viewerReacted('msg_1', '👍'), false);
  assert.equal(store.viewerReacted('msg_1', '🎉'), true);
});
