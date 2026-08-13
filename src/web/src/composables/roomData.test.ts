import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getGitHubEventsIdentifier,
  getGitHubSupportIdentifier,
  mergeMessages,
} from './room/data.js'
import { isVisibleRoomMessage } from './room/identity.js'
import { joinRoomSession } from './room/join.js'
import { createRoomLifecycle } from './room/lifecycle.js'
import {
  appendRoomMessage,
  messages,
  replaceRoomMessages,
} from './room/state.js'
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
    projectId: 'focus_37',
    identifier: 'focus_37',
    kind: 'focus',
    parentRoomId: 'github.com/brosincode/letagents',
    focusKey: 'git:branch:Y29kZXgvZ2l0LXJvb21z',
    gitRoom: {
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
    },
  })

  assert.equal(
    getGitHubEventsIdentifier(gitRoom),
    'focus_37',
  )
  assert.equal(getGitHubSupportIdentifier(gitRoom), 'github.com/BrosInCode/letagents')
  assert.equal(isRepoBackedRoomId(getGitHubSupportIdentifier(gitRoom)), true)
})

test('web join state replaces a focus locator with the canonical room id', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    room_id: 'focus_37',
    kind: 'focus',
    parent_room_id: 'github.com/brosincode/letagents',
    focus_key: 'git:branch:Y29kZXgvZ2l0LXJvb21z',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const joined = await joinRoomSession(
      'github.com/brosincode/letagents/focus/git:branch:Y29kZXgvZ2l0LXJvb21z',
    )
    assert.equal(joined.identifier, 'focus_37')
    assert.equal(joined.projectId, 'focus_37')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('web lifecycle switches every post-join request and stream to the canonical room id', async () => {
  const locator =
    'github.com/brosincode/letagents/focus/git:branch:Y29kZXgvZ2l0LXJvb21z'
  const originalFetch = globalThis.fetch
  const originalLocalStorage = globalThis.localStorage
  const requestedPaths: string[] = []
  const streamCalls: string[] = []
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  globalThis.fetch = async (input) => {
    const path = String(input)
    requestedPaths.push(path)
    const body = path.endsWith('/join')
      ? {
          room_id: 'focus_37',
          kind: 'focus',
          parent_room_id: 'github.com/brosincode/letagents',
          focus_key: 'git:branch:Y29kZXgvZ2l0LXJvb21z',
        }
      : {}
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const lifecycle = createRoomLifecycle({
    startParticipantRefreshLoop: (identifier) => streamCalls.push(`participants:${identifier}`),
    startPresenceRefreshLoop: (identifier) => streamCalls.push(`presence:${identifier}`),
    startStreaming: async (identifier) => {
      streamCalls.push(`stream:${identifier}`)
    },
    finishStreamingBootstrap: (identifier) => streamCalls.push(`finish:${identifier}`),
    stopStreaming: () => undefined,
  })

  try {
    assert.equal(await lifecycle.joinRoom(locator), true)
    assert.deepEqual(streamCalls, [
      'stream:focus_37',
      'finish:focus_37',
      'presence:focus_37',
      'participants:focus_37',
    ])
    assert.ok(requestedPaths[0]?.includes(encodeURIComponent(locator)))
    assert.ok(
      requestedPaths.slice(1).every((path) => path.startsWith('/rooms/focus_37/')),
    )
    assert.ok(
      requestedPaths.some((path) =>
        path.includes('/activity-history?') && path.includes('room_id=focus_37'),
      ),
    )
    assert.equal(JSON.parse(storage.get('lac-vue-session') || '{}').identifier, 'focus_37')
  } finally {
    lifecycle.leaveRoom()
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: originalLocalStorage,
    })
  }
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

test('live message append uses a maintained id index and repairs direct snapshot replacement', () => {
  const makeMessage = (id: string): RoomMessage => ({
    id,
    sender: 'Human',
    text: id,
    agent_prompt_kind: null,
    source: 'browser',
    timestamp: '2026-07-13T12:00:00.000Z',
  })
  replaceRoomMessages([makeMessage('msg_1')])
  assert.equal(appendRoomMessage(makeMessage('msg_1')), false)

  // Preserve compatibility with legacy/tests that assign the exported ref.
  messages.value = [makeMessage('msg_2')]
  assert.equal(appendRoomMessage(makeMessage('msg_1')), true)
  assert.deepEqual(messages.value.map((message) => message.id), ['msg_2', 'msg_1'])
})
