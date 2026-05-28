import assert from 'node:assert/strict'
import test from 'node:test'

import { getOwnerFromSender } from '../src/components/room/room-drawer/useRoomDrawerOwners'
import { encodeRoomPathIdentifier } from '../src/components/room/room-drawer/useRoomDrawerShare'

test('encodeRoomPathIdentifier preserves path separators while encoding segments', () => {
  assert.equal(
    encodeRoomPathIdentifier('github.com/Bros In Code/letagents#staging'),
    'github.com/Bros%20In%20Code/letagents%23staging',
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
