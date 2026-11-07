import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import {
  ROOM_JOIN_REQUEST_EVENT,
  createJoinRequestSoundGate,
  joinRequestBannerText,
  joinRequestNotificationText,
  parseRoomJoinRequestEvent,
  type RoomJoinRequestAlert,
} from '../../../shared/room-join-requests.mjs'

const stored = new Map<string, string>()
const events = new Map<string, Set<Function>>()
class Source {
  static latest: Source
  listeners = new Map<string, Function>(); onopen: (() => void) | null = null; onerror = null
  constructor(public url: string) { Source.latest = this }
  addEventListener(name: string, fn: Function) { this.listeners.set(name, fn) }
  close() {}
  dispatch(name: string, payload: unknown, lastEventId = '') { this.listeners.get(name)!({ data: JSON.stringify(payload), lastEventId }) }
}
Object.assign(globalThis, {
  localStorage: { getItem: () => null, setItem() {} },
  sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
  EventSource: Source,
  document: { hidden: false },
  window: { addEventListener: (name: string, fn: Function) => { if (!events.has(name)) events.set(name, new Set()); events.get(name)!.add(fn) }, removeEventListener: (name: string, fn: Function) => events.get(name)?.delete(fn) },
})
const { createJoinRequestAlerts, joinRequestAlerts } = await import('../src/composables/roomJoinRequestAlerts')
const { createRoomStream } = await import('../src/composables/room/stream')

const NOW = Date.parse('2026-11-07T12:00:00Z')
function request(id: string, login: string, extra: Partial<RoomJoinRequestAlert> = {}): RoomJoinRequestAlert {
  return {
    id, room_id: 'design-lounge', account_id: `acct_${login}`, login, display_name: null, avatar_url: null,
    state: 'pending', created_at: new Date(NOW - 5 * 60_000).toISOString(), decided_at: null, retry_after: null,
    decided_by_login: null, room_display_name: 'Design lounge', ...extra,
  }
}
const event = (req: RoomJoinRequestAlert, roomId = 'design-lounge') => ({ room_id: roomId, access_room_id: 'design-lounge', request: req })

test('the shared event parser accepts the server frame and refuses anything else', () => {
  const parsed = parseRoomJoinRequestEvent(event(request('rjr_1', 'ada', { display_name: 'Ada' })))
  assert.equal(parsed?.request.login, 'ada')
  assert.equal(parsed?.request.room_display_name, 'Design lounge')
  assert.equal(parseRoomJoinRequestEvent({ room_id: 'x', access_room_id: 'x', request: { id: 'rjr_1' } }), null, 'a bare id is not a request')
  assert.equal(parseRoomJoinRequestEvent({ room_id: 'x', access_room_id: 'x', request: { ...request('r', 'a'), state: 'lost' } }), null, 'an unknown state')
  assert.equal(parseRoomJoinRequestEvent({ room_id: 'x', request: request('r', 'a') }), null, 'no access room')
  assert.equal(parseRoomJoinRequestEvent(null), null)
  assert.equal(parseRoomJoinRequestEvent({ room_id: 'x', access_room_id: 'x', request: { ...request('r', 'a'), login: 'a'.repeat(600) } }), null, 'bounded text')
})

test('the banner text and the notification text name the person, or count the people', () => {
  assert.equal(joinRequestBannerText([request('r1', 'ada', { display_name: 'Ada Lovelace' })]), 'Ada Lovelace wants to join')
  assert.equal(joinRequestBannerText([request('r1', 'ada'), request('r2', 'bob')]), 'ada and bob want to join')
  assert.equal(joinRequestBannerText([request('r1', 'ada'), request('r2', 'bob'), request('r3', 'cy')]), '3 people want to join')
  assert.deepEqual(joinRequestNotificationText(request('r1', 'ada', { display_name: ' ' })), { title: 'Join request in Design lounge', body: 'ada wants to join' })
  assert.deepEqual(joinRequestNotificationText(request('r1', 'ada', { room_display_name: '' }), 'Named room'), { title: 'Join request in Named room', body: 'ada wants to join' })
})

test('the sound plays once per new request while visible, and at most once a minute while hidden', () => {
  let now = NOW
  const gate = createJoinRequestSoundGate({ now: () => now, hiddenIntervalMs: 60_000 })
  assert.equal(gate.shouldPlay('r1', false), true)
  assert.equal(gate.shouldPlay('r1', false), false, 'the same request plays once')
  assert.equal(gate.shouldPlay('r2', true), true, 'the first hidden arrival plays')
  assert.equal(gate.shouldPlay('r3', true), false, 'a second hidden arrival within the minute is silent')
  now += 59_000
  assert.equal(gate.shouldPlay('r4', true), false)
  now += 1_000
  assert.equal(gate.shouldPlay('r5', true), true, 'the minute passed')
  assert.equal(gate.shouldPlay('r6', false), true, 'a visible arrival always plays')
  gate.remember('r7')
  assert.equal(gate.shouldPlay('r7', false), false, 'a remembered request was never news')
  gate.reset()
  assert.equal(gate.shouldPlay('r1', false), true)
})

