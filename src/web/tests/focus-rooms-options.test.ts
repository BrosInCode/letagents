import assert from 'node:assert/strict'
import test from 'node:test'

import type { FocusRoomInfo } from '../src/composables/useRoom'
import {
  createEmptyCloseoutDetails,
  focusStatusLabel,
  focusRoomOpenKey,
  formatAuditTime,
  githubRoutingLabel,
  parentVisibilityLabel,
} from '../src/components/room/focus-rooms/options'

test('focus room labels use product copy for persisted values', () => {
  assert.equal(parentVisibilityLabel('summary_only'), 'Only the final note')
  assert.equal(parentVisibilityLabel('silent'), 'Nothing automatic')
  assert.equal(githubRoutingLabel('focus_owned_only'), 'Keep related code here')
})

test('focusRoomOpenKey prefers stable routing identifiers', () => {
  const baseRoom = {
    room_id: 'focus_room_1',
    source_task_id: 'task_7',
    focus_key: 'focus_key_1',
  } as FocusRoomInfo

  assert.equal(focusRoomOpenKey(baseRoom), 'focus_key_1')
  assert.equal(focusRoomOpenKey({ ...baseRoom, focus_key: null }), 'task_7')
  assert.equal(
    focusRoomOpenKey({ ...baseRoom, focus_key: null, source_task_id: null }),
    'focus_room_1',
  )
})

test('createEmptyCloseoutDetails returns a task closeout draft', () => {
  assert.deepEqual(createEmptyCloseoutDetails(), {
    artifact: '',
    review_state: 'needs_review',
    blocker_state: 'none',
    parent_task_next: 'keep_open',
    next_owner: '',
  })
})

test('focusStatusLabel and formatAuditTime keep display fallbacks simple', () => {
  assert.equal(focusStatusLabel('waiting_on_parent'), 'waiting on parent')
  assert.equal(formatAuditTime(null), 'Unknown')
  assert.equal(formatAuditTime('not-a-date'), 'not-a-date')
})
