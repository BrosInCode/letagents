import assert from 'node:assert/strict'
import test from 'node:test'
import { githubAttentionItems } from '../../../shared/ui/activity/attention'
import type { ActivityEvent } from '../../../shared/ui/activity/model'
import { mapGitHubRoomEventPayload } from '../../../apps/desktop/electron/main/rooms/events'
import { desktopActivityEvent } from '../../../apps/desktop/renderer/src/domain/activity-event'

// Shapes follow src/api/github/room-events/{pull-request,review,check-run,activity}.ts.
const repo = 'https://github.com/BrosInCode/letagents'
const pr = `${repo}/pull/42`
const at = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, '0')}:00Z`
function event(id: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id, event_type: 'pull_request', action: 'opened', github_object_id: '42', github_object_url: pr, title: 'Activity view', state: 'open',
    actor_login: 'author', created_at: at(0), provider_event_at: at(0), head_sha: 'sha1', metadata: { head_sha: 'sha1', author_login: 'author' }, linked_task_id: null, ...overrides }
}
function review(id: string, actor: string, state: string, minute: number, sha = 'sha1'): ActivityEvent {
  return event(`review-${id}`, { event_type: 'pull_request_review', action: 'submitted', actor_login: actor, state, created_at: at(minute), provider_event_at: at(minute),
    github_object_url: `${pr}#pullrequestreview-${id}`, metadata: { review_id: id, review_commit_id: sha } })
}
/** A GitHub Actions job: one workflow_job event plus the check_run GitHub sends for the same job. */
function actionsJob(jobId: string, name: string, conclusion: string, minute: number, options: { sha?: string; pullRequest?: number | null; branch?: string; runId?: string } = {}): ActivityEvent[] {
  const { sha = 'sha1', pullRequest = 42, branch = 'feature', runId = `run${jobId}` } = options
  const jobUrl = `${repo}/actions/runs/${runId}/job/${jobId}`
  return [
    event(`job-${jobId}`, { event_type: 'workflow_job', action: 'completed', github_object_id: jobId, github_object_url: jobUrl, title: name, state: conclusion,
      actor_login: 'author', created_at: at(minute), provider_event_at: at(minute), head_sha: sha,
      metadata: { repository: 'BrosInCode/letagents', pull_request_number: pullRequest, pull_request_url: pullRequest ? `${repo}/pull/${pullRequest}` : null,
        head_sha: sha, head_ref: branch, workflow_id: '7', run_id: runId, run_attempt: 1, workflow_name: 'CI', run_title: 'CI', run_url: `${repo}/actions/runs/${runId}`,
        job_id: jobId, status: 'completed', conclusion, pull_request_head_sha: pullRequest ? sha : null } }),
    check(`check-${jobId}`, name, conclusion, minute, { url: jobUrl, sha, pullRequest, branch }),
  ]
}
function check(id: string, name: string, conclusion: string, minute: number, options: { url?: string; sha?: string; pullRequest?: number | null; branch?: string } = {}): ActivityEvent {
  const { url = `${repo}/runs/${id}`, sha = 'sha1', pullRequest = null, branch = 'staging' } = options
  return event(id, { event_type: 'check_run', action: 'completed', github_object_id: id, github_object_url: url, title: name, state: conclusion,
    actor_login: 'github-actions', created_at: at(minute), provider_event_at: at(minute), head_sha: sha,
    metadata: { status: 'completed', conclusion, app_name: 'GitHub Actions', suite_id: 1, head_branch: branch, head_sha: sha,
      same_repo_pull_request_numbers: pullRequest ? [pullRequest] : [] } })
}

test('an open pull request with changes requested is one row that names the reviewer', () => {
  const [item, ...rest] = githubAttentionItems([event('pr'), { ...review('1', 'alice', 'changes_requested', 3), linked_task_id: 'task_7' }])
  assert.equal(rest.length, 0)
  assert.equal(item.id, pr.toLowerCase())
  assert.equal(item.title, 'Activity view')
  assert.equal(item.status, 'Changes requested')
  assert.equal(item.body, 'Changes requested by alice')
  assert.equal(item.actor, 'author')
  assert.equal(item.url, pr)
  assert.equal(item.taskId, 'task_7')
  assert.equal(item.latestEventId, 'review-1')
  assert.equal(item.fingerprint, 'review-1|Changes requested by alice')
  assert.deepEqual(item.history.map(entry => [entry.id, entry.label, entry.body]),
    [['pr', 'Pull request opened', 'author'], ['review-1', 'Changes requested', 'alice']])
})

test('a failed Actions job is one pull request row, not a second row for its check run', () => {
  const items = githubAttentionItems([event('pr'), ...actionsJob('11', 'lint', 'failure', 4, { runId: 'run90' }), ...actionsJob('12', 'build', 'success', 5, { runId: 'run90' })])
  assert.deepEqual(items.map(item => [item.id, item.body]), [[pr.toLowerCase(), 'Build failed: lint']])
  assert.ok(!items[0].history.some(entry => entry.id === 'check-11'), 'the job already says it; its check run is not repeated')
})

