import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoomRefreshController } from './room/refresh.js'
import {
  activityLoading,
  resetRoomState,
  messages,
  room,
  roomArtifacts,
} from './room/state.js'

test('retired activity refresh relinquishes loading without clearing a replacement request', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  room.value = {
    identifier: 'room_old', name: 'room_old', projectId: 'room_old',
    displayName: 'Old room', kind: 'main',
  } as never
  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  let releaseOld!: () => void
  let releaseNew!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('room_old')) await oldGate
    if (String(input).includes('room_new')) await newGate
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  const oldRefresh = controller.refreshRoomActivity({}, () => false)
  assert.equal(activityLoading.value, true)
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  assert.equal(activityLoading.value, false, 'room reset immediately releases the retired spinner')
  room.value = {
    identifier: 'room_new', name: 'room_new', projectId: 'room_new',
    displayName: 'New room', kind: 'main',
  } as never
  const replacementRefresh = controller.refreshRoomActivity()
  assert.equal(activityLoading.value, true)
  releaseOld()
  assert.equal(await oldRefresh, false)
  assert.equal(activityLoading.value, true, 'retired request cannot clear the replacement spinner')
  releaseNew()
  assert.equal(await replacementRefresh, true)
  assert.equal(activityLoading.value, false)
})

test('scheduleRoomArtifactsRefresh coalesces bursty stream refreshes', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'idle',
  })
  room.value = {
    identifier: 'focus_27',
    name: 'focus_27',
    projectId: 'focus_27',
    displayName: 'Git Rooms slice',
    kind: 'focus',
  } as never

  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  const requests: string[] = []

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    return new Response(
      JSON.stringify({
        artifacts: [
          {
            room_id: 'focus_27',
            identity_key: 'github:branch:ref:codex/git-rooms',
            provider: 'github',
            kind: 'branch',
            artifact_id: null,
            artifact_number: null,
            title: 'Branch codex/git-rooms',
            url: null,
            ref: 'codex/git-rooms',
            state: 'pushed',
            source: 'github_event',
            first_seen_at: '2026-06-28T10:00:00.000Z',
            updated_at: '2026-06-28T10:00:00.000Z',
            linked_task_ids: [],
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  t.after(() => {
    controller.stopRoomArtifactsRefresh()
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  controller.scheduleRoomArtifactsRefresh('focus_27')
  controller.scheduleRoomArtifactsRefresh('focus_27')
  controller.scheduleRoomArtifactsRefresh('focus_27')

  await new Promise((resolve) => setTimeout(resolve, 450))

  assert.deepEqual(requests, ['/rooms/focus_27/artifacts'])
  assert.equal(roomArtifacts.value.length, 1)
  assert.equal(roomArtifacts.value[0]?.identity_key, 'github:branch:ref:codex/git-rooms')
})

test('refreshRoomMessages recovers holes after a stable durable cursor', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  room.value = {
    identifier: 'room_1',
    name: 'room_1',
    projectId: 'room_1',
    displayName: 'Room 1',
    kind: 'main',
  } as never
  const message = (id: string) => ({
    id,
    sender: 'agent',
    text: id,
    timestamp: '2026-07-10T00:00:00.000Z',
  }) as never
  // msg_3 arrived over SSE after msg_2 was silently dropped. The durable
  // cursor must remain at msg_1 so history can fill the hole.
  messages.value = [message('msg_1'), message('msg_3')]

  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    const cursor = new URL(String(input), 'https://letagents.test').searchParams.get('after')
    return new Response(JSON.stringify(cursor === 'msg_1'
      ? { messages: [message('msg_2')], has_more: true }
      : { messages: [message('msg_3')], has_more: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  assert.deepEqual(await controller.refreshRoomMessages('msg_1'), {
    success: true,
    cursor: 'msg_3',
  })
  assert.deepEqual(requests, [
    '/rooms/room_1/messages?limit=150&after=msg_1',
    '/rooms/room_1/messages?limit=150&after=msg_2',
  ])
  assert.deepEqual(messages.value.map((item) => item.id), ['msg_1', 'msg_2', 'msg_3'])
})

test('gap history repair caps each pass and switches human state to one latest window', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  room.value = {
    identifier: 'room_huge_gap',
    name: 'room_huge_gap',
    projectId: 'room_huge_gap',
    displayName: 'Huge gap',
    kind: 'main',
  } as never
  const message = (id: string) => ({
    id,
    sender: 'agent',
    text: id,
    timestamp: '2026-07-10T00:00:00.000Z',
  }) as never
  messages.value = [message('msg_1')]
  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const cursor = new URL(url, 'https://letagents.test').searchParams.get('after')
    if (!cursor) {
      return new Response(JSON.stringify({ messages: [message('msg_7')], has_older: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const number = Number(cursor.slice(4)) + 1
    return new Response(JSON.stringify({
      messages: [message(`msg_${number}`)],
      has_more: number < 7,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  assert.deepEqual(await controller.refreshRoomMessages('msg_1', true), {
    success: true,
    cursor: 'msg_5',
    complete: false,
  })
  assert.equal(requests.length, 4, 'one repair pass obeys the page budget')
  assert.deepEqual(await controller.refreshRoomMessages('msg_5', true), {
    success: true,
    cursor: 'msg_7',
  })
  assert.equal(requests.length, 7, 'the next bounded pass finishes then reads one latest window')
  assert.deepEqual(messages.value.map((item) => item.id), ['msg_7'])
})

test('failed final gap window preserves current UI and requires another repair', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  room.value = {
    identifier: 'room_gap_failure',
    name: 'room_gap_failure',
    projectId: 'room_gap_failure',
    displayName: 'Gap failure',
    kind: 'main',
  } as never
  const message = (id: string) => ({
    id,
    sender: 'agent',
    text: id,
    timestamp: '2026-07-10T00:00:00.000Z',
  }) as never
  messages.value = [message('msg_1')]
  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  let latestAttempts = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const cursor = new URL(String(input), 'https://letagents.test').searchParams.get('after')
    if (!cursor) {
      latestAttempts += 1
      if (latestAttempts === 1) return new Response('unavailable', { status: 503 })
      return new Response(JSON.stringify({ messages: [message('msg_7')], has_older: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const number = Number(cursor.slice(4)) + 1
    return new Response(JSON.stringify({
      messages: [message(`msg_${number}`)],
      has_more: number < 6,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  assert.deepEqual(await controller.refreshRoomMessages('msg_1', true), {
    success: true,
    cursor: 'msg_5',
    complete: false,
  })
  assert.deepEqual(await controller.refreshRoomMessages('msg_5', true), {
    success: false,
    cursor: 'msg_5',
  })
  assert.deepEqual(messages.value.map((item) => item.id), ['msg_1'])
  assert.deepEqual(await controller.refreshRoomMessages('msg_5', true), {
    success: true,
    cursor: 'msg_6',
  })
  assert.deepEqual(messages.value.map((item) => item.id), ['msg_7'])
})

test('full-state gap repair can exclude the overlapping latest-message read', async (t) => {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'connecting',
  })
  room.value = {
    identifier: 'room_gap',
    name: 'room_gap',
    projectId: 'room_gap',
    displayName: 'Gap room',
    kind: 'main',
  } as never
  const controller = createRoomRefreshController({
    refreshParticipants: async () => {},
    refreshPresence: async () => {},
  })
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    const body = url.includes('/activity-history')
      ? { entries: [], selected_room_id: 'room_gap' }
      : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  assert.equal(await controller.refreshRoomActivity({ includeMessages: false }), true)
  assert.equal(
    requests.some((url) => url.includes('/messages')),
    false,
    'the stream generation owns the one bounded after-cursor message repair',
  )
})
