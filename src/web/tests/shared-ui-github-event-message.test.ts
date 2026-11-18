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