test('the store adds a streamed request with one sound, drops answered ones, and remembers a closed banner', async () => {
  const played: string[] = []
  const decided: string[] = []
  let pending: RoomJoinRequestAlert[] = [request('rjr_old', 'olga')]
  let hidden = false
  let decideFails: unknown = null
  const alerts = createJoinRequestAlerts({
    fetchPending: async () => pending,
    decide: async (room, id, decision) => { decided.push(`${room}:${id}:${decision}`); if (decideFails) throw decideFails },
    playSound: () => played.push('chime'),
    hidden: () => hidden,
    now: () => NOW,
  })
  alerts.setRoom('design-lounge')
  await alerts.load()
  assert.deepEqual(alerts.visible.value.map(r => r.id), ['rjr_old'])
  assert.deepEqual(played, [], 'a request that was already waiting is not news')

  alerts.receive('design-lounge', event(request('rjr_new', 'nina')))
  assert.deepEqual(alerts.visible.value.map(r => r.id), ['rjr_old', 'rjr_new'])
  assert.deepEqual(played, ['chime'])
  alerts.receive('design-lounge', event(request('rjr_new', 'nina')))
  assert.deepEqual(played, ['chime'], 'a repeated frame plays nothing')
  alerts.receive('other-room', event(request('rjr_other', 'otto'), 'other-room'))
  assert.equal(alerts.visible.value.some(r => r.id === 'rjr_other'), false, 'another room\'s stream is ignored')

  hidden = true
  alerts.receive('design-lounge', event(request('rjr_h1', 'h1')))
  alerts.receive('design-lounge', event(request('rjr_h2', 'h2')))
  assert.deepEqual(played, ['chime', 'chime'], 'hidden: one sound for the burst')
  hidden = false

  alerts.receive('design-lounge', event(request('rjr_old', 'olga', { state: 'approved' })))
  assert.equal(alerts.visible.value.some(r => r.id === 'rjr_old'), false, 'an approval from another admin drops it')

  assert.equal(await alerts.decide(alerts.visible.value[0]!, 'approve'), true)
  assert.deepEqual(decided, ['design-lounge:rjr_new:approve'])
  assert.equal(alerts.visible.value.some(r => r.id === 'rjr_new'), false)

  decideFails = Object.assign(new Error('Admin privileges required'), { payload: { error: 'x' } })
  assert.equal(await alerts.decide(alerts.visible.value[0]!, 'decline'), false)
  assert.equal(alerts.error.value, 'Admin privileges required')
  assert.equal(alerts.visible.value.length, 2, 'a refused decision keeps the request')
  decideFails = Object.assign(new Error('already approved'), { payload: { code: 'ROOM_JOIN_REQUEST_NOT_PENDING' } })
  assert.equal(await alerts.decide(alerts.visible.value[0]!, 'decline'), false)
  assert.equal(alerts.visible.value.length, 1, 'a request another admin answered first is gone')

  alerts.dismiss()
  assert.deepEqual(alerts.visible.value, [], 'closing hides what is waiting')
  assert.ok(stored.get('lac-join-request-dismissed')?.includes('rjr_h2'), 'the closed banner is remembered for the tab session')
  alerts.receive('design-lounge', event(request('rjr_h3', 'h3')))
  assert.deepEqual(alerts.visible.value.map(r => r.id), ['rjr_h3'], 'a later request shows again')

  alerts.setRoom('elsewhere')
  assert.deepEqual(alerts.visible.value, [], 'changing room clears the list')
  pending = []
})

