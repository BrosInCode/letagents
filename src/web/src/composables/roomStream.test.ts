import assert from 'node:assert/strict'
import test from 'node:test'

type Listener = (event: { data: string; lastEventId: string }) => void

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

  dispatch(name: string, payload: unknown, lastEventId = '') {
    for (const listener of this.listeners.get(name) || []) {
      listener({ data: JSON.stringify(payload), lastEventId })
    }
  }

  dispatchRaw(name: string, data: string, lastEventId = '') {
    for (const listener of this.listeners.get(name) || []) {
      listener({ data, lastEventId })
    }
  }
}

;(globalThis as any).localStorage = {
  getItem: () => 'off',
  setItem: () => {},
}
;(globalThis as any).EventSource = FakeEventSource

const { createRoomStream } = await import('./room/stream.js')
const { lastMessageInfoInvalidation, invalidationCoversMessage } = await import('../components/room/messageInfoInvalidation.js')

test('message-info null preserves room scope, refresh signaling, and the subscribed cursor without a gap', () => {
  let reconciles = 0
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
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => { reconciles += 1; return true },
  })
  const alias = 'github.com/example/project'
  try {
    stream.start(alias)
    const source = FakeEventSource.instances.at(-1)!
    for (const messageIds of [['msg_7'], [], null]) {
      source.dispatch('message_info_updated', {
        room_id: 'room_canonical', message_ids: messageIds,
      }, 'broker_info')
      const invalidation = lastMessageInfoInvalidation.value
      assert.equal(invalidation?.roomId, 'room_canonical')
      assert.deepEqual(invalidation?.messageIds, messageIds)
      assert.equal(invalidationCoversMessage(invalidation, 'room_canonical', 'msg_7'),
        messageIds === null || messageIds.includes('msg_7'))
      assert.equal(invalidationCoversMessage(invalidation, 'room_canonical', 'msg_8'), messageIds === null)
      assert.equal(invalidationCoversMessage(invalidation, 'another_room', 'msg_7'), false)
    }
    assert.equal(reconciles, 0, 'valid room-wide invalidation must not initiate a snapshot repair')
    const lastInvalidation = lastMessageInfoInvalidation.value
    stream.stop()
    stream.start(alias)
    const replacement = FakeEventSource.instances.at(-1)!
    assert.equal(new URL(replacement.url, 'https://example.test').searchParams.get('event_cursor'), 'broker_info')
    source.dispatch('message_info_updated', { room_id: 'room_canonical', message_ids: null }, 'broker_stale')
    assert.equal(lastMessageInfoInvalidation.value, lastInvalidation, 'a retired stream cannot invalidate an open card')
  } finally {
    stream.stop()
    lastMessageInfoInvalidation.value = null
  }
})

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
    reconcileFullState: async () => true,
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
    reconcileFullState: async () => true,
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

test('a retired same-room EventSource cannot mutate or close its replacement', () => {
  const appliedTasks: string[] = []
  const states: string[] = []
  const stream = createRoomStream({
    setConnectionState: (state) => { states.push(state) },
    setStreaming: () => {},
    appendMessage: () => true,
    onGitHubMessage: () => {},
    onGitHubEvent: () => {},
    onTaskLifecycleMessage: () => {},
    onArtifactUpdate: () => {},
    onAgentActivityMessage: () => {},
    onParticipantActivityMessage: () => {},
    upsertTask: (task) => { appliedTasks.push(task.id) },
    upsertReasoningSession: () => {},
    removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => true,
  })

  void stream.start('room_same')
  const retired = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  void stream.start('room_same')
  const replacement = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  const instanceCount = FakeEventSource.instances.length

  retired.dispatch('task_update', { id: 'stale-task' }, 'broker_stale')
  retired.onerror?.()
  assert.deepEqual(appliedTasks, [])
  assert.equal(replacement.closed, false)
  assert.equal(FakeEventSource.instances.length, instanceCount, 'stale errors cannot schedule reconnects')
  assert.notEqual(states.at(-1), 'error')
  stream.stop()
})

