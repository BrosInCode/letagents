import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer
let LongMessage: any
let ChatMessage: any
let auth: any
const originalStorage = globalThis.localStorage
const longText = 'A longer message for the reader. '.repeat(60)
const roomIdentifier = 'github.com/BrosInCode/letagents'
const timestamp = '2026-10-17T17:36:00.000Z'

before(async () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  LongMessage = (await vite.ssrLoadModule('/src/components/room/LongMessageContent.vue')).default
  ChatMessage = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
  auth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth()
})

after(async () => {
  await vite?.close()
  Object.assign(globalThis, { localStorage: originalStorage })
})

async function renderLong(extra: Record<string, unknown> = {}, open = true) {
  let vm: any
  const OpenMessage = { ...LongMessage, setup(props: any, context: any) {
    vm = LongMessage.setup(props, context)
    if (open) vm.openReader()
    return vm
  } }
  const context: Record<string, any> = {}
  const html = await renderToString(createSSRApp({
    render: () => h(OpenMessage, {
      text: longText,
      html: `<p>${longText}</p>`,
      messageId: 'msg_1',
      roomIdentifier,
      sender: { name: 'QuartzPeak', context: 'Your agent', timestamp, agent: true },
      ...extra,
    }),
  }), context)
  return { vm, html, reader: context.teleports?.body || '' }
}

test('web long messages use the shared reader with sender and room context while retaining inline collapse', async () => {
  const { vm, html, reader } = await renderLong()
  assert.equal(vm.expanded.value, false)
  const contentClasses = html.match(/id="message-content-msg_1" class="([^"]*)"/)?.[1].split(/\s+/) || []
  assert.ok(contentClasses.includes('collapsed'))
  assert.match(html, /Show full message/)
  assert.match(html, /Open reader/)
  assert.match(reader, /QuartzPeak/)
  assert.match(reader, /Your agent/)
  assert.match(reader, /BrosInCode\/letagents/)
  assert.match(reader, /Reading text size/)
  assert.doesNotMatch(reader, /Copy text|>Done<|chars/)
  assert.equal((await renderLong({}, false)).reader, '')
})

test('task references in the web reader close it and preserve task navigation; ordinary text leaves it open', async t => {
  class Target {
    constructor(readonly taskId?: string) {}
    closest() { return this.taskId ? { dataset: { taskReferenceId: this.taskId } } : null }
  }
  const originalElement = globalThis.Element
  Object.assign(globalThis, { Element: Target })
  t.after(() => Object.assign(globalThis, { Element: originalElement }))
  const tasks: string[] = []
  const { vm, reader } = await renderLong({
    html: '<p>Read <button class="task-reference-link" data-task-reference-id="task_187">T187</button>.</p>',
    onTaskReferenceClick: (id: string) => tasks.push(id),
  })
  assert.match(reader, /data-task-reference-id="task_187"/)
  let prevented = 0
  let stopped = 0
  const event = (taskId?: string) => ({
    target: new Target(taskId), preventDefault() { prevented++ }, stopPropagation() { stopped++ },
  })
  vm.handleInlineReferenceClick(event())
  assert.equal(vm.readerOpen.value, true)
  assert.deepEqual(tasks, [])
  vm.handleInlineReferenceClick(event('task_187'))
  assert.equal(vm.readerOpen.value, false)
  assert.deepEqual(tasks, ['task_187'])
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
})

test('web chat passes real avatar and viewer-relative identity into the reader, including thread messages', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    authenticated: true,
    account: { id: 'account_1', login: 'EmmyMay' },
  })))
  await auth.checkSession()
  const originalSetup = LongMessage.setup
  let readerProps: any
  LongMessage.setup = (props: any, context: any) => {
    readerProps = { ...props }
    return originalSetup(props, context)
  }
  t.after(() => { LongMessage.setup = originalSetup })
  const cases = [
    {
      source: 'browser', sender: 'EmmyMay',
      sender_profile: { login: 'EmmyMay', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
      expected: { name: 'EmmyMay', context: 'You', agent: false, avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    },
    {
      source: 'browser', sender: 'Ada',
      sender_profile: { login: 'Ada', avatar_url: 'https://avatars.githubusercontent.com/u/2' },
      expected: { name: 'Ada', context: 'Human', agent: false, avatarUrl: 'https://avatars.githubusercontent.com/u/2' },
    },
    {
      source: 'agent', sender: 'QuartzPeak | EmmyMay\'s agent | Codex',
      agent_identity: { display_name: 'QuartzPeak', owner_label: 'EmmyMay', ide_label: 'Codex', agent_key: 'emmymay/desktop-codex-1' },
      expected: { name: 'QuartzPeak', context: 'Your agent', agent: true, provider: 'Codex', agentKey: 'emmymay/desktop-codex-1' },
    },
    {
      source: 'agent', sender: 'SunBrook | Ada\'s agent | Cursor',
      agent_identity: { display_name: 'SunBrook', owner_label: 'Ada', ide_label: 'Cursor', agent_key: 'ada/desktop-cursor-1' },
      expected: { name: 'SunBrook', context: 'Ada\'s agent', agent: true, provider: 'Cursor', agentKey: 'ada/desktop-cursor-1' },
    },
    {
      // A matching display name without an authenticated profile is not the viewer.
      source: 'browser', sender: 'EmmyMay',
      expected: { name: 'EmmyMay', context: 'Human', agent: false },
    },
  ]
  for (const { expected, ...message } of cases) {
    await renderToString(createSSRApp({ render: () => h(ChatMessage, {
      message: { id: 'msg_1', text: longText, timestamp, thread_root_id: 'msg_0', ...message },
      roomIdentifier,
      inlineReply: true,
    }) }))
    assert.equal(readerProps.roomIdentifier, roomIdentifier)
    assert.equal(readerProps.sender.timestamp, timestamp)
    for (const [key, value] of Object.entries(expected)) assert.equal(readerProps.sender[key], value, key)
  }
})
