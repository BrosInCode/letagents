import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let GitHubEventCard: unknown
let Group: any

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  GitHubEventCard = (await vite.ssrLoadModule('/src/components/room/GitHubEventCard.vue')).default
  Group = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/RoomGitHubUpdates.vue', import.meta.url)))).default
})

after(async () => {
  await vite?.close()
})

test('GitHub event task chips expose the Board navigation contract', async () => {
  const app = createSSRApp({
    render: () => h(GitHubEventCard as object, {
      event: {
        kind: 'pull-request',
        tone: 'violet',
        kindLabel: 'Pull request',
        statusLabel: 'opened',
        headline: 'PR #800 opened',
        detail: 'Link task mentions',
        repository: 'BrosInCode/letagents',
        taskId: 'task_42',
        url: 'https://github.com/BrosInCode/letagents/pull/800',
        urlLabel: 'Open pull request',
      },
      taskLinkEnabled: true,
    }),
  })

  const html = await renderToString(app)
  assert.match(html, /<button[^>]*data-task-reference-id="task_42"/)
  assert.match(html, /title="Open task_42 on the Board"/)
})

const historyEvent = { kind: 'pull-request', tone: 'violet', kindLabel: 'Pull request', statusLabel: 'opened',
  headline: 'PR #800 opened by Ada', detail: 'A readable room', repository: 'BrosInCode/letagents', taskId: null,
  url: 'https://github.com/BrosInCode/letagents/pull/800', urlLabel: 'Open pull request' }

test('history rows show the original event and its time inline, with secondary actions disclosed on demand', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(GitHubEventCard as object, {
    event: historyEvent, history: true, room: true, timestamp: '2026-10-12T02:41:15Z',
  }) }))
  assert.match(html, /PR #800 opened by Ada/)
  assert.match(html, /<time[^>]*datetime="2026-10-12T02:41:15Z"/)
  assert.match(html, /github-history-toggle[^>]*aria-expanded="false"/)
  assert.doesNotMatch(html, /class="github-event-actions"/)
  assert.doesNotMatch(html, /A readable room/)
})

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
test('whole-group collapse retains individual history state; revealing a hidden original opens both levels', async () => {
  const messages = [{ id: 'msg_1', timestamp: '2026-10-12T02:41:15Z' }]
  const props = { grouped: true, messages, parseEvent: () => historyEvent }
  const html = await renderToString(createSSRApp({ render: () => h(Group, props) }))
  assert.match(html, /<button[^>]*class="github-updates-heading"[^>]*aria-expanded="true"[^>]*aria-controls=/)
  let vm: any
  const events: string[] = []
  const app = renderer.createApp({ setup() {
    vm = Group.setup(props, { expose() {}, emit: (name: string) => events.push(name) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  try {
    const key = vm.rows.value[0].key
    await vm.toggle(key, { detail: 0 })
    assert.equal(vm.open.value.has(key), true)
    await vm.toggleGroup({ detail: 0 })
    assert.equal(vm.collapsed.value, true)
    assert.equal(vm.open.value.has(key), true)
    assert.equal(vm.instant.value, true, 'keyboard toggles have no motion')
    vm.open.value.clear()
    let ready = false
    vm.reveal({ detail: { id: 'msg_1', ready: () => { ready = true } }, stopPropagation() {} })
    await nextTick()
    assert.equal(vm.collapsed.value, false)
    assert.equal(vm.open.value.has(key), true)
    assert.equal(ready, true)
    assert.equal(events.filter(name => name === 'layoutStart').length, 2)
  } finally { app.unmount() }
})

for (const atBottom of [false, true]) {
  test(`collapsed groups retain ${atBottom ? 'latest intent' : 'older history'} across incoming updates`, async () => {
    const props = reactive({ grouped: true, messages: [{ id: 'msg_1', timestamp: '2026-10-12T02:41:15Z' }], parseEvent: () => historyEvent })
    let vm: any
    const app = renderer.createApp({ setup() { vm = Group.setup(props, { expose() {}, emit() {} }); return () => h('div') } })
    app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
    try {
      const key = vm.rows.value[0].key
      let top = atBottom ? 400 : 120, height = 500
      const el: any = { get scrollTop() { return top }, set scrollTop(value) { top = Math.min(value, height - 100) },
        get clientHeight() { return vm.collapsed.value ? 0 : 100 }, get scrollHeight() { return vm.collapsed.value ? 0 : height },
        getBoundingClientRect: () => ({ top: 0 }), children: [] }
      el.children = [{ dataset: { messageId: 'msg_1' }, getBoundingClientRect: () => ({ top: 120 - top, bottom: 164 - top }) }]
      vm.scrollers.set(key, el); vm.open.value.add(key); vm.rememberScroll(key)
      await vm.toggleGroup({ detail: 0 })
      height = 700
      props.messages.push({ id: 'msg_2', timestamp: '2026-10-12T02:42:15Z' })
      await nextTick(); await nextTick()
      vm.rememberScroll(key) // A delayed browser scroll event from hiding the element.
      await vm.toggleGroup({ detail: 0 })
      assert.equal(top, atBottom ? 600 : 120)
      assert.equal(vm.unseen.value.has(key), !atBottom)
    } finally { app.unmount() }
  })
}
