import assert from 'node:assert/strict'
import { after, before, test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { computed, createRenderer, createSSRApp, effectScope, h, ref, ssrContextKey } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { createServer, type ViteDevServer } from 'vite'

import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
  repoCollaboratorRequiredBody,
  roomMembershipRequiredBody,
  type RoomJoinRequestSummary,
} from '../../../shared/room-membership.mjs'
import { formatJoinRequestTime, resolveJoinRequestView } from '../src/composables/room/joinRequestView'
import { createRoomLifecycle } from '../src/composables/room/lifecycle'
import { apiFetch, roomPath } from '../src/composables/room/api'
import {
  fetchRoomMembers,
  isFocusRoomId,
  REPO_ACCESS_UNAVAILABLE,
  ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY,
} from '../src/composables/room/membership'
import { connectionState, isConnected, joinError, room } from '../src/composables/room/state'
import { useRoomJoinRequest } from '../src/composables/room/useRoomJoinRequest'
import { useRoomMembers } from '../src/components/room/room-drawer/useRoomMembers'
import type { RoomInfo } from '../src/composables/room/types'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const hours = (count: number) => count * 60 * 60 * 1000
const iso = (epochMs: number) => new Date(epochMs).toISOString()
const request = (state: RoomJoinRequestSummary['state'], extra: Partial<RoomJoinRequestSummary> = {}): RoomJoinRequestSummary => ({
  id: 'jr_1',
  state,
  created_at: iso(NOW - hours(1)),
  decided_at: state === 'pending' ? null : iso(NOW - hours(0.5)),
  retry_after: null,
  ...extra,
})
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

type Route = Response | object | ((init?: RequestInit) => Response | object)
/** Answers fetch from a table keyed by "METHOD path"; an unknown call fails the test. */
function mockApi(t: TestContext, routes: Record<string, Route>) {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    calls.push(key)
    const route = routes[key]
    if (route === undefined) throw new Error(`Unexpected request: ${key}`)
    const answer = typeof route === 'function' ? route(init) : route
    return answer instanceof Response ? answer : json(answer)
  })
  return calls
}

const member = (account_id: string, login: string, role: 'admin' | 'member') => ({
  account_id,
  login,
  display_name: null,
  avatar_url: null,
  role,
  added_via: 'seed',
  joined_at: iso(NOW - hours(48)),
})
const adminList = {
  room_id: 'ROOM-1234',
  access_room_id: 'ROOM-1234',
  managed_by: 'letagents',
  can_manage: true,
  members: [member('acct_ada', 'ada', 'admin'), member('acct_bob', 'bob', 'member')],
}
const pendingRequests = {
  room_id: 'ROOM-1234',
  access_room_id: 'ROOM-1234',
  join_requests: [{
    ...request('pending'),
    id: 'jr_cy',
    room_id: 'ROOM-1234',
    account_id: 'acct_cy',
    login: 'cy',
    display_name: 'Cy',
    avatar_url: null,
    decided_by_login: null,
  }],
}
const roomInfo = (identifier = 'ROOM-1234') => ({ identifier, displayName: 'Planning' } as RoomInfo)

let vite: ViteDevServer
let AccessRequest: any
let MembersPanel: any
let viteAuth: any
let presentation: any
let retry: any

before(async () => {
  ;(globalThis as any).localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener() {}, removeEventListener() {}, location: { origin: 'https://letagents.chat' } },
  })
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  AccessRequest = (await vite.ssrLoadModule('/src/pages/room/RoomAccessRequest.vue')).default
  MembersPanel = (await vite.ssrLoadModule('/src/components/room/room-drawer/RoomMembersPanel.vue')).default
  viteAuth = (await vite.ssrLoadModule('/src/composables/useAuth.ts')).useAuth()
  presentation = await vite.ssrLoadModule('/src/pages/room/useRoomPresentation.ts')
  retry = await vite.ssrLoadModule('/src/pages/room/useRepoAccessRetry.ts')
})

after(async () => {
  Reflect.deleteProperty(globalThis, 'window')
  await vite?.close()
})

test('the ask-to-join screen picks one state from the latest request', () => {
  assert.deepEqual(resolveJoinRequestView(null, NOW), { kind: 'ask', previouslyDeclined: false })
  assert.deepEqual(resolveJoinRequestView(request('pending'), NOW), {
    kind: 'pending', requestId: 'jr_1', askedAt: iso(NOW - hours(1)),
  })
  assert.deepEqual(resolveJoinRequestView(request('declined', { retry_after: iso(NOW + hours(2)) }), NOW), {
    kind: 'declined', retryAt: NOW + hours(2),
  })
  assert.deepEqual(resolveJoinRequestView(request('declined', { retry_after: iso(NOW - 1) }), NOW), {
    kind: 'ask', previouslyDeclined: true,
  }, 'the wait is over')
  assert.deepEqual(resolveJoinRequestView(request('declined', { decided_at: iso(NOW - hours(1)) }), NOW), {
    kind: 'declined', retryAt: NOW - hours(1) + ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS,
  }, 'with no retry_after the shared cooldown starts at the decision')
  assert.equal(resolveJoinRequestView(request('cancelled'), NOW).kind, 'ask')
  assert.equal(resolveJoinRequestView(request('approved'), NOW).kind, 'ask', 'approved, then left or removed')
  assert.match(formatJoinRequestTime(NOW + hours(1), NOW), /^at /)
  assert.match(formatJoinRequestTime(NOW + hours(30), NOW), /^on /)
})

