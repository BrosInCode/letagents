import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
before(async () => {
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} }
  ;(globalThis as any).window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, localStorage: globalThis.localStorage })
  ;(globalThis as any).document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => true })
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
})
after(async () => { await vite?.close() })
const message = (id: string, text: string, root = id) => ({ id, text, sender: 'Ada', source: 'browser', timestamp: '2026-10-09T12:00:00Z', attachments: [], thread_root_id: root })

test('the room keeps owners and orphan replies visible, with nested replies behind the owner control', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/MessageList.vue')).default
  const html = await renderToString(createSSRApp({ render: () => h(Component, {
    messages: [message('msg_1', 'Root message'), message('msg_2', 'Hidden nested reply', 'msg_1'), message('msg_3', 'Orphan reply', 'msg_99')],
    roomIdentifier: 'test', hasOlderMessages: false, isLoadingOlderMessages: false, searchQuery: '',
  }) }))
  assert.match(html, /Root message/)
  assert.match(html, /Orphan reply/)
  assert.doesNotMatch(html, /Hidden nested reply/)
  assert.match(html, /aria-expanded="false"[^>]*aria-controls="web-thread-msg_1"/)
})

test('inline replies omit the implicit root quote but retain explicit reply references and an independent composer', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/InlineThread.vue')).default
  const parent = message('msg_1', 'Root message')
  const html = await renderToString(createSSRApp({ render: () => h(Component, {
    parent, roomIdentifier: 'test', active: true,
    messages: [{ ...message('msg_2', 'First reply', 'msg_1'), reply_to: parent },
      { ...message('msg_3', 'Second reply', 'msg_1'), reply_to: message('msg_2', 'Quoted reply') }],
  }, { composer: ({ parent }: any) => h('textarea', { 'aria-label': `Reply to ${parent.sender}` }) }) }))
  assert.match(html, /tabindex="0" aria-label="Thread replies"/)
  assert.equal((html.match(/class="reply-preview"/g) || []).length, 1)
  assert.match(html, /Quoted reply/)
  assert.match(html, /aria-label="Reply to Ada"/)
})

test('a delayed thread send stays routed to its original room and does not insert into a different room', async () => {
  const { createRoomMessageActions } = await vite.ssrLoadModule('/src/composables/room/messageActions.ts')
  const state = await vite.ssrLoadModule('/src/composables/room/state.ts')
  const originalFetch = globalThis.fetch
  let finish!: (response: Response) => void
  let requestUrl = ''
  let requestBody: any
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    if (!url.endsWith('/messages')) return new Response('{}', { status: 200 })
    requestUrl = url; requestBody = JSON.parse(options.body as string)
    return new Promise<Response>(resolve => { finish = resolve })
  }) as typeof fetch
  try {
    state.room.value = { identifier: 'room-a' }
    state.replaceRoomMessages([])
    const pending = createRoomMessageActions().sendMessage('Reply', 'Ada', null, 'msg_1', [], 'msg_1')
    assert.equal(requestUrl, '/rooms/room-a/messages')
    assert.equal(requestBody.thread_root_id, 'msg_1')
    state.room.value = { identifier: 'room-b' }
    finish(new Response(JSON.stringify(message('msg_2', 'Reply', 'msg_1')), { status: 200 }))
    assert.equal(await pending, true)
    assert.deepEqual(state.messages.value, [])
  } finally { globalThis.fetch = originalFetch; state.room.value = null }
})

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
function mountSetup(Component: any, props: any) {
  let vm: any
  const state = reactive(props)
  const events: Array<[string, unknown]> = []
  const app = renderer.createApp({ setup() {
    vm = Component.setup(state, { expose() {}, emit: (name: string, value: unknown) => events.push([name, value]) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  return { vm, props: state, events, close: () => app.unmount() }
}

test('opening a recent orphan reply fetches and expands its actual thread root', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/MessageList.vue')).default
  const originalFetch = globalThis.fetch
  const paths: string[] = []
  const parent = message('msg_1', 'Original owner')
  const reply = message('msg_2', 'Recent reply', parent.id)
  globalThis.fetch = (async (url: string) => {
    paths.push(url)
    return new Response(JSON.stringify({ root: parent, replies: [reply], has_older: false }), { status: 200 })
  }) as typeof fetch
  const surface = mountSetup(Component, { messages: [reply], roomIdentifier: 'test', searchQuery: '', messagesLoaded: true, hasOlderMessages: false, isLoadingOlderMessages: false })
  try {
    await surface.vm.toggleThread(reply.id)
    assert.deepEqual(paths, ['/rooms/test/messages/msg_1/thread'])
    assert.equal(surface.vm.activeThreadId.value, parent.id)
    assert.deepEqual(surface.vm.timelineMessages.value.map((row: any) => row.id), [parent.id])
    assert.equal(surface.vm.threadRevealId.value, reply.id)
    const images = surface.events.find(([name]) => name === 'threadMessages')?.[1] as any[]
    assert.deepEqual(images.map(row => row.id), [parent.id, reply.id], 'the image viewer receives the fetched owner as well as its replies')
  } finally { surface.close(); globalThis.fetch = originalFetch }
})

test('send completion preserves a newer quote and Escape consumed by suggestions leaves the thread open', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/InlineThread.vue')).default
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ replies: [], has_older: false }), { status: 200 })) as typeof fetch
  const surface = mountSetup(Component, { parent: message('msg_1', 'Owner'), messages: [], roomIdentifier: 'test', active: true })
  try {
    const quote = message('msg_3', 'New quote', 'msg_1')
    surface.vm.quote.value = quote
    surface.vm.sent('msg_2')
    assert.equal(surface.vm.quote.value.id, quote.id)
    surface.vm.sent(quote.id)
    assert.equal(surface.vm.quote.value, null)
    let touched = false
    surface.vm.onEscape({ defaultPrevented: true, preventDefault() { touched = true }, stopPropagation() { touched = true } })
    assert.equal(touched, false)
    await nextTick()
  } finally { surface.close(); globalThis.fetch = originalFetch }
})

