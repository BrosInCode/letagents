import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, createRenderer, h, nextTick, reactive, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'
import { createPersonWorkServices, personWorkTask, personWorkTarget } from '../src/components/room/personWork'
import type { RoomTask } from '../src/composables/room/types'

const room = 'github.com/acme/app'
const profile = { login: 'mira', avatar_url: 'https://avatars.githubusercontent.com/u/123' }

test('web person work uses authenticated room reads, preserves event scope, and maps verified ticket links', async () => {
  const requests: string[] = [], opened: string[] = []
  const services = createPersonWorkServices(async path => {
    requests.push(path)
    if (path.includes('/events?')) return {
      room_id: 'focus/one', github_room_id: room, has_more: true,
      events: [{ id: 'evt_1', event_type: 'pull_request', action: 'opened', github_object_id: '1',
        github_object_url: 'https://github.com/acme/app/pull/1', title: 'A task', state: 'open', actor_login: 'mira',
        metadata: { author_login: 'mira' }, linked_task_id: 'task_1', created_at: '2026-11-01T00:00:00Z' }],
    }
    return { ticket: { external_ref: 'jira:APP-1', url: 'https://acme.atlassian.net/browse/APP-1' } }
  }, url => { opened.push(url) })
  const result = await services.getEvents('focus/one', { limit: 100, eventType: 'pull_request', since: '2026-10-01T00:00:00Z', after: 'evt_2' })
  const url = new URL(requests[0], 'https://letagents.chat')
  assert.equal(url.pathname, '/rooms/focus%2Fone/events')
  assert.deepEqual(Object.fromEntries(url.searchParams), { limit: '100', event_type: 'pull_request', since: '2026-10-01T00:00:00Z', after: 'evt_2' })
  assert.equal(result.roomIdentifier, 'focus/one')
  assert.equal(result.githubRoomIdentifier, room)
  assert.equal(result.hasMore, true)
  assert.equal(result.events[0].linkedTaskId, 'task_1')
  assert.equal(result.events[0].githubObjectUrl, 'https://github.com/acme/app/pull/1')
  const ticket = await services.getTicket('focus/one', 'task_1')
  assert.deepEqual(ticket, { externalRef: 'jira:APP-1', url: 'https://acme.atlassian.net/browse/APP-1' })
  assert.equal(requests[1], '/rooms/focus%2Fone/tasks/task_1/ticket')
  await services.openExternalUrl(ticket!.url!)
  assert.deepEqual(opened, [ticket!.url])
  await assert.rejects(services.openExternalUrl('javascript:alert(1)'))
  assert.equal(opened.length, 1)
})

test('web ticket failures remain errors and unsafe ticket URLs fall back to the board', async () => {
  const services = createPersonWorkServices(async () => ({ ticket: { external_ref: 'jira:APP-1', url: 'javascript:alert(1)' } }))
  assert.deepEqual(await services.getTicket(room, 'task_1'), { externalRef: 'jira:APP-1', url: null })
  const failed = createPersonWorkServices(async () => { throw new Error('Not authorized') })
  await assert.rejects(failed.getEvents(room, { limit: 100, eventType: 'pull_request', since: '', after: null }), /Not authorized/)
  await assert.rejects(failed.getTicket(room, 'task_1'), /Not authorized/)
})

test('web board mapping retains exact accepted PR and tracker identities', () => {
  const task = personWorkTask({ id: 'task_1', title: 'A task', pr_url: 'https://github.com/acme/app/pull/1',
    external_ref: 'jira:APP-1', ticket_state: 'in_progress', workflow_artifacts: [{ provider: 'github', kind: 'pull_request', url: 'https://github.com/acme/app/pull/2' }],
  } as RoomTask)
  assert.equal(task.externalRef, 'jira:APP-1')
  assert.equal(task.ticketState, 'in_progress')
  assert.equal(task.prUrl, 'https://github.com/acme/app/pull/1')
  assert.equal(task.workflowArtifacts[0].url, 'https://github.com/acme/app/pull/2')
})