test('a 403 refusal on join becomes an access refusal with the latest request, not a connection error', async (t) => {
  const pending = request('pending')
  const bodies = {
    'ROOM-1234': json(roomMembershipRequiredBody({ room_id: 'ROOM-1234', display_name: 'Planning', join_request: pending }), 403),
    'github.com/acme/app': json(repoCollaboratorRequiredBody({ room_id: 'github.com/acme/app' }), 403),
  }
  mockApi(t, {
    'POST /rooms/ROOM-1234/join': () => bodies['ROOM-1234'],
    'POST /rooms/github.com%2Facme%2Fapp/join': () => bodies['github.com/acme/app'],
  })
  t.mock.method(console, 'error', () => undefined)
  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop() {},
    startPresenceRefreshLoop() {},
    async startStreaming() { throw new Error('a refused room never streams') },
    finishStreamingBootstrap() {},
    stopStreaming() {},
  })

  assert.equal(await lifecycle.joinRoom('ROOM-1234'), false)
  assert.equal(joinError.value?.status, 403)
  assert.equal(joinError.value?.refusal, 'membership_required')
  assert.equal(joinError.value?.displayName, 'Planning')
  assert.deepEqual(joinError.value?.joinRequest, pending)

  const view = presentation.useRoomPresentation({
    room: ref(null), tasks: ref([]), joinError, connectionState: ref('error'), authUser: ref({ login: 'cy' }),
  })
  assert.equal(view.accessRefusal.value, 'membership_required')
  assert.equal(view.roomTitle.value, 'Planning')
  assert.equal(view.roomSubtitle.value, 'Room: ROOM-1234')
  assert.equal(view.joinErrorBody.value, ROOM_MEMBERSHIP_REQUIRED_MESSAGE)
  assert.equal(view.showGitHubSignIn.value, false)

  assert.equal(await lifecycle.joinRoom('github.com/acme/app'), false)
  assert.equal(joinError.value?.refusal, 'repo_collaborator_required')
  assert.equal(joinError.value?.joinRequest, null)
  assert.equal(view.accessRefusal.value, 'repo_collaborator_required')
  assert.equal(view.roomTitle.value, 'github.com/acme/app')
  assert.equal(view.joinErrorBody.value, REPO_COLLABORATOR_REQUIRED_MESSAGE)
  lifecycle.leaveRoom()
  lifecycle.dispose()
})

test('asking to join moves to "Waiting for an admin", and Cancel moves back to "Ask to join"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW })
  const calls = mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests': json({ join_request: request('pending') }, 201),
    'POST /rooms/ROOM-1234/join-requests/jr_1/cancel': { join_request: request('cancelled') },
  })
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({ room: () => 'ROOM-1234', onMember: () => assert.fail('not a member') }))!
  try {
    assert.equal(access.view.value.kind, 'ask')
    await access.ask()
    assert.equal(access.view.value.kind, 'pending')
    t.mock.timers.tick(hours(25))
    await tick()
    assert.equal(calls.length, 1, 'a pending request is never polled')
    await access.cancel()
    assert.equal(access.view.value.kind, 'ask')
    assert.equal(access.error.value, '')
    assert.deepEqual(calls, ['POST /rooms/ROOM-1234/join-requests', 'POST /rooms/ROOM-1234/join-requests/jr_1/cancel'])
  } finally { scope.stop() }
})

test('the Declined screen turns back into "Ask to join" when retry_after passes, with no request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  const calls = mockApi(t, {})
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({
    room: () => 'ROOM-1234', initialRequest: request('declined', { retry_after: iso(NOW + hours(1)) }), onMember() {},
  }))!
  try {
    assert.equal(access.view.value.kind, 'declined')
    t.mock.timers.tick(hours(1) - 1000)
    assert.equal(access.view.value.kind, 'declined')
    t.mock.timers.tick(2000)
    assert.deepEqual(access.view.value, { kind: 'ask', previouslyDeclined: true })
    assert.deepEqual(calls, [])
  } finally { scope.stop() }
})

test('the busy label belongs to the running action', async (t) => {
  let finishCancel!: () => void
  mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests/jr_1/cancel': () => json({ join_request: request('cancelled') }),
  })
  const original = globalThis.fetch
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    await new Promise<void>(resolve => { finishCancel = resolve })
    return original(...args)
  })
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({ room: () => 'ROOM-1234', initialRequest: request('pending'), onMember() {} }))!
  try {
    const cancelling = access.cancel()
    assert.equal(access.busyAction.value, 'cancel')
    assert.equal(access.busy.value, true)
    await tick()
    finishCancel()
    await cancelling
    assert.equal(access.busyAction.value, null)
  } finally { scope.stop() }
})

test('Cancel after an admin already approved opens the room instead of failing', async (t) => {
  const calls = mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests/jr_1/cancel': json({
      error: 'This request is already approved.', code: 'ROOM_JOIN_REQUEST_NOT_PENDING', join_request: request('approved'),
    }, 409),
    'GET /rooms/ROOM-1234/membership': {
      room_id: 'ROOM-1234', access_room_id: 'ROOM-1234', display_name: 'Planning', managed_by: 'letagents',
      member: true, role: 'member', join_request: request('approved'),
    },
  })
  let opened = 0
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({
    room: () => 'ROOM-1234', initialRequest: request('pending'), onMember: () => { opened += 1 },
  }))!
  try {
    await access.cancel()
    assert.equal(opened, 1)
    assert.equal(access.error.value, '')
    assert.deepEqual(calls, ['POST /rooms/ROOM-1234/join-requests/jr_1/cancel', 'GET /rooms/ROOM-1234/membership'])
  } finally { scope.stop() }
})

