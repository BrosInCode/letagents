import assert from 'node:assert/strict'
import { before, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { effectScope, nextTick, ref } from 'vue'
import { createServer } from 'vite'
import type { useRoomHistorySearch } from '../src/composables/roomHistorySearch'

let useSearch: typeof useRoomHistorySearch
before(async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true },
  })
  try {
    useSearch = (await vite.ssrLoadModule('/src/composables/roomHistorySearch.ts')).useRoomHistorySearch
  } finally {
    // Only module loading needs Vite. Its background watcher timers must not
    // share the per-test fake clocks used to exercise the search debounce.
    await vite.close()
  }
})

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const message = (id: string) => ({ id, sender: "Ada | Emmy's agent | Codex", text: 'canonical needle', timestamp: '2026-10-02T12:00:00Z' })
const page = (ids: string[], more = false) => ({ terms: ['needle'], messages: ids.map(message), has_more: more, next_before: more ? ids.at(-1) : null })
function setup(t: TestContext, initialRoom = 'github.com/org/repo') {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: Array<{ path: string; options?: RequestInit; respond: (body: unknown, status?: number) => void }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (path: string, options?: RequestInit) => new Promise<Response>((resolve) => {
    requests.push({ path, options, respond: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })) })
  })) as typeof fetch
  const room = ref(initialRoom), query = ref('')
  const scope = effectScope()
  const vm = scope.run(() => useSearch(room, query))!
  t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
  const search = async (text = 'needle') => {
    query.value = text
    await nextTick()
    t.mock.timers.tick(250)
    await settle()
  }
  return { room, query, scope, vm, requests, search }
}

test('debounces typing, encodes room/query, and maps readable text and identity', async (t) => {
  const h = setup(t, 'github.com/org/a b%repo')
  h.query.value = 'ne'; await nextTick()
  t.mock.timers.tick(249)
  assert.equal(h.requests.length, 0)
  h.query.value = '  needle & "100%"  '; await nextTick()
  t.mock.timers.tick(249)
  assert.equal(h.requests.length, 0)
  t.mock.timers.tick(1); await settle()
  assert.equal(h.requests.length, 1)
  const request = h.requests[0]!
  const url = new URL(request.path, 'http://local')
  assert.equal(url.pathname, '/rooms/github.com%2Forg%2Fa%20b%25repo/messages/search')
  assert.equal(url.searchParams.get('q'), 'needle & "100%"')
  assert.equal(url.searchParams.has('before'), false)
  assert.equal(request.options?.credentials, 'same-origin')
  request.respond({ ...page([]), messages: [
    { ...message('msg_2'), display_text: 'readable needle', agent_identity: { display_name: 'BrookCopper' } },
    message('msg_1'),
  ] }); await settle()
  assert.equal(h.vm.state.value.status, 'ready')
  assert.deepEqual(h.vm.hits.value.map(({ sender, text }) => ({ sender, text })), [
    { sender: 'BrookCopper', text: 'readable needle' }, { sender: 'Ada', text: 'canonical needle' },
  ])
})

test('invalid queries and an empty room never issue requests', async (t) => {
  const h = setup(t)
  for (const query of ['', 'a', 'x'.repeat(201), 'aa bb cc dd ee ff gg']) await h.search(query)
  assert.equal(h.requests.length, 0)
  assert.equal(h.vm.state.value.status, 'invalid')
  h.room.value = ''; await h.search()
  assert.equal(h.vm.state.value.status, 'idle')
  assert.equal(h.requests.length, 0)
})

test('load more sends the cursor, keeps results on failure and retries', async (t) => {
  const h = setup(t)
  await h.search()
  h.requests[0]!.respond(page(['msg_9'], true)); await settle()
  const first = h.vm.loadMore()
  assert.equal(h.vm.state.value.loadingMore, true)
  await h.vm.loadMore()
  assert.equal(h.requests.length, 2)
  assert.equal(new URL(h.requests[1]!.path, 'http://local').searchParams.get('before'), 'msg_9')
  h.requests[1]!.respond({ error: 'Search timed out', code: 'search_timeout' }, 503); await first
  assert.equal(h.vm.state.value.error, 'Search timed out')
  assert.deepEqual(h.vm.hits.value.map((hit) => hit.id), ['msg_9'])
  const retry = h.vm.loadMore()
  h.requests[2]!.respond(page(['msg_9', 'msg_4'])); await retry
  assert.deepEqual(h.vm.hits.value.map((hit) => hit.id), ['msg_9', 'msg_4'])
  assert.equal(h.vm.state.value.error, null)
  await h.vm.loadMore()
  assert.equal(h.requests.length, 3)
})

test('first-page errors are exposed without retaining prior hits', async (t) => {
  const h = setup(t)
  await h.search()
  h.requests[0]!.respond({ error: 'This search took too long.' }, 503); await settle()
  assert.equal(h.vm.state.value.status, 'error')
  assert.equal(h.vm.state.value.error, 'This search took too long.')
  assert.deepEqual(h.vm.hits.value, [])
})

test('changing rooms with the same query drops late answers and searches the new room', async (t) => {
  const h = setup(t)
  await h.search()
  h.room.value = 'focus_2'; await h.search()
  assert.equal(h.requests.length, 2)
  assert.equal(new URL(h.requests[1]!.path, 'http://local').pathname, '/rooms/focus_2/messages/search')
  h.requests[1]!.respond(page(['msg_2'])); await settle()
  h.requests[0]!.respond(page(['msg_99'])); await settle()
  assert.deepEqual(h.vm.hits.value.map((hit) => hit.id), ['msg_2'])
})

test('an old load-more error cannot change the new room or query', async (t) => {
  const h = setup(t)
  await h.search()
  h.requests[0]!.respond(page(['msg_9'], true)); await settle()
  const more = h.vm.loadMore()
  h.room.value = 'focus_2'; await h.search('other')
  h.requests[2]!.respond(page(['msg_1'])); await settle()
  h.requests[1]!.respond({ error: 'old room failed' }, 500); await more
  assert.equal(h.vm.state.value.error, null)
  assert.deepEqual(h.vm.hits.value.map((hit) => hit.id), ['msg_1'])
})

test('emptying the room and disposing discard requests and pending debounce work', async (t) => {
  const h = setup(t)
  await h.search()
  h.room.value = ''; await nextTick()
  h.requests[0]!.respond(page(['msg_9'])); await settle()
  assert.equal(h.vm.state.value.status, 'idle')
  h.room.value = 'focus_2'; await h.search()
  h.scope.stop()
  h.requests[1]!.respond(page(['msg_2'])); await settle()
  assert.equal(h.vm.state.value.status, 'idle')
  h.query.value = 'after dispose'; await nextTick(); t.mock.timers.tick(250)
  assert.equal(h.requests.length, 2)
})

test('disposal before the debounce fires cancels the request', async (t) => {
  const h = setup(t)
  h.query.value = 'needle'; await nextTick()
  h.scope.stop(); t.mock.timers.tick(250); await settle()
  assert.equal(h.requests.length, 0)
})
