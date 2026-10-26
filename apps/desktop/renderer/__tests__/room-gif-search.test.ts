import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer, gifSearch: any;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: Object.assign(new EventTarget(), { letagentsDesktop: { room: {} }, matchMedia: () => ({ matches: false }) }) });
  vite = await createServer({ root: fileURLToPath(new URL('../..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  gifSearch = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/room-gif-search.ts');
});
after(async () => {
  await vite?.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Hand-driven timers: `fire(ms)` runs every timer of that delay. */
function fakeTimers() {
  let nextId = 0;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => { pending.set(++nextId, { callback, ms }); return nextId; },
    clearTimer: (handle: unknown) => { pending.delete(handle as number); },
    fire(ms?: number) {
      for (const [id, timer] of [...pending]) if (ms === undefined || timer.ms === ms) { pending.delete(id); timer.callback(); }
    },
  };
}

const gif = (id: string) => ({ provider: 'giphy', id, title: `GIF ${id}`, page_url: `https://giphy.com/gifs/${id}`, preview_url: `https://media.giphy.com/${id}.gif`, still_url: `https://media.giphy.com/${id}_s.gif`, image_url: null });
const page = (ids: string[], next: number | null) => ({ ok: true, items: ids.map(gif), next_offset: next });

/** A search whose answers the test releases one by one, in any order. */
function controlledSearch() {
  const calls: Array<{ query: string; offset: number; resolve: (value: any) => void; reject: (error: Error) => void }> = [];
  const search = (query: string, offset: number) => new Promise((resolve, reject) => { calls.push({ query, offset, resolve, reject }); });
  return { calls, search };
}

test('typing waits for a short pause and searches only the last query', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, debounceMs: 250, ...timers });
  gifs.setQuery('s');
  gifs.setQuery('sh');
  gifs.setQuery('ship');
  assert.equal(gifs.loading.value, true, 'shows loading while waiting');
  assert.equal(calls.length, 0, 'nothing is sent before the pause');
  assert.equal(timers.pending.size, 1, 'each keystroke replaces the waiting search');
  timers.fire(250);
  assert.deepEqual(calls.map(call => [call.query, call.offset]), [['ship', 0]]);
  calls[0].resolve(page(['a', 'b'], 12));
  await settle();
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['a', 'b']);
  assert.equal(gifs.loading.value, false);
  assert.equal(gifs.nextOffset.value, 12);
});

test('a late answer for an older query is dropped', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('cat', { immediate: true });
  gifs.setQuery('dog', { immediate: true });
  assert.equal(calls.length, 2);
  calls[1].resolve(page(['dog-1'], null));
  await settle();
  calls[0].resolve(page(['cat-1'], 12));
  await settle();
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['dog-1'], 'the cat answer arrived last but is not shown');
  assert.equal(gifs.nextOffset.value, null);

  gifs.setQuery('');
  assert.deepEqual(gifs.items.value, [], 'clearing the search clears the results');
  assert.equal(gifs.loading.value, false);
});

test('a new query hides the old results at once, so Enter cannot add a stale GIF', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('cat', { immediate: true });
  calls[0].resolve(page(['cat-1'], null));
  await settle();
  gifs.setQuery('cats');
  assert.deepEqual(gifs.items.value, []);
});

test('the next page loads from next_offset, once at a time, and stops at the end', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.loadMore();
  assert.equal(calls.length, 0, 'no query, no page');
  gifs.setQuery('lgtm', { immediate: true });
  gifs.loadMore();
  assert.equal(calls.length, 1, 'no second page before the first arrives');
  calls[0].resolve(page(['a', 'b', 'c'], 12));
  await settle();
  gifs.loadMore();
  gifs.loadMore();
  assert.deepEqual(calls.slice(1).map(call => [call.query, call.offset]), [['lgtm', 12]], 'one page request at a time');
  assert.equal(gifs.loadingMore.value, true);
  calls[1].resolve(page(['c', 'd'], null));
  await settle();
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['a', 'b', 'c', 'd'], 'pages append; a repeated GIF shows once');
  assert.equal(gifs.loadingMore.value, false);
  gifs.loadMore();
  assert.equal(calls.length, 2, 'no page after the last');
});

test('a page for an older query is dropped when the query changes', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('nice', { immediate: true });
  calls[0].resolve(page(['n1'], 12));
  await settle();
  gifs.loadMore();
  gifs.setQuery('wow', { immediate: true });
  calls[1].resolve(page(['n2'], 24));
  calls[2].resolve(page(['w1'], null));
  await settle();
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['w1']);
  assert.equal(gifs.nextOffset.value, null);
});