test('asking during the decline cooldown shows "Declined" with the time from retry_after', async (t) => {
  const retryAfter = iso(Date.now() + hours(3))
  mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests': json({
      error: 'A room admin declined your last request. You can ask again later.',
      code: 'ROOM_JOIN_REQUEST_COOLDOWN',
      join_request: request('declined', { retry_after: null }),
      retry_after: retryAfter,
    }, 429),
  })
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({ room: () => 'ROOM-1234', onMember() {} }))!
  try {
    await access.ask()
    assert.deepEqual(access.view.value, { kind: 'declined', retryAt: Date.parse(retryAfter) })
    assert.equal(access.error.value, '', 'a cooldown is a state, not an error')
  } finally { scope.stop() }
})

test('a rate limit shows the server message and keeps "Ask to join"', async (t) => {
  mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests': json({ error: 'Too many requests to join rooms. Please wait and try again.', code: 'RATE_LIMITED' }, 429),
  })
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({ room: () => 'ROOM-1234', onMember() {} }))!
  try {
    await access.ask()
    assert.equal(access.view.value.kind, 'ask')
    assert.equal(access.error.value, 'Too many requests to join rooms. Please wait and try again.')
    assert.equal(access.busy.value, false)
  } finally { scope.stop() }
})

test('Check again opens the room once an admin approves, and a 409 on ask looks before failing', async (t) => {
  let approved = false
  const calls = mockApi(t, {
    'GET /rooms/ROOM-1234/membership': () => ({
      room_id: 'ROOM-1234', access_room_id: 'ROOM-1234', display_name: 'Planning', managed_by: 'letagents',
      member: approved, role: approved ? 'member' : null, join_request: approved ? request('approved') : request('pending'),
    }),
    'POST /rooms/ROOM-1234/join-requests': json({ error: 'You are already a member of this room.', code: 'ROOM_ALREADY_MEMBER' }, 409),
  })
  let opened = 0
  const scope = effectScope()
  const access = scope.run(() => useRoomJoinRequest({
    room: () => 'ROOM-1234', initialRequest: request('pending'), onMember: () => { opened += 1 },
  }))!
  try {
    await access.check()
    assert.equal(opened, 0)
    assert.equal(access.view.value.kind, 'pending')
    approved = true
    await access.check()
    assert.equal(opened, 1)
    await access.ask()
    assert.equal(opened, 2, 'already a member: open the room instead of an error')
    assert.equal(access.error.value, '')
    assert.deepEqual(calls, [
      'GET /rooms/ROOM-1234/membership',
      'GET /rooms/ROOM-1234/membership',
      'POST /rooms/ROOM-1234/join-requests',
      'GET /rooms/ROOM-1234/membership',
    ])
  } finally { scope.stop() }
})

test('a refusal from a room read closes the open room; member routes and other rooms do not', async (t) => {
  let refused = false
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    calls.push(key)
    if (key === 'POST /rooms/ROOM-1234/join') return json({ room_id: 'ROOM-1234', display_name: 'Planning', kind: 'main' })
    const refusal = roomMembershipRequiredBody({ room_id: 'ROOM-1234', display_name: 'Planning', join_request: request('approved') })
    if (refused && key.startsWith('GET /rooms/')) return json(refusal, 403)
    return json({})
  })
  let stops = 0
  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop() {},
    startPresenceRefreshLoop() {},
    async startStreaming() {},
    finishStreamingBootstrap() {},
    stopStreaming() { stops += 1 },
  })
  try {
    assert.equal(await lifecycle.joinRoom('ROOM-1234'), true)
    assert.equal(isConnected.value, true)
    refused = true
    const stopsAfterJoin = stops

    await assert.rejects(fetchRoomMembers('ROOM-1234'))
    assert.equal(isConnected.value, true, 'a member route refusal is about membership, not reading')
    await assert.rejects(apiFetch('/rooms/OTHER-0001/presence'))
    assert.equal(isConnected.value, true, 'another room is not this room')
    assert.equal(stops, stopsAfterJoin)

    await assert.rejects(apiFetch(`${roomPath('ROOM-1234')}/presence`))
    assert.equal(isConnected.value, false)
    assert.equal(room.value, null)
    assert.equal(stops, stopsAfterJoin + 1, 'the stream and the refresh timers stop')
    assert.equal(joinError.value?.refusal, 'membership_required')
    assert.equal(joinError.value?.roomId, 'ROOM-1234')
    assert.equal(joinError.value?.joinRequest?.state, 'approved')
  } finally {
    lifecycle.leaveRoom()
    lifecycle.dispose()
  }
})

/** Mounts the access screen's script without a DOM, to drive its window-focus check. */
function mountAccess(props: Record<string, unknown>) {
  const emitted: string[] = []
  const win = globalThis.window as any
  const { addEventListener, removeEventListener } = win
  let focusHandler: (() => void) | null = null
  win.addEventListener = (type: string, handler: () => void) => { if (type === 'focus') focusHandler = handler }
  win.removeEventListener = (type: string, handler: () => void) => { if (type === 'focus' && focusHandler === handler) focusHandler = null }
  const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}),
    createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
  let bindings: any
  const app = renderer.createApp({ setup() {
    bindings = AccessRequest.setup({ roomId: 'ROOM-1234', displayName: 'Planning', login: 'cy', initialRequest: null, ...props },
      { expose() {}, emit: (event: string) => emitted.push(event) })
    return () => h('div')
  } })
  app.provide(ssrContextKey, { modules: new Set() })
  app.mount({})
  return {
    emitted,
    bindings,
    focus: () => focusHandler?.(),
    listening: () => Boolean(focusHandler),
    unmount() {
      app.unmount()
      Object.assign(win, { addEventListener, removeEventListener })
    },
  }
}

