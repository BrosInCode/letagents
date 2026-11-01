import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { createInboxApi, safeExternalUrl, threadItems, type InboxItem, type InboxSnapshot } from '../src/composables/inbox/api'
import { useInbox } from '../src/composables/inbox/useInbox'
import { createKnowledgeRecord, reviseKnowledgeRecord } from '../../../shared/room-knowledge.mjs'

const record = createKnowledgeRecord('github.com/o/r', 'attention', { client_id: 'request-one', category: 'decision', title: 'Choose a release', body: 'Which branch?', recommendation: 'Use staging.' }, { id: 'agent/codex-1', label: 'Amber', kind: 'agent' })
const item: InboxItem = { key: 'request', roomId: 'github.com/o/r', roomName: 'Our project', section: 'needs-you', category: 'Decision', title: record.title, body: record.body, actor: 'Amber', timestamp: record.created_at, fingerprint: '1', record }
const update: InboxItem = { key: 'update', roomId: item.roomId, roomName: item.roomName, section: 'updates', category: 'Completed', title: 'Finished task', body: 'Done.', actor: 'Task board', timestamp: record.created_at, fingerprint: 'v1' }
const snapshot = (items: InboxItem[] = [item, update]): InboxSnapshot => ({ rooms: [{ id: item.roomId, label: item.roomName }], items, failures: [], limited: false, threads: {} })
const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish }); return { promise, resolve } }
function state(t: any, api: ReturnType<typeof createInboxApi>) {
  const scope = effectScope(), account = ref<string | null>('owner')
  const inbox = scope.run(() => useInbox(account, api))!
  t.after(() => scope.stop())
  return { inbox, account }
}
function stub(overrides: Partial<ReturnType<typeof createInboxApi>> = {}): ReturnType<typeof createInboxApi> {
  return { load: async () => snapshot(), threads: async () => ({ threads: [], has_more: false }), answer: async () => { throw new Error('Unexpected write') }, ...overrides }
}
test('web Inbox reads existing authenticated room sources, includes focus rooms and surfaces partial failures', async () => {
  const calls: string[] = []
  const api = createInboxApi(async path => {
    calls.push(path)
    if (path.startsWith('/account/rooms')) return { rooms: [{ room_id: item.roomId, display_name: item.roomName, focus_rooms: [{ room_id: 'focus/one', display_name: 'Focus' }] }] }
    if (path.includes('/focus%2Fone/attention')) throw new Error('Requests unavailable')
    if (path.endsWith('/attention')) return { records: [record], tasks: [] }
    if (path.includes('/messages/threads')) return { threads: [], has_more: false }
    if (path.endsWith('/presence')) return { presence: [{ agent_key: record.author.id, ide_label: 'Codex', runtime: 'codex', session_kind: 'worker', activity_state: 'active' }] }
    if (path.includes('/events?')) return { events: [] }
    if (path.endsWith('/reasoning-sessions')) return { sessions: [] }
    if (path.includes('/tasks?')) return { tasks: [] }
    throw new Error(`Unexpected endpoint ${path}`)
  })
  const result = await api.load()
  assert.equal(result.rooms.length, 2)
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].provider, 'Codex')
  assert.equal(result.items[0].agentKey, record.author.id)
  assert.deepEqual(result.failures, [{ roomId: 'focus/one', label: 'Focus: Requests' }])
  assert.ok(calls.includes('/rooms/github.com%2Fo%2Fr/messages/threads?filter=unread&limit=75'))
  assert.ok(calls.includes('/rooms/github.com%2Fo%2Fr/tasks?status=done&limit=200&order=recent'))
})
test('web answers use the current version and do not implicitly send a recommendation', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const api = createInboxApi(async (path, init) => { calls.push({ path, init }); return { record } })
  await assert.rejects(api.answer(item, '   '), /Write a response/)
  assert.equal(calls.length, 0)
  await api.answer(item, 'Use main instead.')
  assert.equal(calls[0].path, `/rooms/github.com%2Fo%2Fr/attention/${record.id}/respond`)
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { expected_version: record.version, response: 'Use main instead.' })
  await api.answer(item, 'Unsent draft', true)
  assert.equal(calls[1].path, `/rooms/github.com%2Fo%2Fr/attention/${record.id}/close`)
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { expected_version: record.version })
})
test('web source links reject executable schemes and credentials', () => {
  assert.equal(safeExternalUrl('javascript:alert(1)'), undefined)
  assert.equal(safeExternalUrl('https://user:password@example.com'), undefined)
  assert.equal(safeExternalUrl('https://example.com/a'), 'https://example.com/a')
})
test('signed-out and switched accounts cannot receive a stale inbox snapshot', async t => {
  const pending = deferred<InboxSnapshot>(), api = stub({ load: () => pending.promise })
  const { inbox, account } = state(t, api)
  account.value = null; await settle()
  pending.resolve(snapshot()); await settle()
  assert.equal(inbox.snapshot.value, null)
  assert.equal(inbox.loading.value, false)
  assert.equal(inbox.items.value.length, 0)
})
test('drafts distinguish pristine suggestions from intentional empty input and never submit implicitly', async t => {
  const calls: string[] = []
  const { inbox } = state(t, stub({ answer: async (_item, response) => { calls.push(response); return record } }))
  await settle()
  assert.equal(inbox.drafts[item.key], undefined)
  await inbox.answer(); assert.deepEqual(calls, [])
  inbox.drafts[item.key] = ''
  inbox.section.value = 'updates'; await settle(); inbox.section.value = 'needs-you'; await settle()
  assert.equal(inbox.drafts[item.key], '')
  inbox.drafts[item.key] = 'My own answer'
  inbox.section.value = 'updates'; await settle(); inbox.section.value = 'needs-you'; await settle()
  assert.equal(inbox.drafts[item.key], 'My own answer')
  await inbox.answer(); assert.deepEqual(calls, ['My own answer'])
})
test('new arrivals do not move the selected row and hidden new activity returns after mark read', async t => {
  let next = snapshot()
  const { inbox } = state(t, stub({ load: async () => next }))
  await settle()
  const arriving = { ...item, key: 'arriving', timestamp: '2099-01-01T00:00:00Z' }
  next = snapshot([arriving, item, update]); await inbox.refresh(); await settle()
  assert.equal(inbox.selectedKey.value, item.key)
  assert.deepEqual(inbox.items.value.map(item => item.key), [item.key, 'arriving'])
  inbox.section.value = 'updates'; await settle()
  inbox.markRead(inbox.items.value); await settle()
  assert.equal(inbox.items.value.length, 0)
  inbox.undoRead(); await settle(); assert.equal(inbox.items.value.length, 1)
  inbox.markRead(inbox.items.value); await settle()
  next = snapshot([{ ...update, fingerprint: 'v2' }]); await inbox.refresh(); await settle()
  assert.equal(inbox.items.value[0].fingerprint, 'v2')
})
test('a response completing after account switch cannot clear another account draft or refresh its data', async t => {
  const pending = deferred<KnowledgeRecordLike>(), calls: string[] = []
  type KnowledgeRecordLike = typeof record
  const { inbox, account } = state(t, stub({ load: async () => { calls.push('load'); return snapshot() }, answer: () => pending.promise }))
  await settle(); inbox.drafts[item.key] = 'First account answer'
  const answer = inbox.answer(); account.value = 'other'; await settle()
  inbox.drafts[item.key] = 'Other account draft'
  const count = calls.length
  pending.resolve(reviseKnowledgeRecord(record, { expected_version: record.version, response: 'First account answer' }, { id: 'owner', label: 'Owner', kind: 'human' }))
  await answer; await settle()
  assert.equal(inbox.drafts[item.key], 'Other account draft')
  assert.equal(calls.length, count)
  assert.equal(inbox.sending.value, false)
  assert.equal(inbox.outcome.value, '')
})
test('older replies use the last reply cursor and cannot replace a refreshed snapshot', async t => {
  const oldThread = { root: { id: 'msg_1', sender: 'A', text: 'Root', source: 'browser', timestamp: record.created_at }, summary: { latest_reply: { id: 'msg_3', sender: 'B', text: 'Reply', source: 'browser', timestamp: record.created_at }, has_unread: true, unread_count: 1 } }
  const data = snapshot(); data.threads[item.roomId] = { threads: [oldThread], has_more: true }
  const pending = deferred<any>(), cursors: string[] = []
  const { inbox } = state(t, stub({ load: async () => data, threads: async (_room, before) => { cursors.push(before); return pending.promise } }))
  await settle(); const older = inbox.loadOlder(item.roomId); await inbox.refresh(); await settle()
  pending.resolve({ threads: [{ ...oldThread, root: { ...oldThread.root, id: 'msg_0' } }], has_more: false }); await older; await settle()
  assert.deepEqual(cursors, ['msg_3'])
  assert.equal(inbox.snapshot.value?.threads[item.roomId].threads.length, 1)
  assert.equal(inbox.loadingOlder.value, false)
})

