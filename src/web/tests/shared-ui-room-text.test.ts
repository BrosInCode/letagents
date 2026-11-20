import assert from 'node:assert/strict'
import test from 'node:test'

import { getAppendedMessageIds, isAmbientSystemMessage, stripStatusPrefix } from '../../../shared/ui/room-messages'
import { livenessCapabilityLabel } from '../../../shared/ui/liveness-labels'
import { taskStatusLabel } from '../../../shared/ui/task-status'

test('routine LetAgents status lines are ambient; problems are not', () => {
  assert.equal(isAmbientSystemMessage('letagents', '[status] RiverFox joined'), true)
  assert.equal(isAmbientSystemMessage('letagents', '[status] delivery failed'), false)
  assert.equal(isAmbientSystemMessage('EmmyMay', '[status] hello'), false)
  assert.equal(stripStatusPrefix('[STATUS]  working on task_4 '), 'working on task_4')
})

test('only messages after the previous last message count as arrivals', () => {
  assert.deepEqual(getAppendedMessageIds(['a', 'b'], ['a', 'b', 'c', 'd']), ['c', 'd'])
  assert.deepEqual(getAppendedMessageIds(['b', 'c'], ['a', 'b', 'c']), [])
  assert.deepEqual(getAppendedMessageIds([], ['a']), [])
})

test('both apps name statuses and liveness the same way', () => {
  assert.equal(taskStatusLabel('in_progress'), 'In progress')
  assert.equal(taskStatusLabel('in_review'), 'In review')
  assert.equal(taskStatusLabel('some_new_state'), 'some new state')
  assert.equal(livenessCapabilityLabel('PROCESS_OBSERVED'), 'Agent app detected')
  assert.equal(livenessCapabilityLabel(null), 'Connection update')
})
