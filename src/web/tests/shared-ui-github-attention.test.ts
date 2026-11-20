import assert from 'node:assert/strict'
import test from 'node:test'
import { githubAttentionItems } from '../../../shared/ui/activity/attention'
import type { ActivityEvent } from '../../../shared/ui/activity/model'
import { mapGitHubRoomEventPayload } from '../../../apps/desktop/electron/main/rooms/events'
import { desktopActivityEvent } from '../../../apps/desktop/renderer/src/domain/activity-event'

const pr = 'https://github.com/BrosInCode/letagents/pull/42'
const at = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, '0')}:00Z`
function event(id: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id, event_type: 'pull_request', action: 'opened', github_object_id: '42', github_object_url: pr, title: 'Activity view', state: 'open',
    actor_login: 'author', created_at: at(0), provider_event_at: at(0), head_sha: 'sha', metadata: {}, linked_task_id: null, ...overrides }
}
function check(id: string, conclusion: string, minute: number): ActivityEvent {
  return event(id, { event_type: 'check_run', action: 'completed', github_object_id: '77', github_object_url: 'https://github.com/BrosInCode/letagents/runs/77',
    title: 'lint', state: conclusion, actor_login: 'github-actions', created_at: at(minute), provider_event_at: at(minute), head_sha: null,
    metadata: { app_name: 'CI', conclusion } })
}

test('an open pull request with changes requested is one inbox row that leads with the reason', () => {
  const blocker = event('review-1', { event_type: 'pull_request_review', action: 'submitted', actor_login: 'alice', state: 'changes_requested',
    created_at: at(3), provider_event_at: at(3), linked_task_id: 'task_7', metadata: { review_id: '1', review_commit_id: 'sha' } })
  const [item, ...rest] = githubAttentionItems([event('pr'), blocker])
  assert.equal(rest.length, 0)
  assert.equal(item.id, pr.toLowerCase())
  assert.equal(item.title, 'Activity view')
  assert.equal(item.status, 'Changes requested')
  assert.equal(item.body, 'Changes requested by alice')
  assert.equal(item.actor, 'author')
  assert.equal(item.url, pr)
  assert.equal(item.taskId, 'task_7')
  assert.equal(item.latestEventId, 'review-1')
  assert.equal(item.fingerprint, 'pr:review-1')
  assert.deepEqual(item.history.map(entry => [entry.id, entry.label, entry.body]),
    [['pr', 'Pull request opened', 'author'], ['review-1', 'Changes requested', 'alice']])
})

test('a failed check shows until a later run passes; a merged pull request never shows', () => {
  const [failed] = githubAttentionItems([check('evt_1', 'failure', 1)])
  assert.equal(failed.title, 'lint')
  assert.equal(failed.body, 'Build failed: lint')
  assert.deepEqual(failed.history.map(entry => [entry.label, entry.body]), [['lint', 'Failed']])
  assert.equal(failed.taskId, null)
  assert.deepEqual(githubAttentionItems([check('evt_1', 'failure', 1), check('evt_2', 'success', 2)]), [])
  const failedJob = event('job', { event_type: 'check_run', action: 'completed', state: 'failure', created_at: at(2), provider_event_at: at(2), metadata: { conclusion: 'failure' } })
  assert.equal(githubAttentionItems([event('pr'), failedJob]).length, 1)
  assert.deepEqual(githubAttentionItems([event('pr', { state: 'merged', action: 'closed', metadata: { merged: true } }), failedJob]), [])
})

test('the reason names every reviewer and failed job, and a pull request can need both', () => {
  const review = (id: string, actor: string, state: string, minute: number) => event(`review-${id}`, { event_type: 'pull_request_review', action: 'submitted',
    actor_login: actor, state, created_at: at(minute), provider_event_at: at(minute), metadata: { review_id: id, review_commit_id: 'sha' } })
  const job = (id: string, name: string, conclusion: string, minute: number) => event(id, { event_type: 'workflow_job', action: 'completed', github_object_id: id,
    github_object_url: `https://github.com/BrosInCode/letagents/actions/runs/90/job/${id}`, title: name, state: 'completed', created_at: at(minute), provider_event_at: at(minute),
    metadata: { repository: 'brosincode/letagents', pull_request_url: pr, run_id: '90', run_attempt: 1, job_id: id, status: 'completed', conclusion,
      run_url: 'https://github.com/BrosInCode/letagents/actions/runs/90', workflow_name: 'CI', pull_request_head_sha: 'sha' } })
  const [item] = githubAttentionItems([event('pr'), review('1', 'alice', 'changes_requested', 1), review('2', 'bob', 'changes_requested', 2),
    review('3', 'carol', 'approved', 3), job('11', 'lint', 'failure', 4), job('12', 'build', 'success', 5), job('13', 'desktop-tests', 'failure', 6)])
  assert.equal(item.status, 'Changes requested')
  assert.equal(item.body, 'Changes requested by alice, bob · Build failed: lint, desktop-tests')
  assert.deepEqual(item.history.slice(1, 4).map(entry => entry.label), ['Changes requested', 'Changes requested', 'Approved'])
})

test('desktop events reach the shared rows unchanged, so both inboxes list the same items', () => {
  const blocker = event('review-1', { event_type: 'pull_request_review', action: 'submitted', actor_login: 'alice', state: 'changes_requested',
    created_at: at(3), provider_event_at: at(3), provider_object_updated_at: null, event_order_at: null, metadata: { review_id: '1', review_commit_id: 'sha' } })
  const web = [event('pr', { provider_object_updated_at: null, event_order_at: null }), blocker]
  const desktop = web.map(payload => desktopActivityEvent(mapGitHubRoomEventPayload(payload)!))
  assert.deepEqual(desktop, web)
  assert.deepEqual(githubAttentionItems(desktop), githubAttentionItems(web))
})
