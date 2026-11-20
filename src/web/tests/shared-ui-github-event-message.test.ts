import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isGitHubRoomMessage,
  isLowSignalGitHubCheckMessage,
  parseGitHubEventPresentation,
} from '../../../shared/ui/github-event-message'

const github = (text: string) => ({ source: 'github', sender: 'github', text })

test('both apps read new commits on a PR as an update, in the update tone', () => {
  const event = parseGitHubEventPresentation(github('PR #12 received new commits in BrosInCode/letagents linked to task_3 https://github.com/BrosInCode/letagents/pull/12'))
  assert.equal(event?.kind, 'pull-request')
  assert.equal(event?.statusLabel, 'updated')
  assert.equal(event?.tone, 'sky')
  assert.equal(event?.taskId, 'task_3')
  assert.equal(event?.url, 'https://github.com/BrosInCode/letagents/pull/12')
  // Any draft wording uses the draft tone, as stored draft events do.
  const draft = parseGitHubEventPresentation(github('PR #9 marked as draft in BrosInCode/letagents'))
  assert.deepEqual([draft?.statusLabel, draft?.tone], ['draft', 'amber'])
})

test('a GitHub message is found by source or by an older " GitHub " sender; empty text has no card', () => {
  assert.equal(isGitHubRoomMessage({ source: 'agent', sender: ' GitHub ', text: 'x' }), true)
  assert.equal(isGitHubRoomMessage({ source: 'browser', sender: 'Ada', text: 'x' }), false)
  assert.equal(parseGitHubEventPresentation(github('   ')), null)
  assert.equal(parseGitHubEventPresentation({ source: 'browser', sender: 'Ada', text: 'PR #1 merged in a/b' }), null)
})

test('passing, skipped and neutral checks are low signal; a failure is not', () => {
  assert.equal(isLowSignalGitHubCheckMessage(github('Check "build" (GitHub Actions) success in a/b https://x.test/1')), true)
  assert.equal(isLowSignalGitHubCheckMessage(github('Check "build" skipped in a/b')), true)
  assert.equal(isLowSignalGitHubCheckMessage(github('Check "build" failure in a/b')), false)
  assert.equal(isLowSignalGitHubCheckMessage({ source: 'browser', sender: 'Ada', text: 'Check "build" success in a/b' }), false)
})

test('the actor login after "by" or "from" cannot change the status or the tone', () => {
  const opened = parseGitHubEventPresentation(github('PR #5 opened by draftbot in a/b: Title https://github.com/a/b/pull/5'))
  assert.deepEqual([opened?.statusLabel, opened?.tone], ['opened', 'violet'])
  const updated = parseGitHubEventPresentation(github('PR #6 received new commits from closedloop in a/b: https://github.com/a/b/pull/6'))
  assert.deepEqual([updated?.statusLabel, updated?.tone], ['updated', 'sky'])
  const draft = parseGitHubEventPresentation(github('PR #7 was converted to draft by mergebot in a/b: https://github.com/a/b/pull/7'))
  assert.deepEqual([draft?.statusLabel, draft?.tone], ['draft', 'amber'])
  const merged = parseGitHubEventPresentation(github('PR #8 was merged by ada in a/b: Title https://github.com/a/b/pull/8'))
  assert.deepEqual([merged?.statusLabel, merged?.tone], ['merged', 'emerald'])
})