test('window focus checks a pending request at most once per 5 s and opens the room once approved', async (t) => {
  let approved = false
  const calls = mockApi(t, {
    'GET /rooms/ROOM-1234/membership': () => ({
      room_id: 'ROOM-1234', access_room_id: 'ROOM-1234', display_name: 'Planning', managed_by: 'letagents',
      member: approved, role: approved ? 'member' : null, join_request: request(approved ? 'approved' : 'pending'),
    }),
  })
  const screen = mountAccess({ refusal: 'membership_required', initialRequest: request('pending') })
  try {
    assert.equal(screen.listening(), true)
    screen.focus()
    await tick()
    screen.focus()
    await tick()
    assert.deepEqual(calls, ['GET /rooms/ROOM-1234/membership'], 'a second focus within 5 s does not ask again')
    assert.deepEqual(screen.emitted, [])
    approved = true
    await screen.bindings.checkAgain()
    assert.deepEqual(screen.emitted, ['retry'])
  } finally { screen.unmount() }
  assert.equal(screen.listening(), false, 'the focus listener goes away with the screen')
})

test('window focus does nothing on "Ask to join"', async (t) => {
  const calls = mockApi(t, {})
  const screen = mountAccess({ refusal: 'membership_required' })
  try {
    screen.focus()
    await tick()
    assert.deepEqual(calls, [])
  } finally { screen.unmount() }
})

test('the repo screen checks with a read, stays put while refused, and never re-joins', async (t) => {
  let collaborator = false
  const calls = mockApi(t, {
    'GET /rooms/github.com%2Facme%2Fapp/membership': () => collaborator
      ? { room_id: 'github.com/acme/app', access_room_id: 'github.com/acme/app', display_name: 'github.com/acme/app', managed_by: 'github', member: null, role: null, join_request: null }
      : json(repoCollaboratorRequiredBody({ room_id: 'github.com/acme/app' }), 403),
  })
  const screen = mountAccess({ refusal: 'repo_collaborator_required', roomId: 'github.com/acme/app', displayName: null })
  try {
    screen.focus()
    await tick()
    assert.deepEqual(screen.emitted, [])
    assert.equal(screen.bindings.errorText.value, '', 'still no role is not an error')
    collaborator = true
    await screen.bindings.checkAgain()
    assert.deepEqual(screen.emitted, ['retry'])
    assert.ok(calls.every(call => call === 'GET /rooms/github.com%2Facme%2Fapp/membership'), 'no POST /join, which has a strict rate limit')
  } finally { screen.unmount() }
})

test('after Ask to join, focus moves to the new first button once the request ends', async (t) => {
  mockApi(t, { 'POST /rooms/ROOM-1234/join-requests': json({ join_request: request('pending') }, 201) })
  const body = {}
  const doc = { body, activeElement: body as unknown }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  const focused: string[] = []
  const screen = mountAccess({ refusal: 'membership_required' })
  screen.bindings.actionsElement.value = {
    querySelector: (selector: string) => selector === 'button:not(:disabled)' && !screen.bindings.busy.value
      ? { focus: () => { focused.push('first button'); doc.activeElement = {} } }
      : null,
  }
  try {
    await screen.bindings.joinRequest.ask()
    for (let index = 0; index < 3; index += 1) await tick()
    assert.equal(screen.bindings.state.value, 'pending')
    assert.deepEqual(focused, ['first button'])
  } finally {
    screen.unmount()
    Reflect.deleteProperty(globalThis, 'document')
  }
})

test('Check again with no change of state gives focus back when it fell to the page', async (t) => {
  mockApi(t, {
    'GET /rooms/ROOM-1234/membership': {
      room_id: 'ROOM-1234', access_room_id: 'ROOM-1234', display_name: 'Planning', managed_by: 'letagents', member: false, role: null, join_request: request('pending'),
    },
  })
  const body = {}
  const doc = { body, activeElement: body as unknown }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc })
  const focused: string[] = []
  const screen = mountAccess({ refusal: 'membership_required', initialRequest: request('pending') })
  screen.bindings.actionsElement.value = {
    querySelector: () => screen.bindings.busy.value ? null : { focus: () => { focused.push('first button'); doc.activeElement = {} } },
  }
  try {
    await screen.bindings.pressed(screen.bindings.checkAgain)
    for (let index = 0; index < 3; index += 1) await tick()
    assert.equal(screen.bindings.state.value, 'pending')
    assert.deepEqual(focused, ['first button'])
    focused.length = 0
    screen.focus()
    for (let index = 0; index < 3; index += 1) await tick()
    assert.deepEqual(focused, [], 'a check on window focus never moves focus')
  } finally {
    screen.unmount()
    Reflect.deleteProperty(globalThis, 'document')
  }
})