test('a same-room restart never reuses an older generation resync to authorize a gap cursor', async () => {
  let releaseRetiredResync!: () => void
  const retiredResyncGate = new Promise<void>((resolve) => { releaseRetiredResync = resolve })
  const resyncs: Array<{ after: string | null; authoritativeGap: boolean }> = []
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
    getMessageCursor: () => 'msg_before_gap',
    resyncMessages: async (_roomIdentifier, after, authoritativeGap) => {
      resyncs.push({ after, authoritativeGap })
      if (resyncs.length === 1) await retiredResyncGate
      return { success: true, cursor: after }
    },
    reconcileFullState: async () => true,
  })

  stream.start('room_same_generation')
  const retired = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  retired.dispatch('room_sync', { gap: true, event_cursor: 'broker_retired_gap' })
  await waitFor(() => resyncs.length === 1)

  stream.start('room_same_generation')
  const replacement = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  replacement.dispatch('room_sync', { gap: true, event_cursor: 'broker_current_gap' })
  releaseRetiredResync()
  await waitFor(() => resyncs.length === 2)
  assert.deepEqual(resyncs, [
    { after: 'msg_before_gap', authoritativeGap: true },
    { after: 'msg_before_gap', authoritativeGap: true },
  ], 'the replacement generation starts its own authoritative repair')
  await new Promise<void>((resolve) => setImmediate(resolve))
  stream.stop()
  stream.start('room_same_generation')
  const resumed = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(
    resumed.url,
    '/rooms/room_same_generation/messages/stream?event_cursor=broker_current_gap',
    'only the current generation may commit its repaired broker cursor',
  )
  stream.stop()
})

test('room stream preserves broker cursors and performs one full repair per gap burst', async () => {
  const reconciles: string[] = []
  let durableRepairs = 0
  let releaseReconcile!: () => void
  const reconcileGate = new Promise<void>((resolve) => { releaseReconcile = resolve })
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
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => {
      durableRepairs += 1
      return { success: true, cursor: after }
    },
    reconcileFullState: async (roomIdentifier) => {
      reconciles.push(roomIdentifier)
      await reconcileGate
      return true
    },
  })

  stream.start('room_cursor')
  const initialSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  initialSource.dispatch('task_update', { id: 'task_1' }, 'broker_7')
  initialSource.dispatch('room_sync', { gap: true, event_cursor: 'broker_8' })
  initialSource.dispatch('room_sync', { gap: true, event_cursor: 'broker_8' })
  initialSource.dispatch('task_update', { id: 'task_2' }, 'broker_9')
  initialSource.dispatchRaw('task_update', '{malformed', 'broker_999')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(reconciles, ['room_cursor'])
  assert.equal(durableRepairs, 1, 'a broker gap immediately reconciles durable message history')

  stream.stop()
  stream.start('room_cursor')
  const resumedSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(
    resumedSource.url,
    '/rooms/room_cursor/messages/stream?event_cursor=broker_7',
    'the gap cursor is not committed before its full repair succeeds',
  )
  releaseReconcile()
  await waitFor(() => reconciles.length === 2 && durableRepairs === 2)
  assert.deepEqual(reconciles, ['room_cursor', 'room_cursor'], 'a gap during repair gets one trailing pass')
  assert.equal(durableRepairs, 2)
  stream.stop()
  stream.start('room_cursor')
  const repairedSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(repairedSource.url, '/rooms/room_cursor/messages/stream?event_cursor=broker_9')
  repairedSource.dispatch('room_sync', { gap: true, event_cursor: null })
  await waitFor(() => reconciles.length === 3 && durableRepairs === 3)
  await new Promise<void>((resolve) => setImmediate(resolve))
  stream.stop()
  stream.start('room_cursor')
  const resetSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(resetSource.url, '/rooms/room_cursor/messages/stream')
  stream.stop()
})

