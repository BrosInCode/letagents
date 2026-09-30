import assert from 'node:assert/strict'
import test from 'node:test'

import { ideKey } from '../src/components/room/chat-message/ideKey'

test('chat IDE badges match every spelling a runtime label arrives in', () => {
  for (const [label, key] of [
    ['Codex', 'codex'],
    ['Claude', 'claude'],
    ['Claude Code', 'claude'],
    ['claude-code', 'claude'],
    ['OpenCode', 'opencode'],
    ['Opencode', 'opencode'],
    ['Open Model', 'opencode'],
    ['Cursor', 'cursor'],
    ['Antigravity', 'antigravity'],
    ['Future IDE', 'default'],
  ] as const) {
    assert.equal(ideKey(label), key, label)
  }
})
