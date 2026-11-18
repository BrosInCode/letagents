import assert from 'node:assert/strict'
import test from 'node:test'

import { ownerAttributionFromOwnerLabel, parseAgentLabel } from '../../../shared/ui/agent-label'
import { parseAgentIdentity, resolveAgentIdentity } from '../src/composables/room/identity'

test('both apps read agent labels with the server parser', () => {
  assert.deepEqual(parseAgentLabel('RiverFox | Ada\'s agent | claude-code'), {
    raw: 'RiverFox | Ada\'s agent | claude-code', displayName: 'RiverFox', ownerAttribution: 'Ada\'s agent', ideLabel: 'Claude Code', structured: true,
  })
  const legacy = parseAgentLabel('codex-7 (Ada\'s agent)')
  assert.deepEqual([legacy.displayName, legacy.ownerAttribution, legacy.ideLabel, legacy.structured], ['codex-7', 'Ada\'s agent', 'Codex', false])
  assert.equal(parseAgentLabel('  ').displayName, '')
  assert.equal(parseAgentIdentity('Ada').displayName, 'Ada')
  // The web keeps the generic "Agent" IDE label (the desktop hides it).
  assert.equal(parseAgentIdentity('MossFinch | Ada\'s agent | Agent').ideLabel, 'Agent')
  // Extra spaces in a label are collapsed, so names still match.
  const spaced = parseAgentLabel('Oak  |  Ada\'s agent | Codex')
  assert.deepEqual([spaced.displayName, spaced.ownerAttribution, spaced.ideLabel], ['Oak', 'Ada\'s agent', 'Codex'])
})

test('an owner label becomes the same attribution the server writes into actor labels', () => {
  assert.equal(ownerAttributionFromOwnerLabel('Ada'), 'Ada\'s agent')
  assert.equal(ownerAttributionFromOwnerLabel('James'), 'James\' agent')
  assert.equal(ownerAttributionFromOwnerLabel('Ada’s agent'), 'Ada’s agent')
  assert.equal(ownerAttributionFromOwnerLabel(null), null)
  assert.equal(resolveAgentIdentity('RiverFox', { owner_label: 'Ada', ide_label: 'Codex' }).ownerAttribution, 'Ada\'s agent')
})
