import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, readonly, ref } from 'vue'

import {
  type MessageListGrowth,
  getAppendedMessageIds,
  mergeMessageArrivalIds,
  watchMessageListGrowth,
} from '../src/components/room/messageArrival'

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

function watchGrowth(initialIds: string[]) {
  // Mirrors useRoom: the list is a ref exposed read-only, and live messages
  // are pushed onto the same array (appendRoomMessage).
  const messages = ref(initialIds.map((id) => ({ id })))
  const exposed = readonly(messages)
  const seen: MessageListGrowth[] = []
  const scope = effectScope()
  scope.run(() => watchMessageListGrowth(() => exposed.value, (growth) => { seen.push(growth) }))
  return { messages, seen, stop: () => scope.stop() }
}

test('message list growth sees live messages pushed onto the same array', async () => {
  const { messages, seen, stop } = watchGrowth(['m1', 'm2'])
  messages.value.push({ id: 'm3' })
  await nextTick()
  messages.value.push({ id: 'm4' }, { id: 'm5' })
  await nextTick()
  assert.deepEqual(seen, [
    { prepended: false, appendedIds: ['m3'], addedCount: 1 },
    { prepended: false, appendedIds: ['m4', 'm5'], addedCount: 2 },
  ])
  stop()
})

test('message list growth handles replaced arrays, prepends, and shrinking', async () => {
  const { messages, seen, stop } = watchGrowth(['m2', 'm3'])
  messages.value = [...messages.value, { id: 'm4' }]
  await nextTick()
  messages.value = [{ id: 'm0' }, { id: 'm1' }, ...messages.value]
  await nextTick()
  messages.value = []
  await nextTick()
  messages.value = [{ id: 'other-room-1' }, { id: 'other-room-2' }]
  await nextTick()
  assert.deepEqual(seen, [
    { prepended: false, appendedIds: ['m4'], addedCount: 1 },
    { prepended: true, appendedIds: [], addedCount: 2 },
    { prepended: false, appendedIds: [], addedCount: 2 },
  ])
  stop()
})

test('message list growth diffs a push and a replace in the same tick once', async () => {
  const { messages, seen, stop } = watchGrowth(['m1', 'm2'])
  messages.value.push({ id: 'm3' })
  messages.value = [...messages.value, { id: 'm4' }]
  await nextTick()
  assert.deepEqual(seen, [{ prepended: false, appendedIds: ['m3', 'm4'], addedCount: 2 }])
  stop()
  messages.value.push({ id: 'm5' })
  await nextTick()
  assert.equal(seen.length, 1)
})
