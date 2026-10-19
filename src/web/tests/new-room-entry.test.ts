import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, ssrContextKey } from 'vue'
import { routerKey } from 'vue-router'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let Entry: any
let Frame: any
let useAuth: any
const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
const assignments: string[] = []
const navigations: string[] = []
const router = { push: async (path: string) => { navigations.push(path) } }

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { assign: (path: string) => assignments.push(path) }, addEventListener() {},
  } })
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Entry = (await vite.ssrLoadModule('/src/components/landing/RoomEntrySection.vue')).default
  Frame = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/NewRoomFrame.vue', import.meta.url)))).default
  useAuth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth
})
after(async () => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  await vite?.close()
})

const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })

test('shared room tabs wrap focus with arrow keys and retain normal Tab navigation', async () => {
  const tabs = [{ id: 'project', label: 'Project' }, { id: 'blank', label: 'Blank room' }, { id: 'join', label: 'Join room' }]
  const props = { tab: 'project', tabs, busy: false }
  const selected: string[] = [], focused: string[] = []
  let vm: any
  const app = renderer.createApp({ setup() {
    vm = Frame.setup(props, { expose() {}, emit: (_event: string, id: string) => selected.push(id) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  const press = (key: string, id = 'project') => {
    let prevented = false
    vm.handleTabKey({ key, preventDefault() { prevented = true }, currentTarget: { parentElement: { querySelectorAll: () => tabs.map(tab => ({ focus: () => focused.push(tab.id) })) } } }, id)
    return prevented
  }
  try {
    assert.equal(press('ArrowLeft'), true)
    assert.equal(selected.at(-1), 'join'); assert.equal(focused.at(-1), 'join')
    press('ArrowRight', 'join'); assert.equal(selected.at(-1), 'project')
    press('End'); assert.equal(selected.at(-1), 'join')
    press('Home', 'join'); assert.equal(selected.at(-1), 'project')
    const count = selected.length
    assert.equal(press('Tab'), false)
    props.busy = true
    assert.equal(press('ArrowRight'), false)
    assert.equal(selected.length, count, 'busy forms cannot change their destination')
    const html = await renderToString(createSSRApp({ render: () => h(Frame, { tabs, tab: 'blank' }) }))
    assert.equal((html.match(/tabindex="0"/g) || []).length, 1)
    assert.match(html, /id="new-room-panel"[^>]*role="tabpanel"[^>]*aria-labelledby="new-room-panel-tab-blank"/)
  } finally { app.unmount() }
})

function mount() {
  let vm: any
  const app = renderer.createApp({ setup() { vm = Entry.setup({}, { expose() {} }); return () => h('div') } })
  app.provide(routerKey, router as any)
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  return { vm, unmount: () => app.unmount() }
}
async function authenticate(signedIn: boolean) {
  globalThis.fetch = async () => new Response(JSON.stringify({ authenticated: signedIn, ...(signedIn ? { account: { id: 'account_qa', login: 'qa', display_name: 'QA', provider: 'github' } } : {}) }))
  await useAuth().checkSession()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('web entry uses the shared tabbed frame and explains browser project support inside the panel', async () => {
  const app = createSSRApp({ render: () => h(Entry) })
  app.provide(routerKey, router as any)
  const html = await renderToString(app)
  assert.match(html, /New room/)
  assert.match(html, /role="tablist"/)
  for (const label of ['Project', 'Blank room', 'Join room']) assert.ok(html.includes(label))
  assert.match(html, /GitHub repository/)
  assert.match(html, /Use the desktop app to create a project or open a folder/)
  assert.match(html, /class="new-room-footer"[^>]*>(?:<!--.*?-->)*<button[^>]*class="new-room-primary"[^>]*disabled/)
  assert.ok(html.indexOf('Starting with a folder?') < html.indexOf('class="new-room-footer"'))
  assert.doesNotMatch(html, /Create New Room|class="create-btn"|class="join-row"/)
})

test('tab switching preserves independent inputs and clears only the visible error', () => {
  const { vm, unmount } = mount()
  try {
    vm.repository.value = 'github.com/team/project'
    vm.error.value = 'Invalid repository'
    vm.selectTab('join')
    assert.equal(vm.error.value, '')
    vm.invitation.value = 'ABCD-1234'
    vm.selectTab('blank')
    vm.roomName.value = 'Planning'
    vm.selectTab('project')
    assert.equal(vm.repository.value, 'github.com/team/project')
    assert.equal(vm.invitation.value, 'ABCD-1234')
    assert.equal(vm.roomName.value, 'Planning')
    vm.busy.value = true
    vm.selectTab('join')
    assert.equal(vm.tab.value, 'project', 'a pending request cannot switch its destination')
  } finally { unmount() }
})

test('project entry validates repository input then uses the server authorization path', async () => {
  const { vm, unmount } = mount()
  const count = assignments.length
  try {
    vm.repository.value = '/Users/me/work'
    await vm.handleSubmit()
    assert.match(vm.error.value, /GitHub repository/)
    assert.equal(vm.busy.value, false)
    assert.equal(assignments.length, count)
    vm.repository.value = 'https://github.com/Team/Project.git/'
    await vm.handleSubmit()
    assert.equal(assignments.at(-1), '/in/github.com%2Fteam%2Fproject')
    assert.equal(vm.busy.value, true)
    await vm.handleSubmit()
    assert.equal(assignments.length, count + 1, 'repeat submission cannot navigate twice')
  } finally { unmount() }
})

test('join accepts pasted room links and rejects unrelated external URLs', async () => {
  const { vm, unmount } = mount()
  const count = assignments.length
  try {
    vm.selectTab('join')
    vm.invitation.value = 'https://example.com/in/ABCD-1234'
    await vm.handleSubmit()
    assert.match(vm.error.value, /LetAgents room URL/)
    assert.equal(assignments.length, count)
    vm.invitation.value = 'https://letagents.chat/in/abcd-1234'
    await vm.handleSubmit()
    assert.equal(assignments.at(-1), '/in/ABCD-1234')
  } finally { unmount() }
})

test('anonymous blank creation keeps the supported unnamed shared room behavior', async () => {
  await authenticate(false)
  const requests: string[] = []
  globalThis.fetch = async input => { requests.push(String(input)); return new Response(JSON.stringify({ id: 'ROOM-1234' })) }
  const { vm, unmount } = mount()
  try {
    vm.selectTab('blank')
    vm.roomName.value = 'Cannot rename anonymously'
    await vm.handleSubmit()
    assert.deepEqual(requests, ['/projects'])
    assert.equal(navigations.at(-1), '/in/ROOM-1234')
    assert.equal(vm.busy.value, false)
  } finally { unmount() }
})

test('invalid optional names are rejected before any room is created', async () => {
  await authenticate(true)
  let requestCount = 0
  globalThis.fetch = async () => { requestCount++; return new Response(JSON.stringify({ id: 'BADN-1234' })) }
  const { vm, unmount } = mount()
  const count = navigations.length
  try {
    vm.selectTab('blank')
    for (const name of ['x', '  x  ', 'x'.repeat(65)]) {
      vm.roomName.value = name
      await vm.handleSubmit()
      assert.match(vm.roomNameError.value, /between 2 and 64/)
      assert.equal(vm.roomName.value, name, 'validation preserves the input for correction')
      assert.equal(vm.createdRoomId.value, '')
      assert.equal(vm.busy.value, false)
    }
    assert.equal(requestCount, 0)
    assert.equal(navigations.length, count)
  } finally { unmount() }
})

test('named creation retries a failed rename without creating another room', async () => {
  await authenticate(true)
  const requests: { input: string; init?: RequestInit }[] = []
  let failRename = true
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init })
    return String(input) === '/projects'
      ? new Response(JSON.stringify({ id: 'NAME-1234' }))
      : new Response('{}', { status: failRename ? 500 : 200 })
  }
  const { vm, unmount } = mount()
  try {
    vm.selectTab('blank')
    vm.roomName.value = '  Product  \t planning  '
    await vm.handleSubmit()
    assert.match(vm.error.value, /name could not be saved/)
    assert.equal(vm.createdRoomId.value, 'NAME-1234')
    assert.equal(vm.busy.value, false)
    failRename = false
    await vm.handleSubmit()
    assert.deepEqual(requests.map(request => request.input), ['/projects', '/rooms/NAME-1234', '/rooms/NAME-1234'])
    assert.equal(requests[1].init?.credentials, 'include')
    assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { display_name: 'Product planning' })
    assert.equal(navigations.at(-1), '/in/NAME-1234')
    assert.equal(vm.error.value, '')
  } finally { unmount() }
})

test('failed creation retains the input and releases the form for retry', async () => {
  await authenticate(true)
  globalThis.fetch = async () => new Response('{}', { status: 503 })
  const { vm, unmount } = mount()
  try {
    vm.selectTab('blank')
    vm.roomName.value = 'Planning'
    await vm.handleSubmit()
    assert.match(vm.error.value, /could not be created/)
    assert.equal(vm.roomName.value, 'Planning')
    assert.equal(vm.createdRoomId.value, '')
    assert.equal(vm.canSubmit.value, true)
  } finally { unmount() }
})

test('late creation completion cannot rename or navigate after leaving the entry', async () => {
  await authenticate(true)
  const pending = deferred<Response>()
  let requestCount = 0
  globalThis.fetch = async () => { requestCount++; return pending.promise }
  const { vm, unmount } = mount()
  vm.selectTab('blank')
  vm.roomName.value = 'Planning'
  const count = navigations.length
  const request = vm.handleSubmit()
  assert.equal(vm.busy.value, true)
  await vm.handleSubmit()
  assert.equal(requestCount, 1)
  unmount()
  pending.resolve(new Response(JSON.stringify({ id: 'LATE-1234' })))
  await request
  assert.equal(requestCount, 1)
  assert.equal(navigations.length, count)
})
