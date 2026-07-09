import assert from 'node:assert/strict'
import test from 'node:test'

type Listener = (event: { data: string }) => void

class FakeEventSource {
  static instances: FakeEventSource[] = []

  listeners = new Map<string, Listener[]>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(name: string, listener: Listener) {
    const listeners = this.listeners.get(name) || []
    listeners.push(listener)
    this.listeners.set(name, listeners)
  }

  close() {
    this.closed = true
  }

  dispatch(name: string, payload: unknown) {
    for (const listener of this.listeners.get(name) || []) {
      listener({ data: JSON.stringify(payload) })
    }
  }
}

;(globalThis as any).localStorage = {
  getItem: () => 'off',
  setItem: () => {},
}
;(globalThis as any).EventSource = FakeEventSource

const { createRoomStream } = await import('./room/stream.js')

test('room stream forwards typed GitHub event invalidations', () => {
  const githubEventRooms: Array<string | null | undefined> = []
  const stream = createRoomStream({
    setConnectionState: () => {},
    setStreaming: () => {},
    appendMessage: () => true,
    onGitHubMessage: () => {},
    onGitHubEvent: (roomIdentifier) => {
      githubEventRooms.push(roomIdentifier)
    },
    onTaskLifecycleMessage: () => {},
    onArtifactUpdate: () => {},
    onAgentActivityMessage: () => {},
    onParticipantActivityMessage: () => {},
    upsertTask: () => {},
    upsertReasoningSession: () => {},
    removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({
      success: true,
      cursor: after,
    }),
  })

  stream.start('focus_27')
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.ok(source)
  assert.equal(source.url, '/rooms/focus_27/messages/stream')

  source.dispatch('github_event', {
    room_id: 'focus_27',
    event_type: 'pull_request',
  })

  assert.deepEqual(githubEventRooms, ['focus_27'])
  stream.stop()
  assert.equal(source.closed, true)
})

test('room stream reconciles from a stable history cursor while SSE remains open', async () => {
  const resyncs: Array<{ roomIdentifier: string; after: string | null }> = []
  const stream = createRoomStream({
    setConnectionState: () => {},
    setStreaming: () => {},
    appendMessage: () => true,
    onGitHubMessage: () => {},
    onGitHubEvent: () => {},
    onTaskLifecycleMessage: () => {},
    onArtifactUpdate: () => {},
    onAgentActivityMessage: () => {},
    onParticipantActivityMessage: () => {},
    upsertTask: () => {},
    upsertReasoningSession: () => {},
    removeReasoningSession: () => {},
    getMessageCursor: () => 'msg_1',
    resyncMessages: async (roomIdentifier, after) => {
      resyncs.push({ roomIdentifier, after })
      return { success: true, cursor: after }
    },
  }, { resyncIntervalMs: 5 })

  stream.start('room_1')
  const initialSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  initialSource.onopen?.()
  await new Promise((resolve) => setTimeout(resolve, 12))

  // A dropped reference event does not necessarily close SSE. Periodic
  // durable-history reconciliation must recover it on the still-open stream.
  assert.ok(resyncs.length >= 2)
  assert.ok(resyncs.every(({ roomIdentifier }) => roomIdentifier === 'room_1'))
  assert.ok(resyncs.every(({ after }) => after === 'msg_1'))
  stream.stop()
})
