import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatLastSeen,
  latestTimestamp,
  previewMessage,
  reasoningTimestamp,
  sortTasksByUpdated,
} from '../src/components/room/activity/time'

test('previewMessage compacts long message bodies', () => {
  assert.equal(previewMessage(''), 'No message body')
  assert.equal(previewMessage(' hello   world '), 'hello world')
  assert.equal(previewMessage('x'.repeat(170)), `${'x'.repeat(157)}...`)
})

test('latestTimestamp ignores missing and invalid values', () => {
  assert.equal(
    latestTimestamp(
      null,
      'bad date',
      '2026-05-27T10:00:00.000Z',
      '2026-05-27T11:00:00.000Z',
    ),
    '2026-05-27T11:00:00.000Z',
  )
})

test('sortTasksByUpdated keeps newest tasks first', () => {
  assert.deepEqual(
    sortTasksByUpdated([
      { id: 'old', updated_at: '2026-05-27T09:00:00.000Z' },
      { id: 'new', updated_at: '2026-05-27T12:00:00.000Z' },
    ]).map((task) => task.id),
    ['new', 'old'],
  )
})

test('reasoningTimestamp falls back through session timestamp fields', () => {
  assert.equal(
    reasoningTimestamp({
      entries: [{ timestamp: '2026-05-27T13:00:00.000Z' }],
    } as never),
    '2026-05-27T13:00:00.000Z',
  )
})

test('formatLastSeen returns relative labels from Date.now', () => {
  const originalNow = Date.now
  Date.now = () => Date.parse('2026-05-27T14:00:00.000Z')
  try {
    assert.equal(formatLastSeen('2026-05-27T13:59:40.000Z'), 'just now')
    assert.equal(formatLastSeen('2026-05-27T13:45:00.000Z'), '15m ago')
    assert.equal(formatLastSeen('2026-05-27T12:00:00.000Z'), '2h ago')
    assert.equal(formatLastSeen('2026-05-25T14:00:00.000Z'), '2d ago')
  } finally {
    Date.now = originalNow
  }
})
