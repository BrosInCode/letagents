import assert from 'node:assert/strict'
import test from 'node:test'

import { createRoomRefreshController } from './room/refresh.js'
import {
  resetRoomState,
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
