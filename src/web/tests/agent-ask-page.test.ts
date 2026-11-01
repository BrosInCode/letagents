import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, reactive, nextTick, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer, Page: any, AskDialog: any, AskPanel: any, auth: any
const savedFetch = globalThis.fetch
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Page = (await vite.ssrLoadModule('/src/pages/AskLink.vue')).default
  AskDialog = (await vite.ssrLoadModule('/src/components/room/AskAgentDialog.vue')).default
  AskPanel = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/ask-agent/AskAgentPanel.vue', import.meta.url)))).default
  auth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth()
})
beforeEach(async () => { await session(true) })
async function session(signed: boolean) {
  const fetch = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ authenticated: signed, account: signed ? { id: 'viewer', login: 'viewer' } : null }) })) as any
  await auth.checkSession(); globalThis.fetch = fetch
}
after(async () => { globalThis.fetch = savedFetch; await vite?.close() })
const request = { id: 'one', asker: 'Receiver', asker_avatar_url: 'https://avatars.githubusercontent.com/u/42', provider_id: 'codex', model_label: 'Codex', amount_percent: 20, note: 'Please help.', room_display_name: 'Our room' }
const response = (ask: any = request) => ({ ok: true, json: async () => ({ ask, unavailable: null }) })
const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
async function render(ask: any) {
  const calls: any[] = []
  globalThis.fetch = (async (...args: any[]) => { calls.push(args); return response(ask) }) as any
  const Ready = { ...Page, async setup(props: any, context: any) { const state = Page.setup(props, context); await settle(); return state } }
  const html = await renderToString(createSSRApp(Ready, { token: 'some-token' }))
  return { html, calls }
}
test('web shares the receiver/message design and preserves the desktop-only launch handoff', async () => {
  const { html, calls } = await render(request)
  assert.match(html, /src="https:\/\/avatars.githubusercontent.com\/u\/42"/)
  assert.match(html, /<blockquote>Please help\.<\/blockquote>/)
  assert.match(html, /Our room/)
  assert.match(html, /20% of your main usage limit/)
  assert.match(html, /href="letagents:\/\/ask\/some-token"/)
  assert.match(html, /Apple silicon/); assert.match(html, /Intel/)
  assert.doesNotMatch(html, /data-testid="agent-give-add"|class="give-amount-choices"/)
  assert.deepEqual(calls, [['/agent-asks/link/some-token', { credentials: 'same-origin' }]])
})
test('anonymous previews do not invent a receiver photo, note or room', async () => {
  await session(false)
  const { html } = await render({ id: 'one', asker: 'Receiver', provider_id: 'codex', model_label: 'Codex', amount_percent: null })
  assert.doesNotMatch(html, /avatars.githubusercontent|<blockquote|class="give-room"/)
  assert.match(html, /aria-label="Receiver"/)
  assert.match(html, /Open in LetAgents/)
})
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
function mount(t: any, component = Page, initial: any = { token: 'first' }) {
  let vm: any
  const props = reactive(initial), events: any[] = []
  const app = renderer.createApp({ setup() { vm = component.setup(props, { expose() {}, emit: (...args: any[]) => events.push(args) }); return () => h('div') } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({}); t.after(() => app.unmount())
  return { vm, props, events }
}
test('changing request tokens fences stale previews and keeps the deep link current', async t => {
  let resolve!: (v: any) => void
  const old = new Promise(r => { resolve = r })
  globalThis.fetch = (async (url: string) => url.endsWith('first') ? old : response({ ...request, id: 'second', asker: 'Second' })) as any
  const { vm, props } = mount(t)
  props.token = 'second'; await settle(); resolve(response()); await settle()
  assert.equal(vm.ask.value.asker, 'Second')
  assert.equal(vm.appLink.value, 'letagents://ask/second')
  assert.equal(vm.loading.value, false)
})
test('network failures expose retry and a successful retry clears the error', async t => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const { vm } = mount(t); await settle()
  assert.match(vm.error.value, /Couldn't reach/); assert.equal(vm.loading.value, false)
  globalThis.fetch = (async () => response()) as any
  await vm.load()
  assert.equal(vm.error.value, null); assert.equal(vm.ask.value.asker, 'Receiver')
})

test('logout immediately clears private details and fences an authenticated preview still in flight', async t => {
  let finish!: (v: any) => void
  let signedCalls = 0
  globalThis.fetch = (async (_url: string, init: any) => {
    if (init?.credentials === 'same-origin' && ++signedCalls === 2) return new Promise(resolve => { finish = resolve })
    // Even a response carrying old signed-in data must be stripped after logout.
    return response(request)
  }) as any
  const { vm } = mount(t); await settle()
  assert.equal(vm.ask.value.asker_avatar_url, request.asker_avatar_url)
  const pending = vm.load(); await settle()
  await auth.signOut(); await settle()
  assert.equal(vm.ask.value.note, undefined); assert.equal(vm.ask.value.room_display_name, undefined); assert.equal(vm.ask.value.asker_avatar_url, undefined)
  finish(response({ ...request, asker: 'Stale' })); await pending
  assert.equal(vm.ask.value.asker, 'Receiver'); assert.equal(vm.ask.value.asker_avatar_url, undefined)
})

const askModel = { providerId: 'codex', model: null, label: 'Codex' }
const createInput = { roomId: 'our-room', newRoomName: '', ...askModel, amountPercent: null, note: 'Please review the patch.' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function creationFetch(write: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    if (url === '/agent-asks/models') return json({ models: [askModel] })
    if (url === '/account/rooms?limit=200') return json({ rooms: [
      { room_id: 'our-room', display_name: 'Our room', focus_rooms: [{ room_id: 'focus-room', display_name: 'Review' }] },
      { room_id: 'archived-room', display_name: 'Archived', archived: true },
    ] })
    return write(url, init)
  }) as typeof fetch
}
const mountCreation = (t: any) => mount(t, AskDialog, { roomIdentifier: 'our-room', roomLabel: 'Our room' })

test('the mounted web ask panel keeps the current room selected across asynchronous form loading', async t => {
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  globalThis.fetch = (async (url: string) => {
    await pending
    return String(url).includes('/models') ? json({ models: [askModel] }) : json({ rooms: [{ room_id: 'our-room', display_name: 'Our room' }] })
  }) as typeof fetch
  let vm: any, panel: any
  const CapturedPanel = { ...AskPanel, setup(props: any, context: any) {
    panel = AskPanel.setup(props, context)
    return () => h('div')
  } }
  const app = renderer.createApp({ setup() {
    vm = AskDialog.setup(reactive({ roomIdentifier: 'our-room', roomLabel: 'Our room' }), { expose() {}, emit() {} })
    return () => h(CapturedPanel, { key: vm.generation.value, models: vm.models.value, rooms: vm.rooms.value, initialRoom: 'our-room', loading: vm.loading.value })
  } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({}); t.after(() => app.unmount())
  assert.equal(vm.rooms.value.length, 0)
  assert.equal(panel.roomChoice.value, 'our-room')
  finish(); await settle()
  assert.equal(vm.loading.value, false)
  assert.equal(panel.roomChoice.value, 'our-room')
  assert.equal(panel.roomOptions.value.find((room: any) => room.id === panel.roomChoice.value)?.label, 'Our room')
})

test('web asks use authenticated room/model data and submit the selected form through the existing API', async t => {
  const writes: any[] = []
  creationFetch((url, init) => { writes.push([url, init]); return json({ link: 'https://letagents.chat/ask/created' }) })
  const { vm } = mountCreation(t); await settle()
  assert.deepEqual(vm.rooms.value, [{ id: 'our-room', label: 'Our room' }, { id: 'focus-room', label: 'Our room / Review' }])
  assert.deepEqual(vm.models.value, [askModel])
  await vm.create(createInput)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], '/rooms/our-room/agent-asks')
  assert.equal(writes[0][1].credentials, 'same-origin')
  assert.deepEqual(JSON.parse(writes[0][1].body), { provider_id: 'codex', model: null, amount_percent: null, note: createInput.note })
  assert.equal(vm.createdLink.value, 'https://letagents.chat/ask/created')
})

test('web new-room asks reuse the room after a failed request and keep errors retryable', async t => {
  let creates = 0, attempts = 0
  creationFetch(url => {
    if (url === '/projects') { creates++; return json({ project: { id: 'new-room' } }) }
    if (url === '/rooms/new-room') return json({})
    if (++attempts === 1) return json({ error: 'Busy right now. Try again.' }, 503)
    return json({ link: 'https://letagents.chat/ask/retried' })
  })
  const { vm } = mountCreation(t); await settle()
  const input = { ...createInput, roomId: '__new__', newRoomName: 'Review room', amountPercent: 20 }
  await vm.create(input)
  assert.equal(vm.busy.value, false); assert.match(vm.error.value, /Busy right now/)
  await vm.create(input)
  assert.equal(creates, 1); assert.equal(attempts, 2); assert.equal(vm.error.value, null)
  assert.equal(vm.createdLink.value, 'https://letagents.chat/ask/retried')
})

test('web asks prevent duplicate submissions and closing while creating the link', async t => {
  let finish!: (result: Response) => void, attempts = 0
  creationFetch(() => { attempts++; return new Promise(resolve => { finish = resolve }) })
  const { vm, events } = mountCreation(t); await settle()
  const pending = vm.create(createInput)
  await vm.create(createInput); vm.close()
  assert.equal(attempts, 1); assert.deepEqual(events, [])
  finish(json({ link: 'https://letagents.chat/ask/created' })); await pending
  await vm.create(createInput); assert.equal(attempts, 1)
  vm.close(); assert.deepEqual(events, [['close']])
})

test('logout clears an ask form and prevents a late room creation from creating an agent request', async t => {
  let finish!: (result: Response) => void
  const writes: string[] = []
  creationFetch(url => {
    writes.push(url)
    return url === '/projects' ? new Promise(resolve => { finish = resolve }) : json({})
  })
  const { vm, events } = mountCreation(t); await settle()
  const pending = vm.create({ ...createInput, roomId: '__new__', newRoomName: 'Private room' })
  await auth.signOut()
  assert.equal(vm.createdLink.value, null); assert.deepEqual(vm.rooms.value, []); assert.deepEqual(events, [['close']])
  finish(json({ project: { id: 'late-room' } })); await pending
  assert.deepEqual(writes, ['/projects', '/auth/logout'])
  assert.equal(vm.createdLink.value, null)
})

test('web ask load failures offer retry; room changes fence old links', async t => {
  globalThis.fetch = async () => { throw new Error('offline') }
  const { vm, props } = mountCreation(t); await settle()
  assert.equal(vm.loading.value, false); assert.match(vm.error.value, /offline/)
  let finish!: (result: Response) => void
  creationFetch(() => new Promise(resolve => { finish = resolve }))
  await vm.load(); assert.equal(vm.error.value, null)
  const pending = vm.create(createInput)
  props.roomIdentifier = 'another-room'; props.roomLabel = 'Another room'; await settle()
  finish(json({ link: 'https://letagents.chat/ask/old-room' })); await pending
  assert.equal(vm.createdLink.value, null); assert.equal(vm.busy.value, false)
  assert.equal(vm.rooms.value[0].id, 'another-room')
})
