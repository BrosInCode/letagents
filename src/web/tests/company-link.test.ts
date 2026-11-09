import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, h, reactive, nextTick, ssrContextKey } from 'vue'
import { routeLocationKey } from 'vue-router'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer, Page: any, auth: any
const originalFetch = globalThis.fetch, originalWindow = globalThis.window
const json = (body: any, ok = true) => ({ ok, json: async () => body })
const org = { github_org_id: '42', login: 'Herotel', avatar_url: null, role: 'member', setup: true, joined: false }
const listed = () => json({ organizations: [org], invitations: [], sso_required: [] })
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Page = (await vite.ssrLoadModule('/src/pages/CompanyLink.vue')).default
  auth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth()
})
beforeEach(async () => {
  globalThis.fetch = (async () => json({ authenticated: true, account: { id: 'viewer', login: 'viewer', avatar_url: 'https://avatars.githubusercontent.com/u/1' } })) as any
  await auth.checkSession()
  globalThis.window = { addEventListener() {}, removeEventListener() {} } as any
})
after(async () => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; await vite?.close() })
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
function mount(t: any) {
  let vm: any
  const route = reactive({ params: { organizationId: '42' } })
  const app = renderer.createApp({ setup() { vm = Page.setup({}, { expose() {} }); return () => h('div') } })
  app.provide(routeLocationKey, route as any); app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
  t.after(() => app.unmount())
  return { vm, route }
}
test('late join completion cannot change a different company link', async t => {
  let finish!: (value: any) => void
  globalThis.fetch = (async (_url: string, init: any) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : listed()) as any
  const { vm, route } = mount(t); await settle()
  const pending = vm.join(false)
  route.params.organizationId = '43'; await settle()
  finish(json({})); await pending
  assert.equal(vm.justJoined.value, false)
  assert.equal(vm.busy.value, false)
  assert.equal(vm.appLink.value, 'letagents://company/43')
})
test('logout immediately removes company identity and ignores a pending join failure', async t => {
  let finish!: (value: any) => void
  globalThis.fetch = (async (url: string, init: any) => String(url).includes('/join') && init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : listed()) as any
  const { vm } = mount(t); await settle()
  const pending = vm.join(false)
  await auth.signOut(); await settle()
  assert.equal(vm.view.value.kind, 'signed_out')
  assert.equal(vm.organizations.value.length, 0)
  finish(json({ error: 'organization_membership_required' }, false)); await pending
  assert.equal(vm.error.value, null)
  assert.equal(vm.view.value.kind, 'signed_out')
})
for (const [code, kind] of [['github_scope_required', 'github_access_required'], ['github_signin_required', 'github_access_required'], ['organization_sso_required', 'sso'], ['organization_membership_required', 'not_member'], ['organization_owner_required', 'waiting'], ['organization_setup_required', 'waiting']]) {
  test(`join preserves the backend ${code} state`, async t => {
    globalThis.fetch = (async (_url: string, init: any) => init?.method === 'POST' ? json({ error: code }, false) : listed()) as any
    const { vm } = mount(t); await settle(); await vm.join(false)
    assert.equal(vm.view.value.kind, kind)
    assert.equal(vm.busy.value, false)
  })
}
test('successful join remains successful when room discovery fails', async t => {
  let joined = false
  globalThis.fetch = (async (url: string, init: any) => {
    if (init?.method === 'POST') { joined = true; return json({}) }
    if (String(url).endsWith('/rooms')) return json({ error: 'organization_verification_unavailable' }, false)
    return json({ organizations: [{ ...org, joined }], invitations: [], sso_required: [] })
  }) as any
  const { vm } = mount(t); await settle(); await vm.join(false)
  assert.equal(vm.view.value.kind, 'joined')
  assert.equal(vm.roomCount.value, null)
  assert.equal(vm.busy.value, false)
})
for (const [code, kind] of [['organization_sso_required', 'sso'], ['organization_membership_required', 'not_member']]) {
  test(`an older refresh cannot overwrite a newer ${code} refusal`, async t => {
    globalThis.fetch = (async () => listed()) as any
    const { vm } = mount(t); await settle()
    let finish!: (value: any) => void
    globalThis.fetch = (async (_url: string, init: any) => init?.method === 'POST'
      ? json({ error: code }, false) : new Promise(resolve => { finish = resolve })) as any
    const refresh = vm.load()
    await vm.join(false)
    assert.equal(vm.view.value.kind, kind)
    finish(listed()); await refresh
    assert.equal(vm.view.value.kind, kind)
  })
}
