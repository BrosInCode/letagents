import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isRepoBackedRoomId,
  mapGitHubEventsFetchError,
  toAvailableGitHubEventsResult,
} from './roomGitHubEvents.js'

test('isRepoBackedRoomId detects canonical repo rooms', () => {
  assert.equal(isRepoBackedRoomId('github.com/brosincode/letagents'), true)
  assert.equal(isRepoBackedRoomId('https://github.com/BrosInCode/letagents/'), true)
  assert.equal(isRepoBackedRoomId('ABCX-7291'), false)
  assert.equal(isRepoBackedRoomId('team-chat'), false)
});

test('mapGitHubEventsFetchError keeps 404 as a soft unavailable state', () => {
  const result = mapGitHubEventsFetchError<{ id: string }>({
    status: 404,
    message: 'HTTP 404',
  })

  assert.deepEqual(result, {
    events: [],
    available: false,
    hasMore: false,
    error: null,
  })
});

test('mapGitHubEventsFetchError surfaces non-404 failures as real UI errors', () => {
  const result = mapGitHubEventsFetchError<{ id: string }>({
    status: 500,
    message: 'HTTP 500',
  })

  assert.deepEqual(result, {
    events: [],
    available: true,
    hasMore: false,
    error: {
      status: 500,
      message: 'HTTP 500',
    },
  })
});

test('toAvailableGitHubEventsResult preserves events and has_more', () => {
  const result = toAvailableGitHubEventsResult({
    events: [{ id: 'gre_1' }],
    has_more: true,
  })

  assert.deepEqual(result, {
    events: [{ id: 'gre_1' }],
    available: true,
    hasMore: true,
    error: null,
  })
});
