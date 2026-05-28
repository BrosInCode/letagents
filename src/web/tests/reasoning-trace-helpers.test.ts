import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomReasoningSession } from '../src/composables/useRoom'
import {
  buildCurrentSnapshot,
  buildHighlights,
  buildTimelineEntries,
  entryLabel,
  formatTimestamp,
  mergeReasoningSessionDetail,
  resolveStreamState,
} from '../src/components/room/reasoning-trace/reasoningTrace'

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
  const blocked = reasoningSession({ status: 'blocked' })
  const live = reasoningSession({ status: 'working' })

  assert.equal(resolveStreamState(blocked, buildCurrentSnapshot(blocked), false, false), 'blocked')
  assert.equal(resolveStreamState(live, buildCurrentSnapshot(live), false, false), 'live')
  assert.equal(entryLabel({ id: 'x', label: 'next_action', text: 'x', timestamp: '' }), 'Next Action')
  assert.notEqual(formatTimestamp('2026-05-28T03:04:00.000Z'), 'unknown')
  assert.equal(formatTimestamp('not-a-date'), 'unknown')
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