test('a rate limit shows the client wording and sends nothing until retry_after_ms ends, then searches again', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('ship it', { immediate: true });
  calls[0].resolve({ ok: false, code: 'rate_limited', message: 'GIF search is temporarily at its limit. You can send text instead.', retry_after_ms: 30_000 });
  await settle();
  assert.equal(gifs.error.value, 'GIF search is temporarily at its limit. You can send text instead.');
  assert.equal(gifs.coolingDown.value, true);

  gifs.setQuery('ship it!', { immediate: true });
  await settle();
  assert.equal(calls.length, 1, 'no request during the wait');
  assert.equal(gifs.error.value, 'GIF search is temporarily at its limit. You can send text instead.', 'the wait stays explained');
  assert.equal(gifs.loading.value, false);

  timers.fire(30_000);
  assert.equal(gifs.coolingDown.value, false);
  assert.deepEqual(calls.slice(1).map(call => call.query), ['ship it!'], 'the refused search runs once the wait ends');
  calls[1].resolve(page(['s1'], null));
  await settle();
  assert.equal(gifs.error.value, '');
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['s1']);
});

test('a failed page keeps the shown GIFs; a failure with no wait stops paging', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('on it', { immediate: true });
  calls[0].resolve(page(['o1'], 12));
  await settle();
  gifs.loadMore();
  calls[1].resolve({ ok: false, code: 'unavailable', message: 'GIFs are unavailable right now. You can send text instead.', retry_after_ms: 15_000 });
  await settle();
  assert.deepEqual(gifs.items.value.map((item: any) => item.id), ['o1']);
  assert.equal(gifs.error.value, 'GIFs are unavailable right now. You can send text instead.');
  gifs.loadMore();
  assert.equal(calls.length, 2, 'no page during the wait');
  timers.fire(15_000);
  assert.equal(calls.length, 2, 'shown results are not searched again by themselves');
  assert.equal(gifs.error.value, '', 'the page message goes when the wait ends');
  gifs.loadMore();
  assert.equal(calls.length, 3, 'paging resumes after the wait');
  calls[2].reject(new Error('IPC gone'));
  await settle();
  assert.equal(gifs.error.value, 'GIFs are unavailable right now. You can send text instead.', 'a thrown call uses the client wording');
  gifs.loadMore();
  assert.equal(calls.length, 3);
});

test('a query over 50 characters is refused with the client wording and not sent', () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('x'.repeat(51), { immediate: true });
  assert.equal(calls.length, 0);
  assert.equal(gifs.error.value, 'Use a GIF search of 1–50 characters.');
  gifs.setQuery(`  ${'x'.repeat(50)}`, { immediate: true });
  assert.deepEqual(calls.map(call => call.query), ['x'.repeat(50)], 'spaces around a 50-character search do not count');
});

test('dispose drops answers and timers', async () => {
  const timers = fakeTimers();
  const { calls, search } = controlledSearch();
  const gifs = gifSearch.createRoomGifSearch({ search, ...timers });
  gifs.setQuery('typing');
  gifs.setQuery('done', { immediate: true });
  gifs.dispose();
  assert.equal(timers.pending.size, 0);
  calls[0].resolve(page(['late'], null));
  await settle();
  assert.deepEqual(gifs.items.value, []);
});

test('arrow keys move through a 3-column grid; up or left from the first row returns to the search box', () => {
  const move = gifSearch.gifGridTarget;
  assert.equal(move(0, 'ArrowRight', 12), 1);
  assert.equal(move(11, 'ArrowRight', 12), 11, 'the last tile stays');
  assert.equal(move(4, 'ArrowLeft', 12), 3);
  assert.equal(move(0, 'ArrowLeft', 12), 'search');
  assert.equal(move(1, 'ArrowDown', 12), 4);
  assert.equal(move(10, 'ArrowDown', 12), 11, 'down from a short last row lands on the last tile');
  assert.equal(move(4, 'ArrowUp', 12), 1);
  assert.equal(move(2, 'ArrowUp', 12), 'search');
  assert.equal(move(5, 'Home', 12), 0);
  assert.equal(move(5, 'End', 12), 11);
  assert.equal(move(5, 'Enter', 12), null, 'Enter stays a button press');
  assert.equal(move(0, 'ArrowDown', 0), null);
});

test('/gif <query> is read from the draft; other text is not', () => {
  const read = gifSearch.gifCommandQuery;
  assert.equal(read('/gif lgtm'), 'lgtm');
  assert.equal(read('  /GIF   ship it  '), 'ship it');
  assert.equal(read('/gif'), '');
  assert.equal(read('/gifs please'), null);
  assert.equal(read('send a /gif lgtm'), null);
  assert.equal(read('/gif one\ntwo'), null, 'a multi-line draft is a message');
  assert.equal(read(`/gif ${'y'.repeat(80)}`)?.length, 50);
});

test('reduced motion shows the still frame', () => {
  const item = gif('m');
  assert.equal(gifSearch.gifPreviewSource(item, false), item.preview_url);
  assert.equal(gifSearch.gifPreviewSource(item, true), item.still_url);
  assert.equal(gifSearch.gifPreviewSource({ ...item, still_url: null }, true), item.preview_url);
  assert.deepEqual(gifSearch.GIF_QUICK_TERMS, ['thumbs up', 'ship it', 'lgtm', 'on it', 'nice', 'facepalm']);
});
