import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { createRoomMessageActions } from './room/messageActions.js'
import {
  messages,
  resetRoomState,
  room,
} from './room/state.js'

function setupRoom(): void {
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'idle',
  })
  room.value = {
    identifier: 'room_1',
    name: 'room_1',
    projectId: 'room_1',
    displayName: 'Room One',
    kind: 'main',
  } as never
}

function mockMessagePost(t: TestContext): Array<Record<string, unknown>> {
  const originalFetch = globalThis.fetch
  const bodies: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), '/rooms/room_1/messages')
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(
      JSON.stringify({
        id: `msg_created_${bodies.length}`,
        sender: 'EmmyMay',
        text: 'sent',
        source: 'browser',
        timestamp: '2026-07-02T10:00:00.000Z',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  t.after(() => {
    globalThis.fetch = originalFetch
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
  })

  return bodies
}

test('web thread replies post thread_root_id alongside reply_to', async (t) => {
  setupRoom()
  const bodies = mockMessagePost(t)
  const { sendMessage } = createRoomMessageActions()

  const sent = await sendMessage(
    'any progress on this?',
    'EmmyMay',
    null,
    'msg_5',
    [],
    'msg_2',
  )

  assert.equal(sent, true)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].reply_to, 'msg_5')
  assert.equal(bodies[0].thread_root_id, 'msg_2')
  assert.equal(messages.value.at(-1)?.id, 'msg_created_1')
})

test('web top-level quote replies stay free of thread_root_id', async (t) => {
  setupRoom()
  const bodies = mockMessagePost(t)
  const { sendMessage } = createRoomMessageActions()

  const sent = await sendMessage('looks good', 'EmmyMay', null, 'msg_5', [], null)

  assert.equal(sent, true)
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].reply_to, 'msg_5')
  assert.equal('thread_root_id' in bodies[0], false)
})

test('web thread_root_id is ignored without a reply target', async (t) => {
  setupRoom()
  const bodies = mockMessagePost(t)
  const { sendMessage } = createRoomMessageActions()

  const sent = await sendMessage('hello room', 'EmmyMay', null, null, [], 'msg_2')

  assert.equal(sent, true)
  assert.equal(bodies.length, 1)
  assert.equal('reply_to' in bodies[0], false)
  assert.equal('thread_root_id' in bodies[0], false)
})
