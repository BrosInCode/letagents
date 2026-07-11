import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomMessage, StalePromptTaskState } from '../src/composables/useRoom'
import {
  isAmbientSystemMessage,
  renderMessageContent,
  stripStatusPrefix,
} from '../src/components/room/chat-message/formatting'
import { isCurrentStalePrompt, stalePromptTaskIdFor } from '../src/components/room/chat-message/stalePrompt'
import { resolveAgentIdentity } from '../src/composables/room/identity'

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'msg_1',
    text: '',
    sender: 'agent',
    timestamp: '2026-05-28T10:00:00.000Z',
    source: 'agent',
    ...overrides,
  } as RoomMessage
}

test('renderMessageContent escapes HTML before applying lightweight formatting', () => {
  assert.equal(
    renderMessageContent('**hi** <script>alert("x")</script> `code`'),
    '<strong>hi</strong> &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <code>code</code>',
  )
})

test('renderMessageContent linkifies URLs and keeps href attributes escaped', () => {
  assert.equal(
    renderMessageContent('see https://example.com/?q=a&b=c and @codex'),
    'see <a href="https://example.com/?q=a&amp;b=c" target="_blank" rel="noopener noreferrer">https://example.com/?q=a&amp;b=c</a> and <span class="mention-token">@codex</span>',
  )
})

test('renderMessageContent preserves collision-safe owner/agent mention handles', () => {
  assert.equal(
    renderMessageContent('@agent:local/EmmyMay/codex/oak please review'),
    '<span class="mention-token">@agent:local/EmmyMay/codex/oak</span> please review',
  )
})

test('structured message identity recovers owner attribution from owner label and actor label', () => {
  assert.equal(resolveAgentIdentity('Oak', { owner_label: 'EmmyMay' }).ownerAttribution, "EmmyMay's agent")
  assert.equal(
    resolveAgentIdentity('Oak', { actor_label: "Oak | EmmyMay's agent | Codex" }).ownerAttribution,
    "EmmyMay's agent",
  )
})

test('structured message identity overrides an unstructured sender label', () => {
  const identity = resolveAgentIdentity('MorrowForest 2', {
    display_name: 'MorrowForest 2',
    owner_attribution: "EmmyMay's agent",
    ide_label: 'Codex',
  })
  assert.equal(identity.displayName, 'MorrowForest 2')
  assert.equal(identity.ownerAttribution, "EmmyMay's agent")
  assert.equal(identity.ideLabel, 'Codex')
})

test('ambient system messages are limited to status annotations', () => {
  assert.equal(isAmbientSystemMessage('LetAgents', '[status] task_1 is in review'), true)
  assert.equal(isAmbientSystemMessage('system', '[STATUS] worker connected'), true)
  assert.equal(isAmbientSystemMessage('LetAgents', 'Authentication failed'), false)
  assert.equal(isAmbientSystemMessage('LetAgents', '[status] Stale work detected'), false)
  assert.equal(isAmbientSystemMessage('LetAgents', '[status] task_1 is blocked'), false)
  assert.equal(isAmbientSystemMessage('agent', '[status] reviewing PR'), false)
  assert.equal(stripStatusPrefix('[status] task_1 is done'), 'task_1 is done')
})

test('stalePromptTaskIdFor accepts only current LetAgents stale prompts', () => {
  assert.equal(
    stalePromptTaskIdFor(message({ sender: 'LetAgents', text: '[status] Stale reminder for task_12' })),
    'task_12',
  )
  assert.equal(
    stalePromptTaskIdFor(message({ sender: 'agent', text: '[status] Stale reminder for task_12' })),
    null,
  )
  assert.equal(
    stalePromptTaskIdFor(message({ sender: 'LetAgents', text: '[status] Fresh task_12' })),
    null,
  )
})

test('isCurrentStalePrompt rejects stale prompt controls after newer task activity', () => {
  const taskState = {
    isStale: true,
    muted: false,
    taskUpdatedAt: '2026-05-28T10:05:00.000Z',
  } satisfies StalePromptTaskState

  assert.equal(isCurrentStalePrompt(taskState, '2026-05-28T10:04:59.000Z'), false)
  assert.equal(isCurrentStalePrompt(taskState, '2026-05-28T10:05:00.000Z'), true)
  assert.equal(isCurrentStalePrompt(null, '2026-05-28T10:05:00.000Z'), false)
})
