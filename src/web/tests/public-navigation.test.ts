import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer, Sidebar: any, WorkspaceNav: any
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Sidebar = (await vite.ssrLoadModule('/src/components/docs/DocsSidebar.vue')).default
  WorkspaceNav = (await vite.ssrLoadModule('/src/components/layout/WorkspaceNav.vue')).default
})
after(async () => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  await vite?.close()
})

test('workspace navigation keeps all account destinations and marks the current page', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: ['/', '/my-work', '/messages', '/connectors'].map(path => ({ path, component: { render: () => null } })) })
  await router.push('/messages')
  const app = createSSRApp({ render: () => h(WorkspaceNav) })
  app.use(router)
  const html = await renderToString(app)
  assert.match(html, /aria-label="LetAgents home"/)
  assert.match(html, /aria-label="Workspace"/)
  for (const path of ['/my-work', '/messages', '/connectors']) assert.ok(html.includes(`href="${path}"`))
  assert.match(html, /<a[^>]*aria-current="page"[^>]*href="\/messages"|<a[^>]*href="\/messages"[^>]*aria-current="page"/)
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1)
})

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
test('mobile docs navigation moves focus in, contains Tab, and requests dismissal with Escape', async () => {
  const props = reactive({ open: false, mobile: true, activeSection: 'overview', sections: [] })
  const events: string[] = [], focused: string[] = []
  const first = { focus: () => focused.push('close') }, last = { focus: () => focused.push('last-link') }, active = { focus: () => focused.push('active-link') }
  const document = { activeElement: first }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  let vm: any
  const app = renderer.createApp({ setup() {
    vm = Sidebar.setup(props, { expose() {}, emit: (event: string) => events.push(event) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  vm.sidebar.value = { querySelector: () => active, querySelectorAll: () => [first, last] }
  const press = (key: string, shiftKey = false) => {
    let prevented = false
    vm.handleKeydown({ key, shiftKey, preventDefault: () => { prevented = true } })
    return prevented
  }
  try {
    props.open = true
    await nextTick(); await nextTick()
    assert.deepEqual(focused, ['active-link'])
    assert.equal(press('Tab', true), true)
    assert.equal(focused.at(-1), 'last-link')
    document.activeElement = last
    assert.equal(press('Tab'), true)
    assert.equal(focused.at(-1), 'close')
    assert.equal(press('Escape'), true)
    assert.deepEqual(events, ['close'])
    props.mobile = false
    assert.equal(press('Tab'), false, 'desktop sidebar leaves normal document tab order intact')
    assert.equal(press('Escape'), false)
    props.mobile = true; props.open = false
    assert.equal(press('Tab'), false, 'a closed drawer must not intercept keyboard navigation')
  } finally { app.unmount() }
})

test('docs sidebar exposes dialog and current-location semantics only where appropriate', async () => {
  const props = { sections: [{ label: 'Start', links: [{ id: 'overview', label: 'Overview' }] }], activeSection: 'overview', open: true, mobile: true }
  const render = () => renderToString(createSSRApp({ render: () => h(Sidebar, props) }))
  assert.match(await render(), /role="dialog" aria-modal="true"/)
  assert.match(await render(), /aria-current="location"/)
  props.mobile = false
  const desktop = await render()
  assert.match(desktop, /role="navigation"/)
  assert.doesNotMatch(desktop, /aria-modal|Close navigation/)
})
