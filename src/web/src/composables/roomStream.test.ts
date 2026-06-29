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