test('person work never derives account identity from sender labels or an agent owner label', () => {
  assert.deepEqual(personWorkTarget({ source: 'browser', sender: 'Mira Patel', sender_profile: profile }), { login: 'mira', displayName: 'Mira Patel', avatarUrl: profile.avatar_url })
  assert.equal(personWorkTarget({ source: 'browser', sender: 'mira' }), null)
  assert.equal(personWorkTarget({ source: 'agent', sender: "Mira’s agent", sender_profile: profile }), null)
})

let vite: ViteDevServer, ChatMessage: any, Host: any, context: any
const storage = globalThis.localStorage
before(async () => {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  ChatMessage = (await vite.ssrLoadModule('/src/components/room/ChatMessage.vue')).default
  Host = (await vite.ssrLoadModule('/src/components/room/PersonWorkHost.vue')).default
  context = await vite.ssrLoadModule('/src/components/room/personWork.ts')
})
after(async () => { await vite?.close(); Object.assign(globalThis, { localStorage: storage }) })

for (const inlineReply of [false, true]) test(`authenticated ${inlineReply ? 'thread' : 'room'} sender opens work with the real avatar; missing profile remains plain text`, async () => {
  const opened: unknown[] = []
  let vm: any
  const message = { id: 'msg_1', source: 'browser', sender: 'Mira Patel', sender_profile: profile, text: 'Hello', timestamp: '2026-11-01T00:00:00Z' }
  const Component = { ...ChatMessage, setup(props: any, ctx: any) { vm = ChatMessage.setup(props, ctx); return vm } }
  const render = (senderProfile?: typeof profile, available = true) => renderToString(createSSRApp({
    setup() { context.providePersonWork((...args: unknown[]) => opened.push(args), () => available); return () => h(Component, { message: { ...message, sender_profile: senderProfile }, roomIdentifier: room, inlineReply }) },
  }))
  assert.match(await render(profile), /<button[^>]*aria-label="View Mira Patel’s work"/)
  vm.openWork({ detail: 0 })
  assert.deepEqual(opened, [[{ login: 'mira', displayName: 'Mira Patel', avatarUrl: profile.avatar_url }, { detail: 0 }]])
  assert.doesNotMatch(await render(), /aria-label="View Mira Patel’s work"/)
  vm.openWork({ detail: 1 })
  assert.equal(opened.length, 1)
  assert.doesNotMatch(await render(profile, false), /aria-label="View Mira Patel’s work"/)
  vm.openWork({ detail: 1 }); assert.equal(opened.length, 1)
})

test('web work host closes immediately across room/account changes and forwards exact board task navigation', async t => {
  const document = globalThis.document
  Object.assign(globalThis, { document: { addEventListener() {}, removeEventListener() {} } })
  const props = reactive({ roomIdentifier: room, viewerLogin: 'owen', sessionId: 'account_1' as string | null, theme: 'dark', tasks: [] })
  const events: unknown[] = []
  let vm: any
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup() { vm = Host.setup(props, { expose() {}, emit: (...args: unknown[]) => events.push(args) }); return () => h('div') } })
  app.provide(ssrContextKey, { modules: new Set() }); app.mount({})
  t.after(() => { app.unmount(); Object.assign(globalThis, { document }) })
  const target = { login: 'mira', displayName: 'Mira Patel', avatarUrl: profile.avatar_url }
  vm.open(target, { detail: 1 }); assert.equal(vm.target.value.login, 'mira'); assert.equal(vm.animatePanel.value, true)
  props.roomIdentifier = 'focus/two'; await nextTick(); assert.equal(vm.target.value, null); assert.equal(vm.animatePanel.value, false)
  vm.open(target, { detail: 0 }); assert.equal(vm.animatePanel.value, false)
  props.sessionId = 'account_2'; await nextTick(); assert.equal(vm.target.value, null)
  vm.open(target, { detail: 1 }); vm.openTask('task_47')
  assert.equal(vm.target.value, null); assert.deepEqual(events, [['open-task', 'task_47']])
  props.sessionId = null; vm.open(target, { detail: 1 }); assert.equal(vm.target.value, null)
})