test('the room stream hands join_request frames to the store and repairs malformed ones', async () => {
  let reconciles = 0
  const stream = createRoomStream({
    setConnectionState() {}, setStreaming() {}, appendMessage: () => true, onGitHubMessage() {}, onGitHubEvent() {},
    onTaskLifecycleMessage() {}, onArtifactUpdate() {}, onAgentActivityMessage() {}, onParticipantActivityMessage() {},
    upsertTask() {}, upsertReasoningSession() {}, removeReasoningSession() {}, getMessageCursor: () => null,
    resyncMessages: async (_id, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => { reconciles += 1; return true },
  })
  joinRequestAlerts.setRoom('design-lounge')
  stream.start('design-lounge')
  try {
    Source.latest.onopen?.()
    Source.latest.dispatch(ROOM_JOIN_REQUEST_EVENT, event(request('rjr_stream', 'sia', { display_name: 'Sia' })), 'cursor_1')
    assert.deepEqual(joinRequestAlerts.visible.value.map(r => r.id), ['rjr_stream'])
    Source.latest.dispatch(ROOM_JOIN_REQUEST_EVENT, event(request('rjr_stream', 'sia', { state: 'declined' })), 'cursor_2')
    assert.deepEqual(joinRequestAlerts.visible.value, [])
    const before = reconciles
    Source.latest.dispatch(ROOM_JOIN_REQUEST_EVENT, { room_id: 'design-lounge', access_room_id: 'design-lounge', request: { id: 'x' } }, 'cursor_3')
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(reconciles > before, 'a malformed frame is repaired through the authoritative read')
  } finally {
    stream.stop()
    joinRequestAlerts.reset()
  }
})

let vite: ViteDevServer
let JoinRequestBanner: any
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  JoinRequestBanner = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/JoinRequestBanner.vue', import.meta.url)))).default
})
after(async () => { await vite?.close() })

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp({ render: () => h(JoinRequestBanner, props) }))
}

test('one request shows the name with Approve and Decline in place; several stack as faces and a count', async () => {
  const one = await render({ requests: [request('rjr_1', 'ada', { display_name: 'Ada Lovelace' })], now: NOW })
  assert.match(one, /<b>Ada Lovelace<\/b> wants to join/)
  assert.match(one, /@ada · 5 min ago/)
  assert.match(one, /aria-label="Approve Ada Lovelace"[^>]*>Approve</)
  assert.match(one, /aria-label="Decline Ada Lovelace"[^>]*>Decline</)
  assert.match(one, /aria-label="Close"/)
  assert.match(one, /role="status"/, 'a live region, not a dialog')
  assert.doesNotMatch(one, />Review</)

  const two = await render({ requests: [request('rjr_1', 'ada'), request('rjr_2', 'bob', { display_name: 'Bob' })], busy: null })
  assert.match(two, /<b>ada<\/b> and <b>Bob<\/b> want to join/)
  assert.equal((two.match(/class="chat-avatar/g) ?? []).length, 2, 'two faces')
  assert.match(two, />Review</)
  assert.doesNotMatch(two, />Approve</)

  const four = await render({ requests: ['ada', 'bob', 'cy', 'dee'].map((login, index) => request(`rjr_${index}`, login)) })
  assert.match(four, /<b>4 people<\/b> want to join/)
  assert.equal((four.match(/class="chat-avatar/g) ?? []).length, 3, 'at most three faces')

  const busy = await render({ requests: [request('rjr_1', 'ada')], busy: 'approve:rjr_1', error: 'Admin privileges required' })
  assert.match(busy, /Approving…/)
  assert.match(busy, /disabled/)
  assert.match(busy, /role="alert"[^>]*>Admin privileges required/)
})

test('the room page shows the banner to admins only, and the style honours reduced motion', async () => {
  const page = await readFile(fileURLToPath(new URL('../src/pages/Room.vue', import.meta.url)), 'utf8')
  const banner = /<JoinRequestBanner[\s\S]*?\/>/.exec(page)?.[0] ?? ''
  assert.match(banner, /v-if="joinRequestBannerAvailable"/)
  assert.match(page, /const joinRequestBannerAvailable = computed\(\(\) => isConnected\.value && room\.value\?\.role === 'admin'\)/)
  assert.match(page, /grid-template-rows: auto auto minmax\(0, 1fr\) auto auto;/, 'the slot has its own grid row; the chat keeps the flexible one')
  assert.match(page, /<div class="room-join-request-slot">/, 'the slot is always in the grid, so the strip can fold open and closed')
  assert.match(banner, /@open-requests="drawerOpen = true"/, 'Review opens the drawer with the Requests list')
  const css = await readFile(fileURLToPath(new URL('../../../shared/ui/join-request-banner.css', import.meta.url)), 'utf8')
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
  assert.match(reduced, /transition: opacity 150ms ease/, 'less motion keeps a cross-fade')
  assert.match(reduced, /transform: none/, 'and drops the slide and the press scale')
  assert.match(reduced, /animation: none/, 'and the knock ring and the drawn check')
  assert.match(css, /reveal-enter-from,\s*\.join-request-reveal-leave-to \{\s*grid-template-rows: 0fr;/, 'the row unfolds instead of jumping')
  assert.doesNotMatch(css, /transition: all/, 'only named properties move')
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/, 'hover states are gated for touch')
  assert.match(css, /\.join-request-banner-button:active:not\(:disabled\) \{\s*transform: scale\(0\.97\)/, 'a press answers at once')
  assert.match(css, /reveal-leave-active > \.join-request-banner \{\s*transition:\s*opacity 120ms/, 'the strip leaves faster than it arrives')
})
