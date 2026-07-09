import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoomRefreshController } from './room/refresh.js'
import {
  resetRoomState,
  messages,
  room,
  roomArtifacts,
} from './room/state.js'

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
