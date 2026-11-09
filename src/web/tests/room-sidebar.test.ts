import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer, Sidebar: any, auth: any
const originals = new Map(['window', 'document', 'navigator', 'fetch', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let account: any = { id: 'ada', login: 'ada', display_name: 'Ada', avatar_url: null }
let fetchRooms: () => Promise<Response> = async () => Response.json({ rooms: [] })
const requests: RequestInit[] = []
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }
const project = (id: string, extra = {}) => ({ room_id: id, display_name: id, focus_rooms: [], ...extra })
before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: () => null, getElementById: () => null, activeElement: null } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'MacIntel' } })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class {} })
  globalThis.fetch = async (url, options) => {
    if (String(url) === '/auth/session') return Response.json({ authenticated: Boolean(account), account })
    assert.equal(url, '/account/rooms?limit=100')
    requests.push(options || {})
    return fetchRooms()
  }
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Sidebar = (await vite.ssrLoadModule('/src/components/room/RoomSidebar.vue')).default
  auth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth()
  await auth.checkSession()
})
after(async () => {
  await vite?.close()
  for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
})
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
async function mount(extra = {}) {
  const props = reactive({ open: true, compact: false, activeRoomId: 'project', ...extra })
  const events: any[] = []
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:path(.*)', component: { render: () => null } }] })
  await router.push('/in/project')
  let vm: any
  const app = renderer.createApp({ setup() { vm = Sidebar.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div') } })
  app.use(router); app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
  await flush()
  return { vm, props, events, router, unmount: () => app.unmount() }
}

test('groups pinned rooms, excludes archived projects, and keeps the active child in the compact preview', async () => {
  const children = Array.from({ length: 6 }, (_, i) => project(`child-${i}`))
  fetchRooms = async () => Response.json({ rooms: [project('project', { pinned: true, focus_rooms: children }), project('second'), project('archived', { archived: true })] })
  const ctx = await mount({ activeRoomId: 'child-5' })
  try {
    assert.equal(requests.at(-1)?.credentials, 'same-origin')
    assert.deepEqual(ctx.vm.sections.value.map((s: any) => [s.label, s.rooms.length]), [['Pinned', 1], ['Rooms', 1]])
    assert.deepEqual(ctx.vm.preview(ctx.vm.currentProject.value).map((r: any) => r.room_id), ['child-0', 'child-1', 'child-5'])
    ctx.vm.focused.value = true
    assert.deepEqual(ctx.vm.sections.value.map((s: any) => s.label), ['This project'])
    ctx.vm.expanded.value.project = true
    assert.equal(ctx.vm.preview(ctx.vm.currentProject.value).length, 6)
    ctx.vm.query.value = 'child-4'; await nextTick()
    assert.equal(ctx.vm.options.value[0].parent, 'project')
    ctx.vm.choose(ctx.vm.options.value[0]); await flush()
    assert.equal(ctx.router.currentRoute.value.path, '/in/child-4')
  } finally { ctx.unmount() }
})

test('ignores an old account request even when its transport ignores abort', async () => {
  let resolveOld!: (response: Response) => void
  fetchRooms = () => new Promise(resolve => { resolveOld = resolve })
  const ctx = await mount()
  try {
    fetchRooms = async () => Response.json({ rooms: [project('new-account-room')] })
    account = { ...account, id: 'grace', login: 'grace' }
    await auth.checkSession(); await flush()
    resolveOld(Response.json({ rooms: [project('private-old-room')] })); await flush()
    assert.deepEqual(ctx.vm.rooms.value.map((r: any) => r.room_id), ['new-account-room'])
    account = null; await auth.checkSession(); await flush()
    assert.deepEqual(ctx.vm.rooms.value, [])
  } finally { ctx.unmount(); account = { id: 'ada', login: 'ada' }; await auth.checkSession() }
})

test('shows a recoverable loading error and preserves an existing collapsed group on refresh', async () => {
  fetchRooms = async () => new Response('offline', { status: 503 })
  const ctx = await mount()
  try {
    assert.equal(ctx.vm.error.value, 'Could not load rooms.')
    fetchRooms = async () => Response.json({ rooms: [project('project', { focus_rooms: [project('child')] })] })
    await ctx.vm.loadRooms(); await flush()
    assert.equal(ctx.vm.error.value, '')
    ctx.vm.collapsed.value.project = true
    await ctx.vm.loadRooms(); await flush()
    assert.equal(ctx.vm.collapsed.value.project, true)
  } finally { ctx.unmount() }
})

test('mobile navigation contains Tab, focuses on open, and dismisses with Escape; desktop does not trap', async () => {
  fetchRooms = async () => Response.json({ rooms: [] })
  const ctx = await mount({ open: false, compact: true })
  const focused: string[] = []
  const first = { focus: () => focused.push('first'), getClientRects: () => [1] }, last = { focus: () => focused.push('last'), getClientRects: () => [1] }
  ctx.vm.sidebar.value = { querySelector: () => first, querySelectorAll: () => [first, last] }
  const press = (key: string, shiftKey = false) => { let prevented = false; ctx.vm.sidebarKeydown({ key, shiftKey, preventDefault: () => { prevented = true } }); return prevented }
  try {
    ctx.props.open = true; await nextTick(); await nextTick()
    assert.deepEqual(focused, ['first'])
    Object.assign(document, { activeElement: first }); assert.equal(press('Tab', true), true); assert.equal(focused.at(-1), 'last')
    Object.assign(document, { activeElement: last }); assert.equal(press('Tab'), true); assert.equal(focused.at(-1), 'first')
    assert.equal(press('Escape'), true); assert.ok(ctx.events.some(event => event[0] === 'close'))
    ctx.props.compact = false; assert.equal(press('Tab'), false)
    ctx.props.compact = true; ctx.props.open = false; assert.equal(press('Tab'), false)
  } finally { ctx.unmount() }
})

test('the compact sidebar does not block its own switcher shortcut, but a visible modal does', async () => {
  fetchRooms = async () => Response.json({ rooms: [] })
  const ctx = await mount({ compact: true })
  let opened = 0
  const own = { getClientRects: () => [1] }
  const hidden = { getClientRects: () => [] }
  const other = { getClientRects: () => [1] }
  ctx.vm.sidebar.value = own
  ctx.vm.switcher.value = { open: false, showModal: () => opened++, close() {} }
  const press = (keys = {}) => { let prevented = false; ctx.vm.shortcut({ key: 'k', metaKey: true, ...keys, preventDefault: () => { prevented = true } }); return prevented }
  try {
    Object.assign(document, { querySelectorAll: () => [ctx.vm.sidebar.value, hidden] })
    assert.equal(press(), true); assert.equal(opened, 1)
    ctx.props.open = false
    assert.equal(press(), true); assert.equal(opened, 2)
    Object.assign(document, { querySelectorAll: () => [ctx.vm.sidebar.value, other] })
    assert.equal(press(), false); assert.equal(opened, 2)
    Object.assign(document, { querySelectorAll: () => [] })
    assert.equal(press({ metaKey: false, ctrlKey: true }), false, 'Mac Ctrl+K retains text editing')
    assert.equal(press({ isComposing: true }), false)
  } finally { ctx.unmount() }
})