test('a join that fails after a newer join started leaves the newer room alone', async (t) => {
  let failOld!: () => void
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    if (key === 'POST /rooms/OLD-0001/join') {
      await new Promise<void>(resolve => { failOld = resolve })
      return json({ error: 'Room not found' }, 404)
    }
    if (key === 'POST /rooms/ROOM-1234/join') return json({ room_id: 'ROOM-1234', display_name: 'Planning', kind: 'main' })
    return json({})
  })
  t.mock.method(console, 'error', () => undefined)
  let stops = 0
  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop() {},
    startPresenceRefreshLoop() {},
    async startStreaming() {},
    finishStreamingBootstrap() {},
    stopStreaming() { stops += 1 },
  })
  try {
    const old = lifecycle.joinRoom('OLD-0001')
    await tick()
    assert.equal(await lifecycle.joinRoom('ROOM-1234'), true)
    const stopsAfterNewJoin = stops
    failOld()
    assert.equal(await old, false)
    assert.equal(connectionState.value, 'live')
    assert.equal(isConnected.value, true)
    assert.equal(joinError.value, null)
    assert.equal(stops, stopsAfterNewJoin, 'the old failure does not stop the new stream')
  } finally {
    lifecycle.leaveRoom()
    lifecycle.dispose()
  }
})

