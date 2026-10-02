import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LETAGENTS_ROOM_ORIGIN,
  MESSAGE_ID_PATTERN,
  isValidMessageId,
  isLocalRoomIdentifier,
  buildLetAgentsMessageUrl,
  parseLetAgentsMessageUrl,
  resolveSameRoomMessageReference,
} from '../src/domain/roomRoutes'

test('isValidMessageId strictly validates ^msg_[1-9]\\d*$', () => {
  assert.equal(isValidMessageId('msg_1'), true)
  assert.equal(isValidMessageId('msg_42'), true)
  assert.equal(isValidMessageId('msg_99999'), true)

  assert.equal(isValidMessageId(''), false)
  assert.equal(isValidMessageId('msg_0'), false)
  assert.equal(isValidMessageId('msg_01'), false)
  assert.equal(isValidMessageId('msg_'), false)
  assert.equal(isValidMessageId('msg_-1'), false)
  assert.equal(isValidMessageId('msg_abc'), false)
  assert.equal(isValidMessageId('task_1'), false)
  assert.equal(isValidMessageId('123'), false)
  assert.equal(isValidMessageId('msg_1 '), false)
  assert.equal(isValidMessageId(' msg_1'), false)
  assert.equal(isValidMessageId(null), false)
  assert.equal(isValidMessageId(undefined), false)
})

test('buildLetAgentsMessageUrl and parseLetAgentsMessageUrl test table', () => {
  const table = [
    {
      room: 'focus_90',
      msgId: 'msg_157',
      expected: 'https://letagents.chat/in/focus_90?message=msg_157',
    },
    {
      room: 'github.com/BrosInCode/letagents',
      msgId: 'msg_42',
      expected: 'https://letagents.chat/in/github.com/BrosInCode/letagents?message=msg_42',
    },
    {
      room: 'github.com/Bros In Code/letagents#staging',
      msgId: 'msg_1',
      expected: 'https://letagents.chat/in/github.com/Bros%20In%20Code/letagents%23staging?message=msg_1',
    },
  ]

  for (const row of table) {
    const built = buildLetAgentsMessageUrl(row.room, row.msgId)
    assert.equal(built, row.expected)

    const parsed = parseLetAgentsMessageUrl(built)
    assert.deepEqual(parsed, {
      roomIdentifier: row.room,
      messageId: row.msgId,
    })
  }

  // Foreign origin is rejected
  assert.equal(
    parseLetAgentsMessageUrl('https://evil.com/in/room?message=msg_1', LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // One URL form only: ?m= is ignored
  assert.deepEqual(
    parseLetAgentsMessageUrl('https://letagents.chat/in/room?m=msg_1'),
    { roomIdentifier: 'room', messageId: null },
  )

  // Hash alias is ignored
  assert.deepEqual(
    parseLetAgentsMessageUrl('https://letagents.chat/in/room#msg_1'),
    { roomIdentifier: 'room', messageId: null },
  )
})

test('resolveSameRoomMessageReference intercepts only same-room message links', () => {
  const currentRoom = 'github.com/BrosInCode/letagents'
  const sameRoomUrl = 'https://letagents.chat/in/github.com/BrosInCode/letagents?message=msg_12'
  const otherRoomUrl = 'https://letagents.chat/in/focus_90?message=msg_12'
  const nonMessageUrl = 'https://letagents.chat/in/github.com/BrosInCode/letagents'
  const externalUrl = 'https://github.com/BrosInCode/letagents/pull/1500'

  // Same room message permalink -> returns message ID
  assert.equal(
    resolveSameRoomMessageReference(sameRoomUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    'msg_12',
  )

  // Another room message permalink -> returns null (not intercepted)
  assert.equal(
    resolveSameRoomMessageReference(otherRoomUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // Same room non-message link -> returns null
  assert.equal(
    resolveSameRoomMessageReference(nonMessageUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )

  // External link -> returns null
  assert.equal(
    resolveSameRoomMessageReference(externalUrl, currentRoom, LETAGENTS_ROOM_ORIGIN),
    null,
  )
})

