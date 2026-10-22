import assert from 'node:assert/strict'
import { before, beforeEach, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, reactive, nextTick, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer, Page: any, auth: any
const savedFetch = globalThis.fetch
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Page = (await vite.ssrLoadModule('/src/pages/AskLink.vue')).default
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
function mount(t: any) {
  let vm: any
  const props = reactive({ token: 'first' })
  const app = renderer.createApp({ setup() { vm = Page.setup(props, { expose() {} }); return () => h('div') } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({}); t.after(() => app.unmount())
  return { vm, props }
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