test('incoming messages do not repeat a finished reply reveal', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/InlineThread.vue')).default
  const originalFetch = globalThis.fetch
  const originalCSS = globalThis.CSS
  ;(globalThis as any).CSS = { escape: (id: string) => id }
  globalThis.fetch = (async () => new Response(JSON.stringify({ replies: [], has_older: false }), { status: 200 })) as typeof fetch
  const reply = message('msg_2', 'Reply', 'msg_1')
  const surface = mountSetup(Component, { parent: message('msg_1', 'Owner'), messages: [reply], roomIdentifier: 'test', active: true, revealMessageId: null })
  let reveals = 0
  const body = {
    scrollTop: 120, scrollHeight: 1000, clientHeight: 200,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [],
    querySelector: () => ({ getBoundingClientRect: () => ({ top: 200 }), classList: { add() {}, remove() {} } }),
    scrollTo: () => { reveals++ },
  }
  try {
    await new Promise(resolve => setImmediate(resolve)); await nextTick()
    surface.vm.body.value = body
    surface.props.revealMessageId = reply.id
    await nextTick(); await nextTick()
    assert.equal(reveals, 1)
    surface.props.messages = [reply, message('msg_3', 'New reply', 'msg_1'), message('msg_4', 'Unrelated room message')]
    await nextTick(); await nextTick()
    assert.equal(reveals, 1, 'new arrivals preserve the user reading position after navigation')
  } finally { surface.close(); globalThis.fetch = originalFetch; (globalThis as any).CSS = originalCSS }
})

