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
    activity_state: 'online',
    source_flags: ['presence'],
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
    activity_state: 'online',
    source_flags: ['presence'],
    created_at: '2026-04-22T17:00:00.000Z',
    updated_at: '2026-04-22T17:00:00.000Z',
    ...overrides,
  }
}

test('buildMentionCandidates only includes live non-hidden agents and visible humans', () => {
  const candidates = buildMentionCandidates({
    participants: [
      makeParticipant({ display_name: 'LiveOak', activity_state: 'online' }),
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'stale',
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
        activity_state: 'online',
        source_flags: ['presence'],
      }),
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        freshness: 'stale',
        activity_state: 'stale',
        source_flags: ['presence'],
      }),
    ],
    senderName: 'OwlSolar',
  })

  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ['@LiveOak', '@EmmyMay'],
  )
  assert.equal(candidates[0]?.meta.includes('Online now'), true)
})

test('buildMentionCandidates treats active presence as online even when participant history is stale', () => {
  const candidates = buildMentionCandidates({
    participants: [
      makeParticipant({
        activity_state: 'historical',
      }),
    ],
    presence: [
      makePresence({
        freshness: 'active',
        activity_state: 'historical',
      }),
    ],
    senderName: 'OwlSolar',
  })

  assert.deepEqual(
    candidates.map((candidate) => candidate.label),
    ['@LiveOak'],
  )
})

test('buildAgentReachabilitySources merges live presence into participant history', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        participant_key: 'agent:ghostash | emmymay\'s agent | agent',
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        activity_state: 'stale',
      }),
    ],
    presence: [
      makePresence({
        actor_label: 'GhostAsh | EmmyMay\'s agent | Agent',
        display_name: 'GhostAsh',
        freshness: 'stale',
        activity_state: 'stale',
        source_flags: ['presence'],
      }),
      makePresence({
        actor_label: 'LiveOak | EmmyMay\'s agent | Agent',
        display_name: 'LiveOak',
        freshness: 'active',
        activity_state: 'online',
        source_flags: ['presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [
      ['GhostAsh | EmmyMay\'s agent | Agent', 'stale'],
      ['LiveOak | EmmyMay\'s agent | Agent', 'online'],
    ],
  )
  assert.equal(sources[1]?.participant, null)
})

test('buildAgentReachabilitySources keeps stale presence in the recently offline lane', () => {
  const sources = buildAgentReachabilitySources({
    participants: [
      makeParticipant({
        activity_state: 'historical',
        source_flags: ['messages'],
      }),
    ],
    presence: [
      makePresence({
        freshness: 'stale',
        activity_state: 'historical',
        source_flags: ['presence'],
      }),
    ],
  })

  assert.deepEqual(
    sources.map((source) => [source.actorLabel, source.activityState]),
    [['LiveOak | EmmyMay\'s agent | Agent', 'stale']],
  )
})
