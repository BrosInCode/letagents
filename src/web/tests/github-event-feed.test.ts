import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, ref } from 'vue'

import { labelForType } from '../src/components/room/github-event-feed/labels'
import { useGitHubEventFeed } from '../src/components/room/github-event-feed/useGitHubEventFeed'
import type { RoomGitHubEvent } from '../src/composables/useRoom'

function event(overrides: Partial<RoomGitHubEvent>): RoomGitHubEvent {
  return {
    id: 'evt',
    event_type: 'pull_request',
    action: 'opened',
    github_object_id: null,
    github_object_url: null,
    title: null,
    state: null,
    actor_login: null,
    metadata: null,
    linked_task_id: null,
    created_at: '2026-05-28T10:00:00.000Z',
    ...overrides,
  }
}

test('GitHub event feed groups and filters events by type', () => {
  const events = ref<RoomGitHubEvent[]>([
    event({ id: 'pr-1', event_type: 'pull_request' }),
    event({ id: 'check-1', event_type: 'check_run' }),
    event({ id: 'review-1', event_type: 'pull_request_review', created_at: '2026-05-27T08:00:00.000Z' }),
  ])

  const feed = useGitHubEventFeed(() => events.value)

  assert.equal(feed.pullRequestCount.value, 1)
  assert.equal(feed.checkRunCount.value, 1)
  assert.deepEqual(
    feed.filterOptions.value.map((option) => [option.value, option.count]),
    [
      ['all', 3],
      ['pull_request', 1],
      ['check_run', 1],
      ['pull_request_review', 1],
    ],
  )

  feed.selectedFilter.value = 'check_run'
  assert.deepEqual(feed.filteredEvents.value.map((item) => item.id), ['check-1'])
  assert.equal(feed.groupedEvents.value.length, 1)
  assert.deepEqual(feed.groupedEvents.value[0]?.events.map((item) => item.id), ['check-1'])
})

test('GitHub event feed resets an unavailable selected filter', async () => {
  const events = ref<RoomGitHubEvent[]>([
    event({ id: 'check-1', event_type: 'check_run' }),
  ])
  const feed = useGitHubEventFeed(() => events.value)

  feed.selectedFilter.value = 'check_run'
  events.value = [event({ id: 'issue-1', event_type: 'issue' })]
  await nextTick()

  assert.equal(feed.selectedFilter.value, 'all')
  assert.deepEqual(feed.filteredEvents.value.map((item) => item.id), ['issue-1'])
})

test('labelForType formats known and fallback event types', () => {
  assert.equal(labelForType('pull_request'), 'Pull requests')
  assert.equal(labelForType('unknown_event_type'), 'unknown event type')
})