test('a pull request row clears when a new commit passes, and never shows after a merge', () => {
  const failed = [event('pr'), ...actionsJob('11', 'lint', 'failure', 4)]
  const pushed = event('pr-sync', { action: 'synchronize', head_sha: 'sha2', metadata: { head_sha: 'sha2' }, created_at: at(6), provider_event_at: at(6) })
  assert.deepEqual(githubAttentionItems([...failed, pushed, ...actionsJob('21', 'lint', 'success', 8, { sha: 'sha2', runId: 'run21' })]), [])
  assert.equal(githubAttentionItems([...failed, pushed]).length, 0, 'a failure on an older commit does not count')
  const merged = event('pr-merged', { action: 'closed', state: 'merged', metadata: { merged: true }, created_at: at(9), provider_event_at: at(9) })
  assert.deepEqual(githubAttentionItems([...failed, merged]), [])
})

test('a check from another app counts on the pull request for its current commit only', () => {
  assert.deepEqual(githubAttentionItems([event('pr'), check('c1', 'vercel', 'failure', 3, { pullRequest: 42, branch: 'feature' })]).map(item => item.body), ['Build failed: vercel'])
  assert.deepEqual(githubAttentionItems([event('pr', { head_sha: 'sha2', metadata: { head_sha: 'sha2' } }), check('c1', 'vercel', 'failure', 3, { pullRequest: 42, branch: 'feature' })]), [])
  assert.deepEqual(githubAttentionItems([event('pr'), check('c1', 'vercel', 'failure', 3, { pullRequest: 42 }), check('c2', 'vercel', 'success', 4, { pullRequest: 42 })]), [])
  assert.deepEqual(githubAttentionItems([check('c1', 'vercel', 'failure', 3, { pullRequest: 42 })]).map(item => item.id), [`lane:${pr.toLowerCase()}|check|vercel`],
    'without the pull request in the loaded page, the check is its own row')
})

test('repeated failures of one branch check are one row until a later run passes', () => {
  const failures = [check('c1', 'lint', 'failure', 1), check('c2', 'lint', 'failure', 2), check('c3', 'lint', 'failure', 3)]
  const [item, ...rest] = githubAttentionItems(failures)
  assert.equal(rest.length, 0)
  assert.equal(item.id, 'lane:brosincode/letagents|staging|check|lint')
  assert.equal(item.title, 'lint')
  assert.equal(item.body, 'Build failed: lint')
  assert.equal(item.latestEventId, 'c3')
  assert.equal(item.url, `${repo}/runs/c3`)
  assert.deepEqual(item.history.map(entry => [entry.id, entry.label, entry.body]), [['c1', 'lint', 'Failed'], ['c2', 'lint', 'Failed'], ['c3', 'lint', 'Failed']])
  assert.deepEqual(githubAttentionItems([...failures, check('c4', 'lint', 'success', 4)]), [])
  assert.equal(githubAttentionItems([...failures, check('c4', 'deploy', 'success', 4)]).length, 1, 'another check does not clear it')
  assert.equal(githubAttentionItems([...failures, check('c4', 'lint', 'success', 4, { branch: 'main' })]).length, 1, 'another branch does not clear it')
})

test('a push workflow failure is one row, and clears when the next run of that workflow on the branch passes', () => {
  const push = (jobId: string, conclusion: string, minute: number) => actionsJob(jobId, 'build', conclusion, minute, { pullRequest: null, branch: 'staging', runId: `run${jobId}` })
  const failing = githubAttentionItems(push('31', 'failure', 1))
  assert.deepEqual(failing.map(item => item.body), ['Build failed: build'])
  assert.deepEqual(githubAttentionItems([...push('31', 'failure', 1), ...push('32', 'success', 2)]), [])
})

test('the reason names every reviewer and failed job, and a pull request can need both', () => {
  const items = githubAttentionItems([event('pr'), review('1', 'alice', 'changes_requested', 1), review('2', 'bob', 'changes_requested', 2),
    review('3', 'carol', 'approved', 3), ...actionsJob('11', 'lint', 'failure', 4, { runId: 'run90' }), ...actionsJob('12', 'build', 'success', 5, { runId: 'run90' }),
    ...actionsJob('13', 'desktop-tests', 'failure', 6, { runId: 'run90' })])
  assert.equal(items.length, 1)
  assert.equal(items[0].status, 'Changes requested')
  assert.equal(items[0].body, 'Changes requested by alice, bob · Build failed: lint, desktop-tests')
})

test('desktop events reach the shared rows unchanged, so both inboxes list the same items', () => {
  const web = [event('pr', { provider_object_updated_at: null, event_order_at: null }),
    { ...review('1', 'alice', 'changes_requested', 3), provider_object_updated_at: null, event_order_at: null },
    ...actionsJob('11', 'lint', 'failure', 4).map(item => ({ ...item, provider_object_updated_at: null, event_order_at: null }))]
  const desktop = web.map(payload => desktopActivityEvent(mapGitHubRoomEventPayload(payload)!))
  assert.deepEqual(desktop, web)
  assert.deepEqual(githubAttentionItems(desktop), githubAttentionItems(web))
})
