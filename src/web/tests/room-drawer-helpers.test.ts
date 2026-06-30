import assert from 'node:assert/strict'
import test from 'node:test'

import { getOwnerFromSender } from '../src/components/room/room-drawer/useRoomDrawerOwners'
import {
  buildRoomSharePath,
  buildRoomShareUrl,
  encodeRoomPathIdentifier,
} from '../src/components/room/room-drawer/useRoomDrawerShare'

test('encodeRoomPathIdentifier preserves path separators while encoding segments', () => {
  assert.equal(
    encodeRoomPathIdentifier('github.com/Bros In Code/letagents#staging'),
    'github.com/Bros%20In%20Code/letagents%23staging',
  )
})

test('room drawer share helpers build canonical LetAgents URLs for repo rooms', () => {
  assert.equal(
    buildRoomShareUrl(
      { identifier: 'github.com/brosincode/letagents', kind: 'main' },
      'https://letagents.chat',
    ),
    'https://letagents.chat/in/github.com/brosincode/letagents',
  )
})

test('room drawer share helpers fall back to project id when identifier is blank', () => {
  assert.equal(
    buildRoomSharePath({
      identifier: ' ',
      projectId: 'github.com/brosincode/fallback',
    }),
    '/in/github.com/brosincode/fallback',
  )
})

test('room drawer share helpers build parent focus routes when metadata is available', () => {
  assert.equal(
    buildRoomSharePath({
      identifier: 'focus_16',
      kind: 'focus',
      parentRoomId: 'github.com/brosincode/letagents',
      focusKey: 'task_42',
    }),
    '/in/github.com/brosincode/letagents/focus/task_42',
  )
  assert.equal(
    buildRoomShareUrl(
      {
        identifier: 'focus_16',
        kind: 'focus',
        parentRoomId: 'github.com/brosincode/letagents',
        sourceTaskId: 'task_99',
      },
      'https://letagents.chat/',
    ),
    'https://letagents.chat/in/github.com/brosincode/letagents/focus/task_99',
  )
})

test('getOwnerFromSender preserves drawer owner palette behavior', () => {
  assert.equal(
    getOwnerFromSender("BayOtter | Emmy May's agent | Agent", 'agent'),
    'Emmy May',
  )
  assert.equal(getOwnerFromSender('Browser Human', 'browser'), 'Browser Human')
  assert.equal(getOwnerFromSender('LetAgents', 'system'), null)
  assert.equal(getOwnerFromSender('', 'agent'), null)
})
