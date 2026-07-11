import assert from 'node:assert/strict'
import test from 'node:test'

import { getAppendedMessageIds, mergeMessageArrivalIds } from '../src/components/room/messageArrival'

test('message arrival only identifies genuinely appended messages', () => {
  assert.deepEqual(getAppendedMessageIds([], ['m1', 'm2']), [])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm2'], ['m1', 'm2', 'm3']), ['m3'])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm2'], ['m0', 'm1', 'm2']), [])
  assert.deepEqual(getAppendedMessageIds(['m1', 'm3'], ['m1', 'm2', 'm3']), [])
  assert.deepEqual(getAppendedMessageIds(['m1'], ['other-room-message']), [])
})

test('message arrival preserves in-flight ids when another burst arrives', () => {
  assert.deepEqual(
    [...mergeMessageArrivalIds(new Set(['m1']), ['m2', 'm3'])],
    ['m1', 'm2', 'm3'],
  )
})
