import assert from 'node:assert/strict'
import test from 'node:test'

import {
  gitRoomAccessLabel,
  gitRoomRefLabel,
  gitRoomRefTypeLabel,
} from '../components/room/focus-rooms/options.js'
import type { GitRoomInfo } from './room/types.js'

function gitRoom(overrides: Partial<GitRoomInfo> = {}): GitRoomInfo {
  return {
    room_id: 'focus_37',
    provider: 'github',
    host: 'github.com',
    repository: {
      id: '1',
      owner: 'BrosInCode',
      name: 'letagents',
      full_name: 'BrosInCode/letagents',
    },
    ref: {
      type: 'branch',
      name: 'codex/git-rooms',
      default_branch: 'main',
      base_ref: 'main',
      head_ref: 'codex/git-rooms',
      head_repository: null,
      is_default: false,
    },
    visibility: 'public',
    access_mode: 'public',
    source: 'webhook',
    updated_at: '2026-06-28T10:00:00.000Z',
    ...overrides,
  }
}

test('Git Room focus labels preserve fork owner context and access', () => {
  const forkedRoom = gitRoom({
    access_mode: 'private',
    ref: {
      type: 'branch',
      name: 'feature/git-rooms',
      default_branch: 'main',
      base_ref: 'main',
      head_ref: 'feature/git-rooms',
      head_repository: {
        id: '2',
        owner: 'Contributor',
        name: 'letagents-fork',
        full_name: 'Contributor/letagents-fork',
      },
      is_default: false,
    },
  })

  assert.equal(gitRoomRefLabel(forkedRoom), 'Contributor:feature/git-rooms')
  assert.equal(gitRoomRefTypeLabel(forkedRoom), 'Branch')
  assert.equal(gitRoomAccessLabel(forkedRoom), 'Private')
})