for (const returnToOrigin of [false, true]) {
  test(`older backfill ignores a stale response after A→B${returnToOrigin ? '→A' : ''}`, async () => {
    const { createRoomMessageActions } = await vite.ssrLoadModule('/src/composables/room/messageActions.ts')
    const state = await vite.ssrLoadModule('/src/composables/room/state.ts')
    const originalFetch = globalThis.fetch
    let finish!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve })) as typeof fetch
    const reset = () => state.resetRoomState({ activityHistoryLoading: false, githubEventsLoading: false, connectionState: 'idle' })
    try {
      reset(); state.room.value = { identifier: 'room-a' }; state.replaceRoomMessages([message('msg_20', 'A')]); state.messagesHasOlder.value = true
      const pending = createRoomMessageActions().loadOlderMessages()
      reset(); state.room.value = { identifier: 'room-b' }
      if (returnToOrigin) { reset(); state.room.value = { identifier: 'room-a' } }
      state.replaceRoomMessages([message('msg_30', 'Current session')]); state.isLoadingOlderMessages.value = true; state.messagesHasOlder.value = true
      finish(new Response(JSON.stringify({ messages: [message('msg_1', 'Stale')], has_older: false }), { status: 200 }))
      assert.equal(await pending, false)
      assert.deepEqual(state.messages.value.map((m: any) => m.id), ['msg_30'])
      assert.equal(state.isLoadingOlderMessages.value, true, 'stale finally must not clear the current request')
      assert.equal(state.messagesHasOlder.value, true)
    } finally { globalThis.fetch = originalFetch; reset() }
  })
}
test('failed older backfill exposes an error and a manual retry can recover', async () => {
  const { createRoomMessageActions } = await vite.ssrLoadModule('/src/composables/room/messageActions.ts')
  const state = await vite.ssrLoadModule('/src/composables/room/state.ts')
  const originalFetch = globalThis.fetch
  try {
    state.room.value = { identifier: 'room-a' }; state.replaceRoomMessages([message('msg_20', 'A')]); state.messagesHasOlder.value = true
    globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
    const actions = createRoomMessageActions()
    assert.equal(await actions.loadOlderMessages(), false)
    assert.ok(state.olderMessagesError.value)
    assert.equal(state.isLoadingOlderMessages.value, false)
    globalThis.fetch = (async () => new Response(JSON.stringify({ messages: [message('msg_1', 'Recovered')], has_older: false }), { status: 200 })) as typeof fetch
    assert.equal(await actions.loadOlderMessages(), true)
    assert.equal(state.olderMessagesError.value, '')
  } finally { globalThis.fetch = originalFetch; state.resetRoomState({ activityHistoryLoading: false, githubEventsLoading: false, connectionState: 'idle' }) }
})

test('bookmark restore recognizes regrouped originals, and a failed page stops automatic requests', async () => {
  const Component = (await vite.ssrLoadModule('/src/components/room/MessageList.vue')).default
  const originalCSS = globalThis.CSS
  ;(globalThis as any).CSS = { escape: (id: string) => id }
  const surface = mountSetup(Component, { messages: [message('msg_20', 'Latest')], roomIdentifier: 'bookmark-room', messagesLoaded: false,
    hasOlderMessages: true, isLoadingOlderMessages: false, olderMessagesError: '', initialScrollPosition: { top: 420, latest: false, anchor: { messageId: 'msg_1', offsetTop: -20 } } })
  let found = false
  const el: any = Object.assign(new EventTarget(), { isConnected: true, clientHeight: 400, scrollHeight: 1200, scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }), querySelectorAll: () => [],
    querySelector: () => found ? { closest: () => ({ getBoundingClientRect: () => ({ top: 400 - el.scrollTop }) }) } : null,
    scrollTo: ({ top, behavior }: any) => { assert.equal(behavior, 'instant'); el.scrollTop = top } })
  try {
    surface.vm.messagesEl.value = el
    surface.props.messagesLoaded = true
    await nextTick(); await nextTick()
    assert.equal(surface.events.filter(([name]) => name === 'loadOlder').length, 1)
    surface.props.isLoadingOlderMessages = true; await nextTick()
    surface.props.isLoadingOlderMessages = false
    await nextTick(); await nextTick(); await nextTick()
    assert.equal(surface.events.filter(([name]) => name === 'loadOlder').length, 2, 'a filtered page must not stall restoration')
    surface.props.isLoadingOlderMessages = true; await nextTick()
    surface.props.olderMessagesError = 'offline'; surface.props.isLoadingOlderMessages = false
    await nextTick(); await nextTick(); await nextTick()
    assert.equal(surface.events.filter(([name]) => name === 'loadOlder').length, 2, 'failed restore must not retry in a loop')
    surface.props.roomIdentifier = 'regrouped-room'; found = true; surface.props.olderMessagesError = ''
    await nextTick(); await nextTick(); await nextTick()
    assert.equal(el.scrollTop, 420, 'resolve the original to its new containing group')
    assert.equal(surface.events.filter(([name]) => name === 'loadOlder').length, 2)
  } finally { surface.close(); globalThis.CSS = originalCSS }
})