test('a semantically malformed typed frame repairs without committing its broker cursor', async () => {
  const reconciles: string[] = []
  const stream = createRoomStream({
    setConnectionState: () => {}, setStreaming: () => {}, appendMessage: () => true,
    onGitHubMessage: () => {}, onGitHubEvent: () => {}, onTaskLifecycleMessage: () => {},
    onArtifactUpdate: () => {}, onAgentActivityMessage: () => {}, onParticipantActivityMessage: () => {},
    upsertTask: () => {}, upsertReasoningSession: () => {}, removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async (roomIdentifier) => { reconciles.push(roomIdentifier); return false },
  })
  stream.start('room_malformed')
  const initial = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  initial.dispatch('task_update', { id: 'task_valid' }, 'broker_valid')
  for (const [eventName, data] of [
    ['task_update', '{"status":"open"}'],
    ['github_event', '{malformed'],
    ['artifact_update', '{malformed'],
    ['message_info_updated', '{malformed'],
    ['message_info_updated', '{}'],
    ['message_info_updated', '{"message_ids":false}'],
    ['message_info_updated', '{"message_ids":7}'],
    ['message_info_updated', '{"message_ids":"bad"}'],
    ['message_info_updated', '{"message_ids":["msg_1",7]}'],
    ['message_info_updated', '{"message_ids":[""]}'],
  ]) initial.dispatchRaw(eventName, data, `broker_malformed_${eventName}`)
  await waitFor(() => reconciles.length > 0)
  stream.stop()
  stream.start('room_malformed')
  const resumed = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(
    resumed.url,
    '/rooms/room_malformed/messages/stream?event_cursor=broker_valid',
    'an unapplied typed frame cannot become a reconnect boundary',
  )
  stream.stop()
})

test('room stream replays typed events received over an older gap snapshot', async () => {
  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })
  let snapshotStarted = false
  let renderedTask = ''
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
    upsertTask: (task) => { renderedTask = task.id },
    upsertReasoningSession: () => {},
    removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => {
      snapshotStarted = true
      await snapshotGate
      renderedTask = 'snapshot-v1'
      return true
    },
  })

  stream.start('room_snapshot_race')
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  source.dispatch('room_sync', { gap: true, event_cursor: 'broker_1' })
  await waitFor(() => snapshotStarted)
  source.dispatch('task_update', { id: 'live-v2' }, 'broker_2')
  assert.equal(renderedTask, '', 'live state stays buffered until the older snapshot lands')

  releaseSnapshot()
  await waitFor(() => renderedTask === 'live-v2')
  stream.stop()
  stream.start('room_snapshot_race')
  const resumedSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(
    resumedSource.url,
    '/rooms/room_snapshot_race/messages/stream?event_cursor=broker_2',
  )
  stream.stop()
})

test('room stream retries a gap until both repair lanes recover', async () => {
  let messageRepairs = 0
  let fullRepairs = 0
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
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => {
      messageRepairs += 1
      return { success: messageRepairs > 1, cursor: after }
    },
    reconcileFullState: async () => {
      fullRepairs += 1
      return fullRepairs > 1
    },
  }, { gapRepairRetryMs: 1 })

  stream.start('room_retry')
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  source.dispatch('room_sync', { gap: true, event_cursor: 'broker_repaired' })
  await waitFor(() => messageRepairs === 2 && fullRepairs === 2)
  stream.stop()
  stream.start('room_retry')
  const resumedSource = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(
    resumedSource.url,
    '/rooms/room_retry/messages/stream?event_cursor=broker_repaired',
  )
  stream.stop()
})

