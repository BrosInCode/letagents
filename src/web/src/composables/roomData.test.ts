import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getGitHubEventsIdentifier,
  getGitHubSupportIdentifier,
} from './room/data.js'
import { isRepoBackedRoomId } from './roomGitHubEvents.js'
import type { RoomInfo } from './room/types.js'

function room(overrides: Partial<RoomInfo> = {}): RoomInfo {
  return {
    projectId: 'github.com/brosincode/letagents',
    identifier: 'github.com/brosincode/letagents',
    code: '',
    name: 'github.com/brosincode/letagents',
    displayName: 'letagents',
    role: 'participant',
    authenticated: true,
    kind: 'main',
    attachmentsEnabled: true,
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    focusParentVisibility: null,
    focusActivityScope: null,
    focusGitHubEventRouting: null,
    concludedAt: null,
    conclusionSummary: null,
    conclusionDetails: null,
    gitRoom: null,
    ...overrides,
  }
}

test('Git child rooms detect GitHub support from binding but fetch their own event lane', () => {
  const gitRoom = room({
    projectId: 'git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21z',
    identifier: 'git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21z',
    kind: 'focus',
    parentRoomId: 'github.com/brosincode/letagents',
    focusKey: 'git:branch:Y29kZXgvZ2l0LXJvb21z',
    gitRoom: {
      room_id: 'git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21z',
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
    },
  })

  assert.equal(
    getGitHubEventsIdentifier(gitRoom),
    'git-room:github.com:brosincode/letagents:branch:Y29kZXgvZ2l0LXJvb21z',
  )
  assert.equal(getGitHubSupportIdentifier(gitRoom), 'github.com/BrosInCode/letagents')
  assert.equal(isRepoBackedRoomId(getGitHubSupportIdentifier(gitRoom)), true)
})
