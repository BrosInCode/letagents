import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomReasoningSession } from '../src/composables/useRoom'
import {
  buildCurrentSnapshot,
  buildHighlights,
  buildCurrentLiveTimelineEntry,
  buildTimelineEntries,
  classifyReasoningStream,
  formatTimestamp,
  mergeReasoningSessionDetail,
} from '../src/components/room/reasoning-trace/reasoningTrace'
import { reasoningLabel } from '../../../shared/ui/reasoning/reasoning-trace'

test('mergeReasoningSessionDetail preserves fetched updates and sorts incoming updates', () => {
  const existing = reasoningSession({
    id: 'reasoning_1',
    updates: [
      update('update_2', 'Second', '2026-05-28T02:00:00.000Z'),
    ],
  })
  const incoming = reasoningSession({
    id: 'reasoning_1',
    summary: 'latest summary',
    updates: [
      update('update_1', 'First', '2026-05-28T01:00:00.000Z'),
      update('update_2', 'Second replacement', '2026-05-28T02:00:00.000Z'),
    ],
  })

  const merged = mergeReasoningSessionDetail(existing, incoming)

  assert.equal(merged.summary, 'latest summary')
  assert.deepEqual(
    merged.updates?.map((item) => [item.id, item.summary]),
    [
      ['update_1', 'First'],
      ['update_2', 'Second replacement'],
    ],
  )
})

test('reasoning trace helpers synthesize snapshot highlights and timeline entries', () => {
  const session = reasoningSession({
    id: 'reasoning_2',
    summary: 'Working through the issue',
    goal: 'Fix the bug',
    checking: 'Regression test',
    confidence: 0.76,
    updated_at: '2026-05-28T03:00:00.000Z',
  })

  const snapshot = buildCurrentSnapshot(session)
  const highlights = buildHighlights(session, snapshot)
  const timeline = buildTimelineEntries(session, snapshot, [])

  assert.equal(snapshot?.summary, 'Working through the issue')
  assert.deepEqual(
    highlights.map((item) => [item.label, item.value]),
    [
      ['Goal', 'Fix the bug'],
      ['Checking', 'Regression test'],
      ['Confidence', '76%'],
    ],
  )
  assert.deepEqual(
    timeline.map((item) => [item.id, item.label, item.text]),
    [
      ['reasoning_2-summary', 'Summary', 'Working through the issue'],
      ['reasoning_2-goal', 'Goal', 'Fix the bug'],
      ['reasoning_2-checking', 'Checking', 'Regression test'],
    ],
  )
})

test('reasoning trace labels stream states and timestamps consistently', () => {
  const stream = (session: RoomReasoningSession) => {
    const snapshot = buildCurrentSnapshot(session)
    return classifyReasoningStream({ status: snapshot?.status || session.status, summary: snapshot?.summary, checking: snapshot?.checking })
  }

  assert.equal(stream(reasoningSession({ status: 'blocked' })).state, 'blocked')
  assert.equal(stream(reasoningSession({ status: 'working' })).state, 'live')
  assert.equal(reasoningLabel('next_action'), 'Next Action')
  assert.notEqual(formatTimestamp('2026-05-28T03:04:00.000Z'), 'unknown')
  assert.equal(formatTimestamp('not-a-date'), 'unknown')
})

test('web stream state: blocked outranks the Codex text guess, and a silent live stream reads as stale', () => {
  // The web used to let "reasoning summary" text win over an explicit blocked status.
  const blocked = classifyReasoningStream({ status: 'blocked', summary: 'Readable reasoning summary: waiting on a key' })
  assert.equal(blocked.state, 'blocked')
  const updatedAt = '2026-05-28T00:00:00.000Z'
  const fresh = classifyReasoningStream({ status: 'working', updatedAt, now: Date.parse(updatedAt) + 60_000 })
  assert.equal(fresh.state, 'live')
  const stale = classifyReasoningStream({ status: 'working', updatedAt, now: Date.parse(updatedAt) + 10 * 60_000 })
  assert.deepEqual([stale.state, stale.label], ['recent', 'Stale'])
})

test('timeline sorts by time before it joins repeats, and the joined entry keeps the live mark', () => {
  const session = reasoningSession({
    id: 'reasoning_3',
    status: 'working',
    updated_at: '2026-05-28T03:00:00.000Z',
    // Out of time order on purpose: the two "Same text" updates are neighbours only after sorting.
    updates: [
      update('u3', 'Same text', '2026-05-28T03:00:00.000Z'),
      update('u1', 'Other text', '2026-05-28T01:00:00.000Z'),
      update('u2', 'Same text', '2026-05-28T02:00:00.000Z'),
    ],
  })
  const snapshot = buildCurrentSnapshot(session)
  const live = buildCurrentLiveTimelineEntry(session, snapshot, 'Same text')
  const timeline = buildTimelineEntries(session, snapshot, live)
  assert.deepEqual(timeline.map((entry) => [entry.label, entry.text, Boolean(entry.current)]), [
    ['Working', 'Other text', false],
    ['Working', 'Same text', true],
  ])
})

function reasoningSession(overrides: Partial<RoomReasoningSession> = {}): RoomReasoningSession {
  return {
    id: 'reasoning_1',
    actor_label: 'Codex Agent | Codex',
    status: null,
    summary: null,
    latest_payload: null,
    updates: null,
    entries: null,
    created_at: '2026-05-28T00:00:00.000Z',
    updated_at: '2026-05-28T00:00:00.000Z',
    ...overrides,
  }
}

function update(id: string, summary: string, created_at: string) {
  return {
    id,
    summary,
    created_at,
    status: 'working',
    milestone: null,
    payload: null,
  }
}
