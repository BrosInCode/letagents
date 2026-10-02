import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'

import type { RoomAgentPresence } from '../src/composables/room/types/presence'
import {
  advancePresenceTracker,
  createPresenceTracker,
  mergePresenceChips,
  PRESENCE_CHIP_LIMIT,
  PRESENCE_CHIP_SETTLE_MS,
  PRESENCE_CHIP_VISIBLE_MS,
  PRESENCE_DISCONNECT_CONFIRM_MS,
  reachableAgents,
  type PresenceChip,
} from '../src/components/room/composer/presenceChips'
import { usePresenceChips } from '../src/components/room/composer/usePresenceChips'

function presence(name: string, overrides: Partial<RoomAgentPresence> = {}): RoomAgentPresence {
  return {
    room_id: 'room_1',
    actor_label: `${name} | EmmyMay's agent | Claude Code`,
    agent_key: `EmmyMay/${name.toLowerCase()}`,
    agent_instance_id: null,
    agent_session_id: `session_${name}`,
    session_kind: 'worker',
    runtime: 'claude-code',
    display_name: name,
    owner_label: 'EmmyMay',
    ide_label: 'Claude Code',
    status: 'idle',
    status_text: null,
    last_heartbeat_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    freshness: 'active',
    activity_state: 'away',
    source_flags: ['delivery'],
    liveness_observation: null,
    ...overrides,
  } as RoomAgentPresence
}

test('only reachable workers count as connected, keyed by the room name', () => {
  const agents = reachableAgents([
    presence('MossDawn'),
    presence('MossDawn', { agent_session_id: 'session_new', agent_key: null }),
    presence('Stale', { freshness: 'stale' }),
    presence('Controller', { session_kind: 'controller' }),
    presence('NoChannel', { source_flags: ['messages'] }),
    presence('Plain', { ide_label: 'Agent' }),
  ])
  assert.deepEqual([...agents.keys()], ['mossdawn', 'plain'])
  assert.equal(agents.get('plain')?.ideLabel, null, 'a generic label shows the dot, not a badge')
})

test('a connect is reported at once; a disconnect only after the agent stays away', () => {
  const names = (changes: ReturnType<typeof advancePresenceTracker>) =>
    changes.map((change) => `${change.agent.displayName}:${change.kind}`)
  const tracker = createPresenceTracker(reachableAgents([presence('MossDawn'), presence('NobleMoon')]))

  // A reconnect under a new session is the same agent.
  assert.deepEqual(names(advancePresenceTracker(
    tracker,
    reachableAgents([presence('MossDawn', { agent_session_id: 'session_new' }), presence('NobleMoon')]),
    0,
  )), [])

  // One refresh without MossDawn (a failed fetch, a busy agent) says nothing.
  const without = reachableAgents([presence('NobleMoon'), presence('TimberBadger')])
  assert.deepEqual(names(advancePresenceTracker(tracker, without, 1_000)), ['TimberBadger:connected'])
  assert.deepEqual(names(advancePresenceTracker(tracker, without, 1_000 + PRESENCE_DISCONNECT_CONFIRM_MS - 1)), [])
  assert.deepEqual(
    names(advancePresenceTracker(tracker, without, 1_000 + PRESENCE_DISCONNECT_CONFIRM_MS)),
    ['MossDawn:disconnected'],
  )

  // A failed fetch returns an empty roster: one empty refresh shows no chips.
  assert.deepEqual(names(advancePresenceTracker(tracker, new Map(), 60_000)), [])
  assert.deepEqual(names(advancePresenceTracker(tracker, without, 90_000)), [])
})

test('an agent has one chip and the row is capped', () => {
  const chip = (key: string, kind: PresenceChip['kind'], id: string): PresenceChip =>
    ({ id, key, kind, displayName: key, ideLabel: null })
  assert.deepEqual(
    mergePresenceChips([chip('a', 'disconnected', '1')], [chip('a', 'connected', '2')]).map((entry) => entry.id),
    ['2'],
  )
  const many = mergePresenceChips([], ['a', 'b', 'c', 'd', 'e'].map((key, index) => chip(key, 'connected', String(index))))
  assert.equal(many.length, PRESENCE_CHIP_LIMIT)
  assert.equal(many.at(-1)?.key, 'e')
})

test('chips wait for presence to load, then show changes and dismiss themselves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const list = ref<RoomAgentPresence[]>([])
  const room = ref('room_1')
  const ready = ref(false)
  const scope = effectScope()
  const { chips } = scope.run(() => usePresenceChips({
    presence: () => list.value,
    scope: () => room.value,
    ready: () => ready.value,
  }))!
  const shown = () => chips.value.map((chip) => `${chip.displayName}:${chip.kind}`)

  // A slow room open: the roster arrives long after the composer mounted.
  t.mock.timers.tick(30_000)
  list.value = [presence('MossDawn'), presence('NobleMoon')]
  ready.value = true
  await nextTick()
  assert.deepEqual(shown(), [], 'the roster a room opens with announces nobody')

  t.mock.timers.tick(PRESENCE_CHIP_SETTLE_MS + 1)
  list.value = [presence('MossDawn'), presence('NobleMoon'), presence('TimberBadger')]
  await nextTick()
  assert.deepEqual(shown(), ['TimberBadger:connected'])
  t.mock.timers.tick(PRESENCE_CHIP_VISIBLE_MS + 1)
  assert.deepEqual(shown(), [], 'a chip dismisses itself')

  // MossDawn goes missing: nothing yet, then a chip once it has stayed away.
  list.value = [presence('NobleMoon'), presence('TimberBadger')]
  await nextTick()
  assert.deepEqual(shown(), [])
  // Confirmed by time alone: no further refresh has to arrive.
  t.mock.timers.tick(PRESENCE_DISCONNECT_CONFIRM_MS)
  assert.deepEqual(shown(), ['MossDawn:disconnected'])

  // An agent that returns before the confirmation gets no chip at all.
  t.mock.timers.tick(PRESENCE_CHIP_VISIBLE_MS + 1)
  list.value = [presence('TimberBadger')]
  await nextTick()
  t.mock.timers.tick(PRESENCE_DISCONNECT_CONFIRM_MS - 1_000)
  list.value = [presence('NobleMoon'), presence('TimberBadger')]
  await nextTick()
  t.mock.timers.tick(PRESENCE_DISCONNECT_CONFIRM_MS)
  assert.deepEqual(shown(), [])

  // Switching rooms starts over: the new room's roster is a baseline again.
  room.value = 'room_2'
  list.value = [presence('Elsewhere')]
  await nextTick()
  assert.deepEqual(shown(), [])
  scope.stop()
})