test('a refusal while the room loads leaves the access screen, not a half-open room', async (t) => {
  const refusal = roomMembershipRequiredBody({ room_id: 'ROOM-1234', display_name: 'Planning', join_request: null })
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`
    if (key === 'POST /rooms/ROOM-1234/join') return json({ room_id: 'ROOM-1234', display_name: 'Planning', kind: 'main' })
    if (key.startsWith('GET /rooms/ROOM-1234/presence')) return json(refusal, 403)
    return json({})
  })
  const loops: string[] = []
  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop() { loops.push('participants') },
    startPresenceRefreshLoop() { loops.push('presence') },
    async startStreaming() {},
    finishStreamingBootstrap() {},
    stopStreaming() {},
  })
  try {
    assert.equal(await lifecycle.joinRoom('ROOM-1234'), false)
    assert.equal(isConnected.value, false)
    assert.equal(connectionState.value, 'error')
    assert.equal(joinError.value?.refusal, 'membership_required')
    assert.deepEqual(loops, [], 'no refresh loop starts for a refused room')
  } finally {
    lifecycle.leaveRoom()
    lifecycle.dispose()
  }
})

async function renderAccess(props: Record<string, unknown>) {
  return renderToString(createSSRApp({
    render: () => h(AccessRequest, { roomId: 'ROOM-1234', displayName: 'Planning', login: 'cy', initialRequest: null, ...props }),
  }))
}

test('the access screen shows Ask to join, Waiting, Declined and the repository state', async (t) => {
  // The declined screen arms one timer for the end of the wait; a rendered page never unmounts.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ask = await renderAccess({ refusal: 'membership_required' })
  assert.match(ask, /Members only/)
  assert.match(ask, />\s*Ask to join\s*</)
  assert.ok(ask.includes(ROOM_MEMBERSHIP_REQUIRED_MESSAGE))
  assert.match(ask, /Signed in as cy/)
  assert.doesNotMatch(ask, /Check again|Cancel request/)

  const pending = await renderAccess({ refusal: 'membership_required', initialRequest: request('pending', { created_at: new Date().toISOString() }) })
  assert.match(pending, /Waiting for an admin/)
  assert.match(pending, /You asked at /)
  assert.match(pending, />\s*Check again\s*</)
  assert.match(pending, />\s*Cancel request\s*</)
  assert.doesNotMatch(pending, /Ask to join/)

  const declined = await renderAccess({
    refusal: 'membership_required',
    initialRequest: request('declined', { retry_after: iso(Date.now() + hours(5)) }),
  })
  assert.match(declined, /Request declined/)
  assert.match(declined, /You can ask again (at|on) /)
  assert.doesNotMatch(declined, /Ask to join|Cancel request/)

  const askAgain = await renderAccess({ refusal: 'membership_required', initialRequest: request('declined', { retry_after: iso(Date.now() - 1000) }) })
  assert.match(askAgain, /declined your last request\. You can ask again now/)
  assert.match(askAgain, />\s*Ask to join\s*</)

  const repo = await renderAccess({ refusal: 'repo_collaborator_required', roomId: 'github.com/acme/app', displayName: null })
  assert.match(repo, /GitHub role required/)
  assert.match(repo, /github\.com\/acme\/app/)
  assert.ok(repo.includes(REPO_COLLABORATOR_REQUIRED_MESSAGE), 'Ask a repository admin to add you on GitHub')
  assert.match(repo, />\s*Check again\s*</)
  assert.doesNotMatch(repo, /Ask to join|Cancel request/)
})

test('admins load members and pending requests; repo rooms say GitHub manages members', async (t) => {
  const calls = mockApi(t, {
    'GET /rooms/ROOM-1234/members': adminList,
    'GET /rooms/ROOM-1234/join-requests?state=pending': pendingRequests,
    'GET /rooms/github.com%2Facme%2Fapp/members': {
      room_id: 'github.com/acme/app', access_room_id: 'github.com/acme/app', managed_by: 'github', can_manage: false, members: [],
    },
  })
  const room = ref<RoomInfo | null>(roomInfo())
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(room, () => 'acct_ada'))!
  try {
    await members.load()
    assert.equal(members.canManage.value, true)
    assert.deepEqual(members.list.value?.members.map(person => person.login), ['ada', 'bob'])
    assert.deepEqual(members.requests.value.map(item => item.login), ['cy'])

    room.value = roomInfo('github.com/acme/app')
    members.reset()
    await members.load()
    assert.equal(members.managedOnGitHub.value, true)
    assert.equal(members.canManage.value, false)
    assert.deepEqual(calls, [
      'GET /rooms/ROOM-1234/members',
      'GET /rooms/ROOM-1234/join-requests?state=pending',
      'GET /rooms/github.com%2Facme%2Fapp/members',
    ], 'a repo room never asks for join requests')
  } finally { scope.stop() }
})

test('in a focus room the lists name the parent room, read once from the membership state', async (t) => {
  const calls = mockApi(t, {
    'GET /rooms/focus_9/members': { ...adminList, room_id: 'focus_9', access_room_id: 'ROOM-1234', can_manage: false },
    'GET /rooms/focus_9/membership': {
      room_id: 'focus_9', access_room_id: 'ROOM-1234', display_name: 'Planning', managed_by: 'letagents', member: true, role: 'member', join_request: null,
    },
  })
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(ref(roomInfo('focus_9')), () => 'acct_bob'))!
  try {
    await members.load()
    await members.load()
    assert.equal(members.inheritsMembers.value, true)
    assert.equal(members.accessRoomName.value, 'Planning')
    assert.deepEqual(calls, ['GET /rooms/focus_9/members', 'GET /rooms/focus_9/membership', 'GET /rooms/focus_9/members'])
  } finally { scope.stop() }
})

test('a member does not load requests, and a non-member gets the 403 request state', async (t) => {
  const calls = mockApi(t, {
    'GET /rooms/ROOM-1234/members': { ...adminList, can_manage: false },
    'GET /rooms/OTHER-0001/members': json(roomMembershipRequiredBody({ room_id: 'OTHER-0001', display_name: 'Other', join_request: request('pending') }), 403),
  })
  const room = ref<RoomInfo | null>(roomInfo())
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(room, () => 'acct_bob'))!
  try {
    await members.load()
    assert.equal(members.canManage.value, false)
    assert.deepEqual(members.requests.value, [])
    room.value = roomInfo('OTHER-0001')
    members.reset()
    await members.load()
    assert.equal(members.list.value, null)
    assert.equal(members.loadError.value, '')
    assert.deepEqual(members.notMember.value, { joinRequest: request('pending') })
    assert.deepEqual(calls, ['GET /rooms/ROOM-1234/members', 'GET /rooms/OTHER-0001/members'])
  } finally { scope.stop() }
})

test('Approve, Make admin and Remove call the member routes, then reload the lists', async (t) => {
  let requests = pendingRequests.join_requests
  let list = adminList
  const calls = mockApi(t, {
    'GET /rooms/ROOM-1234/members': () => list,
    'GET /rooms/ROOM-1234/join-requests?state=pending': () => ({ ...pendingRequests, join_requests: requests }),
    'POST /rooms/ROOM-1234/join-requests/jr_cy/approve': () => {
      requests = []
      list = { ...adminList, members: [...adminList.members, member('acct_cy', 'cy', 'member')] }
      return { join_request: { ...pendingRequests.join_requests[0], state: 'approved' }, member: member('acct_cy', 'cy', 'member') }
    },
    'PUT /rooms/ROOM-1234/members/acct_bob/role': (init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { role: 'admin' })
      return { member: member('acct_bob', 'bob', 'admin') }
    },
    'DELETE /rooms/ROOM-1234/members/acct_bob': { removed: true, account_id: 'acct_bob', ended_agent_sessions: 1 },
  })
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(ref(roomInfo()), () => 'acct_ada'))!
  try {
    await members.load()
    assert.equal(await members.decide(members.requests.value[0], 'approve'), true)
    assert.deepEqual(members.requests.value, [])
    assert.ok(members.list.value?.members.some(person => person.login === 'cy'))
    assert.equal(await members.setRole(members.list.value!.members[1], 'admin'), true)
    assert.equal(await members.remove(members.list.value!.members[1]), true)
    assert.equal(members.actionError.value, '')
    assert.deepEqual(calls.filter(call => !call.startsWith('GET')), [
      'POST /rooms/ROOM-1234/join-requests/jr_cy/approve',
      'PUT /rooms/ROOM-1234/members/acct_bob/role',
      'DELETE /rooms/ROOM-1234/members/acct_bob',
    ])
  } finally { scope.stop() }
})

test('Leave as the last admin shows the 409 message and keeps the person in the room', async (t) => {
  mockApi(t, {
    'GET /rooms/ROOM-1234/members': adminList,
    'GET /rooms/ROOM-1234/join-requests?state=pending': pendingRequests,
    'DELETE /rooms/ROOM-1234/members/acct_ada': json({
      error: 'You are the only admin of this room. Make another member an admin before you leave.', code: 'ROOM_LAST_ADMIN',
    }, 409),
  })
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(ref(roomInfo()), () => 'acct_ada'))!
  try {
    await members.load()
    assert.equal(await members.leave(), false)
    assert.equal(members.actionError.value, 'You are the only admin of this room. Make another member an admin before you leave.')
    assert.equal(members.busyKey.value, null)
  } finally { scope.stop() }
})

test('a declined request that another admin already answered reloads the list and says so', async (t) => {
  let requests = pendingRequests.join_requests
  mockApi(t, {
    'GET /rooms/ROOM-1234/members': adminList,
    'GET /rooms/ROOM-1234/join-requests?state=pending': () => ({ ...pendingRequests, join_requests: requests }),
    'POST /rooms/ROOM-1234/join-requests/jr_cy/decline': () => {
      requests = []
      return json({ error: 'This request is already approved.', code: 'ROOM_JOIN_REQUEST_NOT_PENDING' }, 409)
    },
  })
  const scope = effectScope()
  const members = scope.run(() => useRoomMembers(ref(roomInfo()), () => 'acct_ada'))!
  try {
    await members.load()
    assert.equal(await members.decide(members.requests.value[0], 'decline'), false)
    assert.equal(members.actionError.value, 'This request is already approved.')
    assert.deepEqual(members.requests.value, [])
  } finally { scope.stop() }
})

/** Renders the drawer panel after its first load, so the HTML shows the loaded lists. */
async function renderMembersPanel(room: RoomInfo) {
  const Loaded = {
    ...MembersPanel,
    async setup(props: unknown, context: unknown) {
      const bindings = MembersPanel.setup(props, context)
      for (let index = 0; index < 5; index += 1) await tick()
      return bindings
    },
  }
  return renderToString(createSSRApp({ render: () => h(Loaded, { open: true, room }) }))
}

test('the drawer shows Requests and member actions to admins, and Leave on your own row', async (t) => {
  mockApi(t, {
    'GET /auth/session': { authenticated: true, account: { id: 'acct_ada', login: 'ada', provider: 'github' } },
    'GET /rooms/ROOM-1234/members': adminList,
    'GET /rooms/ROOM-1234/join-requests?state=pending': pendingRequests,
  })
  await viteAuth.checkSession()
  const html = await renderMembersPanel(roomInfo())
  assert.match(html, /<h2[^>]*>Requests<\/h2>/)
  assert.match(html, /1 waiting/)
  assert.match(html, /<strong[^>]*>Cy<\/strong>/)
  assert.match(html, /aria-label="Approve Cy"[^>]*>\s*Approve\s*</)
  assert.match(html, />\s*Decline\s*</)
  assert.match(html, /ada<!--\[--> \(you\)/)
  assert.match(html, />\s*Leave\s*</)
  assert.match(html, />\s*Make admin\s*</)
  assert.match(html, />\s*Remove\s*</)
  assert.equal((html.match(/>\s*Remove\s*</g) || []).length, 1, 'no Remove on your own row')
})

test('the drawer shows a member only Leave, and a repo room says members are managed on GitHub', async (t) => {
  mockApi(t, {
    'GET /auth/session': { authenticated: true, account: { id: 'acct_bob', login: 'bob', provider: 'github' } },
    'GET /rooms/ROOM-1234/members': { ...adminList, can_manage: false },
    'GET /rooms/github.com%2Facme%2Fapp/members': {
      room_id: 'github.com/acme/app', access_room_id: 'github.com/acme/app', managed_by: 'github', can_manage: false, members: [],
    },
  })
  await viteAuth.checkSession()
  const memberView = await renderMembersPanel(roomInfo())
  assert.doesNotMatch(memberView, /Requests|Approve|Make admin|Remove/)
  assert.match(memberView, />\s*Leave\s*</)
  assert.match(memberView, /Admin/)

  const repoView = await renderMembersPanel(roomInfo('github.com/acme/app'))
  assert.match(repoView, /Members are managed on GitHub/)
  assert.doesNotMatch(repoView, /Leave|Requests/)
})

test('the drawer offers Ask to join to a person who is not a member yet', async (t) => {
  mockApi(t, {
    'GET /auth/session': { authenticated: true, account: { id: 'acct_cy', login: 'cy', provider: 'github' } },
    'GET /rooms/ROOM-1234/members': json(roomMembershipRequiredBody({ room_id: 'ROOM-1234', display_name: 'Planning', join_request: null }), 403),
  })
  await viteAuth.checkSession()
  const html = await renderMembersPanel(roomInfo())
  assert.match(html, /You are not a member of this room yet\./)
  assert.match(html, />\s*Ask to join\s*</)
  assert.doesNotMatch(html, /Leave|Requests|Remove/)
})

test('presentation keeps the existing sign-in and private-repo errors apart from membership', () => {
  const error = ref<any>({ status: 403, code: 'PRIVATE_REPO_NO_ACCESS', message: 'x', roomId: 'r', deviceFlowUrl: null, refusal: null, displayName: null, joinRequest: null })
  const view = presentation.useRoomPresentation({
    room: ref(null), tasks: ref([]), joinError: computed(() => error.value), connectionState: ref('error'), authUser: ref({ login: 'cy' }),
  })
  assert.equal(view.accessRefusal.value, null)
  assert.equal(view.joinErrorTitle.value, 'No repo access')
  assert.equal(view.roomTitle.value, 'Connecting...')
})

test('a focus room id offers no "Ask to join", and a 400 main-room-only answer says the same', async (t) => {
  assert.equal(isFocusRoomId('focus_9'), true)
  assert.equal(isFocusRoomId('ROOM-1234'), false)
  assert.equal(isFocusRoomId('github.com/acme/focus_9'), false)
  const calls = mockApi(t, {
    'POST /rooms/ROOM-1234/join-requests': json({
      error: 'Ask to join the main room, not one of its focus rooms.', code: ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY,
    }, 400),
  })
  const scope = effectScope()
  const focus = scope.run(() => useRoomJoinRequest({ room: () => 'focus_9', onMember() {} }))!
  const aliased = scope.run(() => useRoomJoinRequest({ room: () => 'ROOM-1234', onMember() {} }))!
  try {
    assert.deepEqual(focus.view.value, { kind: 'main_room_only' })
    assert.equal(aliased.view.value.kind, 'ask')
    await aliased.ask()
    assert.deepEqual(aliased.view.value, { kind: 'main_room_only' })
    assert.equal(aliased.error.value, '', 'the answer is a state, not an error')
    assert.deepEqual(calls, ['POST /rooms/ROOM-1234/join-requests'])
  } finally { scope.stop() }
})

test('the access screen for a focus room asks for the main room\'s link instead of offering a request', async () => {
  const html = await renderAccess({
    refusal: 'membership_required', roomId: 'focus_9', displayName: null, initialRequest: null,
  })
  assert.match(html, /focus_9/)
  assert.match(html, /Ask a member for the main room&#39;s link/)
  assert.match(html, />\s*Check again\s*</)
  assert.doesNotMatch(html, /Ask to join<|Cancel request/)
})

test('the drawer of a focus room tells a non-member to ask to join the main room', async (t) => {
  mockApi(t, {
    'GET /auth/session': { authenticated: true, account: { id: 'acct_cy', login: 'cy', provider: 'github' } },
    'GET /rooms/focus_9/members': json(roomMembershipRequiredBody({ room_id: 'focus_9', display_name: null, join_request: null }), 403),
  })
  await viteAuth.checkSession()
  const html = await renderMembersPanel(roomInfo('focus_9'))
  assert.match(html, /A focus room uses the members of its main room: ask to join there\./)
  assert.doesNotMatch(html, />\s*Ask to join\s*</)
})

test('a 503 from the GitHub role check is a retry state, never an access refusal', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    error: 'repo_access_unavailable', code: REPO_ACCESS_UNAVAILABLE,
    message: 'GitHub did not answer the repository access check. Please retry.', room_id: 'github.com/acme/app',
  }), { status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '30' } }))
  t.mock.method(console, 'error', () => undefined)
  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop() {}, startPresenceRefreshLoop() {}, async startStreaming() {}, finishStreamingBootstrap() {}, stopStreaming() {},
  })
  try {
    assert.equal(await lifecycle.joinRoom('github.com/acme/app'), false)
    assert.equal(joinError.value?.status, 503)
    assert.equal(joinError.value?.code, REPO_ACCESS_UNAVAILABLE)
    assert.equal(joinError.value?.refusal, null)
    assert.equal(joinError.value?.retryAfterMs, 30_000)
    const view = presentation.useRoomPresentation({
      room: ref(null), tasks: ref([]), joinError, connectionState: ref('error'), authUser: ref({ login: 'cy' }),
    })
    assert.equal(view.accessRefusal.value, null, 'no "Ask a repository admin" screen')
    assert.equal(view.accessCheckUnavailable.value, true)
    assert.equal(view.joinErrorTitle.value, 'GitHub is not answering')
    assert.equal(view.roomTitle.value, 'github.com/acme/app')
    assert.match(view.joinErrorBody.value, /not a refusal/)
  } finally {
    lifecycle.leaveRoom()
    lifecycle.dispose()
  }
})

test('the GitHub retry waits what the server asks, doubles from 30 s, and stops at 5 min', () => {
  assert.equal(retry.repoAccessRetryDelay(0, null), 30_000)
  assert.equal(retry.repoAccessRetryDelay(1, 30_000), 60_000)
  assert.equal(retry.repoAccessRetryDelay(2, 30_000), 120_000)
  assert.equal(retry.repoAccessRetryDelay(9, 30_000), 300_000)
  assert.equal(retry.repoAccessRetryDelay(0, 90_000), 90_000, 'a longer Retry-After wins')
  assert.equal(retry.repoAccessRetryDelay(0, 3_600_000), 300_000)
})

test('the room page retries a GitHub 503 on its own with a growing wait, and stops on success or another error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW })
  const unavailable = (roomId = 'github.com/acme/app') => ({
    status: 503, code: REPO_ACCESS_UNAVAILABLE, message: 'GitHub did not answer.', roomId, deviceFlowUrl: null,
    refusal: null, displayName: null, joinRequest: null, retryAfterMs: 30_000,
  })
  const error = ref<any>(null)
  const connected = ref(false)
  let retries = 0
  const scope = effectScope()
  const state = scope.run(() => retry.useRepoAccessRetry({ joinError: error, isConnected: connected, retry: async () => { retries += 1 } }))!
  const flush = async () => { await tick(); await tick() }
  try {
    error.value = unavailable(); await flush()
    assert.equal(state.nextRetryAt.value, NOW + 30_000)
    t.mock.timers.tick(29_999); assert.equal(retries, 0)
    t.mock.timers.tick(1); assert.equal(retries, 1)
    error.value = null; await flush()
    error.value = unavailable(); await flush()
    assert.equal(state.nextRetryAt.value, NOW + 30_000 + 60_000, 'the second wait is longer')
    error.value = null; await flush()
    connected.value = true; await flush()
    connected.value = false
    error.value = unavailable(); await flush()
    assert.equal(state.nextRetryAt.value, NOW + 30_000 + 30_000, 'an open room resets the wait')
    error.value = { ...unavailable(), code: 'PRIVATE_REPO_NO_ACCESS', status: 403 }; await flush()
    assert.equal(state.nextRetryAt.value, null)
    t.mock.timers.tick(600_000)
    assert.equal(retries, 1, 'another error never retries')
  } finally { scope.stop() }
})
