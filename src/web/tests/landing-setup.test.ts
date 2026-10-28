import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createRenderer, createSSRApp, h, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let Setup: any
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  Setup = (await vite.ssrLoadModule('/src/components/landing/SetupSection.vue')).default
})
after(async () => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
  await vite?.close()
})

function clipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...(writeText ? { clipboard: { writeText } } : {}) } })
}
const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
function mount() {
  let vm: any
  const app = renderer.createApp({ setup() { vm = Setup.setup({}, { expose() {} }); return () => h('div') } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  return { vm, unmount: () => app.unmount() }
}

test('each setup action copies the correct client configuration and reports its destination', async () => {
  const copied: string[] = []
  clipboard(async text => { copied.push(text) })
  const { vm, unmount } = mount()
  try {
    assert.deepEqual(vm.agents.map((agent: any) => agent.name), ['Claude Code', 'Codex', 'Cursor', 'Antigravity'])
    for (let index = 0; index < vm.agents.length; index++) {
      await vm.copyForAgent(index)
      assert.equal(copied.at(-1), vm.selectedPrompt.value)
      assert.equal(vm.copiedIdx.value, index)
      assert.equal(vm.feedback.value, `${vm.agents[index].name} setup prompt copied.`)
      assert.match(copied.at(-1)!, /https:\/\/letagents.chat/)
      assert.match(copied.at(-1)!, /Preserve all existing settings and other MCP servers; do not overwrite the whole file/)
      assert.match(copied.at(-1)!, /If this client supports an MCP working-directory setting, set cwd to this repository's absolute path/)
      assert.match(copied.at(-1)!, /check get_current_room.*use join_room.*Git remote and active branch/)
    }
    assert.match(copied[0], /top-level mcpServers object in ~\/\.claude\.json \(user scope\)/)
    assert.doesNotMatch(copied[0], /restart the MCP server/)
    assert.doesNotMatch(copied.join('\n'), /~\/\.(?:claude|gemini)\/settings\.json/)
    assert.match(copied[1], /\[mcp_servers\.letagents\]/)
    assert.match(copied[1], /~\/\.codex\/config.toml with that TOML block/)
    assert.doesNotMatch(copied[1], /mcpServers/)
    assert.match(copied[2], /~\/\.cursor\/mcp.json/)
    assert.match(copied[3], /~\/\.gemini\/config\/mcp_config\.json/)
  } finally { unmount() }
})

test('unavailable or denied clipboard exposes the selected prompt for manual copy', async () => {
  for (const write of [undefined, async () => { throw new Error('Clipboard denied') }]) {
    clipboard(write)
    const { vm, unmount } = mount()
    try {
      await vm.copyForAgent(1)
      assert.equal(vm.copiedIdx.value, null)
      assert.equal(vm.manualOpen.value, true)
      assert.match(vm.feedback.value, /Select and copy/)
      assert.match(vm.selectedPrompt.value, /\[mcp_servers\.letagents\]/)
      let selected = false
      vm.selectPrompt({ target: { select() { selected = true } } })
      assert.equal(selected, true)
    } finally { unmount() }
  }
})

test('late clipboard results cannot overwrite a newer selection or update an unmounted page', async () => {
  const completions: (() => void)[] = []
  clipboard(() => new Promise(resolve => completions.push(resolve)))
  const { vm, unmount } = mount()
  try {
    const first = vm.copyForAgent(0)
    const second = vm.copyForAgent(1)
    completions[1]()
    await second
    completions[0]()
    await first
    assert.equal(vm.copiedIdx.value, 1)
    assert.equal(vm.feedback.value, 'Codex setup prompt copied.')
    const last = vm.copyForAgent(2)
    unmount()
    completions[2]()
    await last
    assert.equal(vm.copiedIdx.value, null)
    assert.equal(vm.feedback.value, '')
  } finally { unmount() }
})

test('setup exposes selectable instructions, a status announcement, and manual documentation', async () => {
  const app = createSSRApp({ render: () => h(Setup) })
  app.component('RouterLink', { props: ['to'], setup(props: { to: string }, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) } })
  const html = await renderToString(app)
  assert.match(html, /role="status"/)
  assert.match(html, /<summary[^>]*>View setup prompt<\/summary>/)
  assert.match(html, /<textarea[^>]*id="agent-setup-prompt"[^>]*readonly/)
  assert.match(html, /href="\/docs"/)
  assert.doesNotMatch(html, /<img/)
})