test('answer and close identify the next reading target for focus restoration', async t => {
  for (const close of [false, true]) {
    const next = { ...item, key: 'next', title: 'Another question', record: { ...record, id: 'another-question' } }
    const { inbox } = state(t, stub({ load: async () => snapshot([item, next]), answer: async () => reviseKnowledgeRecord(record, { expected_version: record.version, ...(close ? { close: true } : { response: 'Go ahead.' }) }, { id: 'owner', label: 'Owner', kind: 'human' }) }))
    await settle(); inbox.selectItem(item.key); inbox.drafts[item.key] = 'Go ahead.'
    const focusTarget = await inbox.answer(close); await settle()
    assert.equal(focusTarget, 'next')
    assert.equal(inbox.selected.value?.key, 'next')
  }
})
test('an answer does not request focus when the user moved to another item while sending', async t => {
  const pending = deferred<typeof record>()
  const next = { ...item, key: 'next', title: 'Another question', record: { ...record, id: 'another-question' } }
  const { inbox } = state(t, stub({ load: async () => snapshot([item, next]), answer: () => pending.promise }))
  await settle(); inbox.selectItem(item.key); inbox.drafts[item.key] = 'Go ahead.'
  const answer = inbox.answer(); inbox.selectItem('next'); await settle()
  pending.resolve(reviseKnowledgeRecord(record, { expected_version: record.version, response: 'Go ahead.' }, { id: 'owner', label: 'Owner', kind: 'human' }))
  assert.equal(await answer, undefined)
  await settle(); assert.equal(inbox.selected.value?.key, 'next')
})


test('Open thread targets the latest unread reply so room navigation opens the replies', () => {
  const root = { id: 'msg_10', sender: 'Amber', text: 'Original request', source: 'agent', timestamp: record.created_at }
  const latest = { ...root, id: 'msg_12', sender: 'Owner', text: 'Latest reply', source: 'browser' }
  const room = { id: item.roomId, label: item.roomName }
  const [thread] = threadItems(room, { threads: [{ root, summary: { latest_reply: latest, has_unread: true, unread_count: 1 } }], has_more: false })
  assert.equal(thread.messageId, 'msg_12')
  assert.equal(thread.title, 'Original request')
  const [fallback] = threadItems(room, { threads: [{ root, summary: { latest_reply: null, has_unread: true, unread_count: 1 } }], has_more: false })
  assert.equal(fallback.messageId, 'msg_10')
})
