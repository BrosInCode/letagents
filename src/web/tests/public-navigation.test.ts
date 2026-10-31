import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer, Sidebar: any, WorkspaceNav: any, DocsPage: any, AppShell: any
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Sidebar = (await vite.ssrLoadModule('/src/components/docs/DocsSidebar.vue')).default
  WorkspaceNav = (await vite.ssrLoadModule('/src/components/layout/WorkspaceNav.vue')).default
  DocsPage = (await vite.ssrLoadModule('/src/pages/Docs.vue')).default
  AppShell = (await vite.ssrLoadModule('/src/App.vue')).default
})
after(async () => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
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
    assert.deepEqual(focused, [], 'focus waits until the component render has committed')
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

test('Escape from the docs toggle closes an open drawer and restores toggle focus', () => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [] } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 390, addEventListener() {}, removeEventListener() {} } })
  let vm: any, focused = 0
  const app = renderer.createApp({ setup() {
    vm = DocsPage.setup({}, { expose() {} })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  vm.sidebarToggle.value = { focus: () => focused++ }
  const press = (key: string) => {
    let prevented = false
    vm.handlePageKeydown({ key, preventDefault: () => { prevented = true } })
    return prevented
  }
  try {
    vm.sidebarOpen.value = true
    assert.equal(press('Tab'), false)
    assert.equal(vm.sidebarOpen.value, true)
    assert.equal(press('Escape'), true)
    assert.equal(vm.sidebarOpen.value, false)
    assert.equal(focused, 1)
    assert.equal(press('Escape'), false, 'closed navigation leaves Escape available to other controls')
    assert.equal(focused, 1)
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

test('landing theme follows the existing preference and refreshes after a room changes it', async () => {
  let activeTheme = 'light'
  const document = { documentElement: {
    getAttribute: () => activeTheme,
    setAttribute: (_name: string, value: string) => { activeTheme = value },
  } }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'landing', component: { render: () => null } },
    { path: '/in/test', name: 'room', component: { render: () => null } },
  ] })
  await router.push('/')
  let vm: any
  const app = renderer.createApp({ setup() {
    vm = AppShell.setup({}, { expose() {} })
    return () => h('div')
  } })
  app.use(router)
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  try {
    assert.equal(vm.theme.value, 'light')
    assert.equal(activeTheme, 'light', 'opening the landing page must not impose a new preference')
    vm.toggleLandingTheme()
    assert.equal(vm.theme.value, 'dark')
    assert.equal(activeTheme, 'dark')
    await router.push('/in/test')
    activeTheme = 'light'
    await router.push('/')
    await nextTick()
    assert.equal(vm.theme.value, 'light', 'canvas and theme toggle agree with a preference changed in the room')
  } finally { app.unmount() }
})

test('Venom styling and theme controls are confined to the landing route', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'landing', component: { render: () => h('p', 'Landing') } },
    { path: '/docs', name: 'docs', component: { render: () => h('p', 'Documentation') } },
    { path: '/in/test', name: 'room', component: { render: () => h('p', 'Room') } },
  ] })
  const render = async (path: string) => {
    await router.push(path)
    const app = createSSRApp({ render: () => h(AppShell) })
    app.use(router)
    return renderToString(app)
  }
  const landing = await render('/')
  assert.match(landing, /class="landing-theme"/)
  assert.match(landing, /aria-label="Switch to dark mode"/)
  const docs = await render('/docs')
  assert.doesNotMatch(docs, /class="landing-theme"|nav-theme-toggle/)
  assert.match(docs, /Documentation/)
  const room = await render('/in/test')
  assert.doesNotMatch(room, /landing-theme|nav-theme-toggle|aria-label="Main navigation"/)
  assert.match(room, /Room/)
})
