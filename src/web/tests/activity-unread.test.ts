import assert from 'node:assert/strict'
import test from 'node:test'
import { createActivityUnread } from '../../../shared/ui/activity/unread'

test('Activity counts unique deliveries independently of initial history and older pages', () => {
  const unread = createActivityUnread()
  unread.setScope('viewer-a')
  unread.receive('room-a', ['workflow-1', 'review-comment-1', 'review-thread-1'])
  unread.observeLatest('room-a', ['historic-pr', 'workflow-1'])
  assert.equal(unread.count('room-a'), 3, 'initial snapshot cannot swallow a concurrent delivery')
  unread.receive('room-a', ['workflow-1', 'historic-pr'])
  assert.equal(unread.count('room-a'), 3, 'replayed canonical IDs are not new deliveries')
  unread.observeHistory('room-a', ['older-pr', 'older-check'])
  unread.observeLatest('room-a', ['historic-pr', 'older-pr', 'catchup-review', 'catchup-check'])
  assert.equal(unread.count('room-a'), 5, 'latest catchup counts every new ID, without a 30-second cutoff')
  unread.acknowledge('room-a', ['workflow-1', 'catchup-review'])
  assert.equal(unread.count('room-a'), 3, 'a filtered presentation acknowledges only its own IDs')
  unread.receive('room-a', ['workflow-1'])
  assert.equal(unread.count('room-a'), 3, 'a read delivery stays read on replay')
})

test('Activity survives room switches, never leaks accounts, and does not cap real counts', () => {
  const unread = createActivityUnread()
  unread.setScope('viewer-a')
  unread.observeLatest('room-a', ['baseline'])
  unread.receive('room-a', Array.from({ length: 105 }, (_, i) => `event-${i}`))
  unread.receive('room-b', ['event-b'])
  assert.equal(unread.count('room-a'), 105)
  assert.equal(unread.count('room-b'), 1)
  unread.setScope('viewer-a')
  assert.equal(unread.count('room-a'), 105)
  unread.setScope('viewer-b')
  assert.equal(unread.count('room-a'), 0)
  unread.observeLatest('room-a', ['baseline', 'event-1'])
  assert.equal(unread.count('room-a'), 0)
  unread.setScope(null)
  unread.receive('room-a', ['signed-out'])
  assert.equal(unread.count('room-a'), 0)
})