test('room stream subscribes before bootstrap and replays every typed resource over the snapshot', async () => {
  const previousInvalidation = lastMessageInfoInvalidation.value
  const applied: string[] = []
  const stream = createRoomStream({
    setConnectionState: () => {},
    setStreaming: () => {},
    appendMessage: () => { applied.push('message'); return true },
    onGitHubMessage: () => {},
    onGitHubEvent: () => { applied.push('github') },
    onTaskLifecycleMessage: () => {},
    onArtifactUpdate: () => { applied.push('artifact') },
    onAgentActivityMessage: () => { applied.push('presence') },
    onParticipantActivityMessage: () => {},
    upsertTask: () => { applied.push('task') },
    upsertReasoningSession: () => { applied.push('reasoning') },
    removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => true,
  }, { bootstrapBarrierTimeoutMs: 100 })

  const barrier = stream.start('room_bootstrap', true)
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  source.dispatch('task_update', { id: 'task-live' }, 'broker_1')
  source.dispatch('artifact_update', { room_id: 'room_bootstrap' }, 'broker_2')
  source.dispatch('reasoning_update', { session: { id: 'reason-live' } }, 'broker_3')
  source.dispatch('github_event', { room_id: 'room_bootstrap' }, 'broker_4')
  source.dispatch('message', { id: 'msg_live', source: 'agent', sender: 'agent' }, 'broker_5')
  source.dispatch('message_info_updated', { room_id: 'room_bootstrap', message_ids: null }, 'broker_6')
  assert.deepEqual(applied, [], 'typed resources remain behind the startup snapshot boundary')
  assert.equal(lastMessageInfoInvalidation.value, previousInvalidation, 'info refresh also waits for the installed snapshot')

  source.dispatch('room_sync', { gap: false, event_cursor: 'broker_6' })
  await barrier
  ;(applied as string[]).push('snapshot')
  stream.finishBootstrap('room_bootstrap', true)
  assert.equal(lastMessageInfoInvalidation.value?.roomId, 'room_bootstrap')
  assert.equal(lastMessageInfoInvalidation.value?.messageIds, null)
  assert.deepEqual(applied, [
    'snapshot',
    'task', 'artifact', 'artifact', 'reasoning', 'github', 'message', 'presence',
  ])

  stream.stop()
  stream.start('room_bootstrap')
  const resumed = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  assert.equal(resumed.url, '/rooms/room_bootstrap/messages/stream?event_cursor=broker_6')
  stream.stop()
  lastMessageInfoInvalidation.value = null
})

test('room bootstrap byte overflow releases bodies and forces one authoritative repair', async () => {
  let repairs = 0
  const applied: string[] = []
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
    upsertTask: (task) => { applied.push(task.id) },
    upsertReasoningSession: () => {},
    removeReasoningSession: () => {},
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => ({ success: true, cursor: after }),
    reconcileFullState: async () => { repairs += 1; return true },
  }, {
    bootstrapBarrierTimeoutMs: 100,
    gapBufferMaxEvents: 256,
    gapBufferMaxBytes: 1024 * 1024,
  })

  const barrier = stream.start('room_bootstrap_overflow', true)
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  source.dispatch('room_sync', { gap: false, event_cursor: 'broker_0' })
  await barrier
  for (let index = 0; index < 256; index += 1) {
    source.dispatch('task_update', { id: `task_${index}`, body: 'x'.repeat(100 * 1024) }, `broker_${index + 1}`)
  }
  stream.finishBootstrap('room_bootstrap_overflow', true)
  await waitFor(() => repairs === 1)
  assert.deepEqual(applied, [], 'overflowed closures and their large bodies are physically released')
  stream.stop()
})

test('room bootstrap timeout waits for an installed stream before authoritative repair', async () => {
  let fullRepairs = 0
  let messageRepairs = 0
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
    getMessageCursor: () => null,
    resyncMessages: async (_roomIdentifier, after) => {
      messageRepairs += 1
      return { success: true, cursor: after }
    },
    reconcileFullState: async () => {
      fullRepairs += 1
      return true
    },
  }, { bootstrapBarrierTimeoutMs: 1 })

  const barrier = stream.start('room_bootstrap_timeout', true)
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  await barrier
  stream.finishBootstrap('room_bootstrap_timeout', true)
  assert.equal(fullRepairs, 0, 'repair cannot race ahead of server-side subscription setup')
  assert.equal(messageRepairs, 0)

  source.onopen?.()
  await waitFor(() => fullRepairs === 1 && messageRepairs === 1)
  stream.stop()
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for room stream state')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
