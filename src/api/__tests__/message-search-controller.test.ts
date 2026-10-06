import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageSearchController } from '../../../shared/message-search-controller.mjs';
import { highlightMessageSearchText, messageSearchSnippet } from '../../../shared/message-search.mjs';

type Hit = { id: string; text: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness() {
  const requests: Array<{ query: string; before: string | null; answer: ReturnType<typeof deferred<any>> }> = [];
  let changes = 0;
  const controller = createMessageSearchController<Hit>({
    search: (query, before) => { const answer = deferred<any>(); requests.push({ query, before, answer }); return answer.promise; },
    onChange: () => { changes += 1; },
    debounceMs: 5,
  });
  return { controller, requests, changes: () => changes };
}
const wait = (ms = 15) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const hit = (number: number): Hit => ({ id: `msg_${number}`, text: `hit ${number}` });

test('typing searches once, after a pause, for the latest query', async () => {
  const { controller, requests } = harness();
  controller.setQuery('lo');
  controller.setQuery('loc');
  controller.setQuery('lock');
  assert.equal(controller.state.status, 'loading');
  assert.deepEqual(controller.state.terms, ['lock']);
  assert.equal(requests.length, 0, 'nothing is sent while the person is still typing');
  await wait();
  assert.deepEqual(requests.map((request) => [request.query, request.before]), [['lock', null]]);
  requests[0]!.answer.resolve({ terms: ['lock'], messages: [hit(9), hit(4)], has_more: false, next_before: null });
  await wait(0);
  assert.equal(controller.state.status, 'ready');
  assert.deepEqual(controller.state.hits.map((entry) => entry.id), ['msg_9', 'msg_4']);
  assert.equal(controller.state.hasMore, false);

  controller.setQuery('  lock ');
  await wait();
  assert.equal(requests.length, 1, 'the same query is not searched again');
});

test('a query too short to search is idle; one that breaks a limit says which', async () => {
  const { controller, requests } = harness();
  controller.setQuery('a');
  assert.equal(controller.state.status, 'idle');
  controller.setQuery('a1 b2 c3 d4 e5 f6 g7');
  assert.deepEqual([controller.state.status, controller.state.error], ['invalid', 'too_many_terms']);
  await wait();
  assert.equal(requests.length, 0);
});

test('an answer for an earlier query never replaces the current one', async () => {
  const { controller, requests } = harness();
  controller.setQuery('first');
  await wait();
  controller.setQuery('second');
  await wait();
  assert.equal(requests.length, 2);
  requests[1]!.answer.resolve({ messages: [hit(2)], has_more: false, next_before: null });
  await wait(0);
  requests[0]!.answer.resolve({ messages: [hit(1)], has_more: false, next_before: null });
  await wait(0);
  assert.deepEqual(controller.state.hits.map((entry) => entry.id), ['msg_2']);
});

test('more results are appended from the cursor, without duplicates', async () => {
  const { controller, requests } = harness();
  controller.setQuery('hit');
  await wait();
  requests[0]!.answer.resolve({ messages: [hit(9), hit(8)], has_more: true, next_before: 'msg_8' });
  await wait(0);
  assert.equal(controller.state.hasMore, true);

  const more = controller.loadMore();
  void controller.loadMore();
  assert.equal(controller.state.loadingMore, true);
  assert.equal(requests.length, 2, 'a second press while loading is ignored');
  assert.deepEqual([requests[1]!.query, requests[1]!.before], ['hit', 'msg_8']);
  requests[1]!.answer.resolve({ messages: [hit(8), hit(3)], has_more: false, next_before: null });
  await more;
  assert.deepEqual(controller.state.hits.map((entry) => entry.id), ['msg_9', 'msg_8', 'msg_3']);
  assert.deepEqual([controller.state.hasMore, controller.state.loadingMore], [false, false]);
  await controller.loadMore();
  assert.equal(requests.length, 2, 'the last page has no more');
});

test('a failed first page is an error; a failed later page keeps what is shown', async () => {
  const { controller, requests } = harness();
  controller.setQuery('hit');
  await wait();
  requests[0]!.answer.reject(new Error('This search took too long.'));
  await wait(0);
  assert.deepEqual([controller.state.status, controller.state.error, controller.state.hits.length], ['error', 'This search took too long.', 0]);

  controller.setQuery('hits');
  await wait();
  requests[1]!.answer.resolve({ messages: [hit(9)], has_more: true, next_before: 'msg_9' });
  await wait(0);
  const more = controller.loadMore();
  requests[2]!.answer.reject(new Error('offline'));
  await more;
  assert.deepEqual([controller.state.status, controller.state.error, controller.state.hasMore], ['ready', 'offline', true]);
  assert.deepEqual(controller.state.hits.map((entry) => entry.id), ['msg_9']);
});

test('reset stops a pending search and drops a late answer', async () => {
  const { controller, requests } = harness();
  controller.setQuery('pending');
  controller.reset();
  await wait();
  assert.equal(requests.length, 0, 'the debounced request never leaves');

  controller.setQuery('sent');
  await wait();
  controller.reset();
  requests[0]!.answer.resolve({ messages: [hit(1)], has_more: false, next_before: null });
  await wait(0);
  assert.deepEqual([controller.state.status, controller.state.hits.length], ['idle', 0]);
});

test('highlights are plain runs of text, merged where matches overlap', () => {
  assert.deepEqual(highlightMessageSearchText('Set lock_timeout before the Mint', ['mint', 'LOCK']), [
    { text: 'Set ', match: false }, { text: 'lock', match: true }, { text: '_timeout before the ', match: false }, { text: 'Mint', match: true },
  ]);
  assert.deepEqual(highlightMessageSearchText('abcabc', ['abc', 'bca']), [{ text: 'abcabc', match: true }], 'overlapping matches are one run');
  assert.deepEqual(highlightMessageSearchText('<b>bold</b>', ['bold']), [
    { text: '<b>', match: false }, { text: 'bold', match: true }, { text: '</b>', match: false },
  ], 'markup in a message stays text');
  assert.deepEqual(highlightMessageSearchText('nothing here', ['absent']), [{ text: 'nothing here', match: false }]);
  assert.deepEqual(highlightMessageSearchText('', ['x']), []);
});

test('a snippet shows the first match in context and marks what was cut', () => {
  const long = `${'intro words '.repeat(40)}the needle is here ${'trailing words '.repeat(40)}`;
  const snippet = messageSearchSnippet(long, ['needle'], 80);
  assert.ok(snippet.includes('needle'));
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
  assert.ok(snippet.length <= 82);
  assert.equal(messageSearchSnippet('short  text\nwith a needle', ['needle']), 'short text with a needle', 'whitespace is collapsed');
  assert.ok(!messageSearchSnippet(`needle ${'x '.repeat(200)}`, ['needle'], 60).startsWith('…'), 'a match at the start needs no leading ellipsis');
  assert.ok(messageSearchSnippet(`${'x '.repeat(200)}needle`, ['needle'], 60).endsWith('needle'));
});


test('highlights preserve source offsets when lowercase expands a character', () => {
  assert.deepEqual(highlightMessageSearchText('İstanbul mint!', ['mint']), [
    { text: 'İstanbul ', match: false }, { text: 'mint', match: true }, { text: '!', match: false },
  ]);
  assert.deepEqual(highlightMessageSearchText('İ!', ['i']), [
    { text: 'İ', match: true }, { text: '!', match: false },
  ]);
});

test('every overlapping occurrence of the same term is highlighted', () => {
  assert.deepEqual(highlightMessageSearchText('banana!', ['ana']), [
    { text: 'b', match: false }, { text: 'anana', match: true }, { text: '!', match: false },
  ]);
});

test('a lowercase offset-map length mismatch skips highlighting instead of throwing', (t) => {
  const original = String.prototype.toLowerCase;
  t.mock.method(String.prototype, 'toLowerCase', function (this: string) {
    return String(this) === 'AB' ? 'abx' : original.call(this);
  });
  assert.deepEqual(highlightMessageSearchText('AB', ['x']), [{ text: 'AB', match: false }]);
});
