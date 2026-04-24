import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomAgentPresence, RoomParticipant } from '../src/composables/useRoom'

Object.assign(globalThis, {
  localStorage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
})

const { buildAgentReachabilitySources, buildMentionCandidates } = await import('../src/components/room/reachability')

function makePresence(overrides: Partial<RoomAgentPresence>): RoomAgentPresence {
  return {
    room_id: 'focus_16',
    actor_label: 'LiveOak | EmmyMay\'s agent | Agent',
    agent_key: 'EmmyMay/liveoak',
    display_name: 'LiveOak',
    owner_label: 'EmmyMay',
    ide_label: 'Agent',
    status: 'working',
    status_text: 'working on it',
    last_heartbeat_at: '2026-04-22T17:00:00.000Z',
    created_at: '2026-04-22T17:00:00.000Z',
    updated_at: '2026-04-22T17:00:00.000Z',
    freshness: 'active',
    activity_state: 'active',
    source_flags: ['delivery', 'presence'],
    ...overrides,
  }
}

function makeParticipant(overrides: Partial<RoomParticipant>): RoomParticipant {
  return {
    room_id: 'focus_16',
    participant_key: 'agent:liveoak | emmymay\'s agent | agent',
    kind: 'agent',
    actor_label: 'LiveOak | EmmyMay\'s agent | Agent',
    agent_key: 'EmmyMay/liveoak',
    github_login: null,
    display_name: 'LiveOak',
    owner_label: 'EmmyMay',
    ide_label: 'Agent',
    hidden_at: null,
    hidden_by: null,
    last_seen_at: '2026-04-22T17:00:00.000Z',
    last_room_activity_at: '2026-04-22T17:00:00.000Z',
    last_live_heartbeat_at: '2026-04-22T17:00:00.000Z',
    activity_state: 'active',
    source_flags: ['delivery', 'presence'],
    created_at: '2026-04-22T17:00:00.000Z',
    updated_at: '2026-04-22T17:00:00.000Z',
    ...overrides,
  }
}

test('buildMentionCandidates only includes live non-hidden agents and visible humans', () => {
  const candidates = buildMentionCandidates({
    participants: [
      makeParticipant({ display_name: 'LiveOak', activity_state: 'active' }),
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'away',
      }),
      makeParticipant({
        participant_key: 'human:login:emmymay',
        kind: 'human',
        actor_label: null,
        agent_key: null,
        github_login: 'EmmyMay',
        display_name: 'EmmyMay',
        owner_label: null,
        ide_label: null,
        activity_state: null,
        source_flags: ['messages'],
      }),
    ],
    presence: [
      makePresence({
        actor_label: 'LiveOak | EmmyMay\'s agent | Agent',
        display_name: 'LiveOak',
        freshness: 'active',
        activity_state: 'active',
        source_flags: ['delivery', 'presence'],
      }),
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        status: 'idle',
        status_text: 'available in room',
        freshness: 'active',
        activity_state: 'away',
        source_flags: ['delivery', 'presence'],
      }),
    ],
    senderName: 'OwlSolar',
  })

  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ['@LiveOak', '@GhostAsh', '@EmmyMay'],
  )
  assert.equal(candidates[0]?.meta.includes('Active in room'), true)
  assert.equal(candidates[1]?.meta.includes('Away but reachable'), true)
})

test('buildMentionCandidates treats active presence as reachable even when participant history is offline', () => {
  const candidates = buildMentionCandidates({
    participants: [
      makeParticipant({
        activity_state: 'offline',
      }),
    ],
    presence: [
      makePresence({
        freshness: 'active',
        activity_state: 'active',
      }),
    ],
    senderName: 'OwlSolar',
  })

  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ['@LiveOak'],
  )
})

test('buildMentionCandidates excludes status-only presence without delivery reachability', () => {
  const candidates = buildMentionCandidates({
    participants: [
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'away',
        source_flags: ['presence'],
      }),
    ],
    presence: [
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        status: 'idle',
        status_text: 'available in room',
        freshness: 'active',
        activity_state: 'away',
        source_flags: ['presence'],
      }),
    ],
    senderName: 'OwlSolar',
  })

  assert.deepEqual(candidates, [])
})

test('buildAgentReachabilitySources merges live presence into participant history', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'offline',
      }),
    ],
    presence: [
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        freshness: 'stale',
        activity_state: 'offline',
        source_flags: ['delivery', 'presence'],
      }),
      makePresence({
        actor_label: 'LiveOak | EmmyMay\'s agent | Agent',
        display_name: 'LiveOak',
        freshness: 'active',
        activity_state: 'active',
        source_flags: ['delivery', 'presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [
      ['GhostAsh | EmmyMay\'s agent | Agent', 'offline'],
      ['LiveOak | EmmyMay\'s agent | Agent', 'active'],
    ],
  )
  assert.equal(sources[1]?.participant, null)
})

test('buildAgentReachabilitySources treats status-only active presence as offline history', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'away',
        source_flags: ['presence'],
      }),
    ],
    presence: [
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        freshness: 'active',
        activity_state: 'away',
        source_flags: ['presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [['GhostAsh | EmmyMay\'s agent | Agent', 'offline']],
  )
})

test('buildAgentReachabilitySources keeps stale presence in the offline lane', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        activity_state: 'offline',
        source_flags: ['messages'],
      }),
    ],
    presence: [
      makePresence({
        freshness: 'stale',
        activity_state: 'offline',
        source_flags: ['delivery', 'presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [['LiveOak | EmmyMay\'s agent | Agent', 'offline']],
  )
})

test('buildAgentReachabilitySources keeps canonical offline presence without a participant row', () => {
  const sources = buildAgentReachabilitySources({
    participants: [],
    presence: [
      makePresence({
        freshness: 'stale',
        activity_state: 'offline',
        source_flags: ['delivery', 'presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [['LiveOak | EmmyMay\'s agent | Agent', 'offline']],
  )
  assert.equal(sources[0]?.participant, null)
})

test('buildAgentReachabilitySources normalizes legacy participant-only offline states', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        activity_state: 'offline' as RoomParticipant['activity_state'],
        source_flags: ['messages'],
      }),
      {
        ...makeParticipant({
          participant_key: 'agent:ghostash | emmymay\'s agent | agent',
          actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
          display_name: 'GhostAsh',
          source_flags: ['messages'],
        }),
        activity_state: 'historical' as RoomParticipant['activity_state'],
      },
    ],
    presence: [],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [
      ['LiveOak | EmmyMay\'s agent | Agent', 'offline'],
      ['GhostAsh | EmmyMay\'s agent | Agent', 'offline'],
    ],
  )
})

test('buildAgentReachabilitySources does not surface message-only fallback ghosts as offline', () => {
  const sources = buildAgentReachabilitySources({
    participants: [],
    presence: [
      makePresence({
        freshness: 'stale',
        activity_state: 'offline',
        source_flags: ['messages'],
      }),
    ],
  })

  assert.deepEqual(sources, [])
})
