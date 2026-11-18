import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSenderColor,
  GITHUB_SENDER_COLOR,
  senderOwnerKey,
  SYSTEM_SENDER_COLOR,
} from '../../../shared/ui/sender-color'

test('a person and the agents they own share one color', () => {
  const person = getSenderColor('EmmyMay', 'browser')
  assert.equal(getSenderColor("RiverFox | EmmyMay's agent | Codex", 'agent'), person)
  assert.equal(getSenderColor("WrenPeak | EmmyMay's agent | Claude", 'agent'), person)
  assert.equal(getSenderColor('emmymay', 'browser'), person)
})

test('owners get stable keys that do not depend on the agent name', () => {
  assert.equal(senderOwnerKey("RiverFox | EmmyMay's agent | Codex"), 'emmymay')
  assert.equal(senderOwnerKey("Amber | James' agent | Cursor"), 'james')
  assert.equal(senderOwnerKey('Amber | James’s agent | Cursor'), 'james')
  assert.equal(senderOwnerKey("Amber (EmmyMay's agent)"), 'emmymay')
  assert.equal(senderOwnerKey('codex-quiet-river'), 'codex-quiet-river')
  assert.equal(senderOwnerKey(''), null)
})

test('LetAgents lines are gray and GitHub events have their own color', () => {
  assert.equal(getSenderColor('letagents', null), SYSTEM_SENDER_COLOR)
  assert.equal(getSenderColor('System', 'agent'), SYSTEM_SENDER_COLOR)
  assert.equal(getSenderColor('', null), SYSTEM_SENDER_COLOR)
  assert.equal(getSenderColor('dependabot[bot]', 'github'), GITHUB_SENDER_COLOR)
})

test('different owners can get different colors', () => {
  const colors = new Set(['EmmyMay', 'kdnotfound', 'James', 'Ada', 'Grace', 'Linus'].map((owner) => getSenderColor(owner, 'browser')))
  assert.ok(colors.size > 1)
})
