import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getGitHubEventsIdentifier,
  getGitHubSupportIdentifier,
  mergeMessages,
} from './room/data.js'
import { isVisibleRoomMessage } from './room/identity.js'
import { isRepoBackedRoomId } from './roomGitHubEvents.js'
import type { RoomInfo, RoomMessage } from './room/types.js'

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

test('web room visibility keeps attachment-only messages with a NULL prompt kind', () => {
  const attachmentOnly: RoomMessage = {
    id: 'msg_1',
    sender: 'Human',
    text: '',
    attachments: [{ id: 'att_only', file_name: 'notes.txt' }],
    agent_prompt_kind: null,
    source: 'browser',
    timestamp: '2026-07-13T12:00:00.000Z',
  }
  const emptyPrompt = {
    ...attachmentOnly,
    id: 'msg_2',
    attachments: [],
    agent_prompt_kind: 'auto',
  } satisfies RoomMessage

  assert.equal(isVisibleRoomMessage(attachmentOnly), true)
  assert.equal(isVisibleRoomMessage(emptyPrompt), false)
  assert.deepEqual(mergeMessages([], [attachmentOnly, emptyPrompt]).map((message) => message.id), ['msg_1'])
})
