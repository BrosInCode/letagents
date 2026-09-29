import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomMessage, StalePromptTaskState } from '../src/composables/useRoom'
import {
  isAmbientSystemMessage,
  messageDisplayText,
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

test('renderMessageContent escapes HTML before applying markdown formatting', () => {
  assert.equal(
    renderMessageContent('**hi** <script>alert("x")</script> `code`'),
    '<p><strong>hi</strong> &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <code>code</code></p>',
  )
})

test('renderMessageContent linkifies URLs and keeps href attributes escaped', () => {
  assert.equal(
    renderMessageContent('see https://example.com/?q=a&b=c and @codex'),
    '<p>see <a href="https://example.com/?q=a&amp;b=c" target="_blank" rel="noopener noreferrer">https://example.com/?q=a&amp;b=c</a> and <span class="mention-token">@codex</span></p>',
  )
})

test('renderMessageContent preserves collision-safe owner/agent mention handles', () => {
  assert.equal(
    renderMessageContent('@agent:local/EmmyMay/codex/oak please review'),
    '<p><span class="mention-token">@agent:local/EmmyMay/codex/oak</span> please review</p>',
  )
})

test('renderMessageContent links known task references to the Board', () => {
  assert.equal(
    renderMessageContent('Continue task_42, not task_99.', new Set(['task_42'])),
    '<p>Continue <button class="task-reference-link" type="button" data-task-reference-id="task_42" title="Open task_42 on the Board">task_42</button>, not task_99.</p>',
  )
})

test('renderMessageContent does not link task references inside code or URLs', () => {
  assert.equal(
    renderMessageContent(
      'Use `task_42` or https://example.com/task_42 before task_7',
      new Set(['task_42', 'task_7']),
    ),
    '<p>Use <code>task_42</code> or <a href="https://example.com/task_42" target="_blank" rel="noopener noreferrer">https://example.com/task_42</a> before <button class="task-reference-link" type="button" data-task-reference-id="task_7" title="Open task_7 on the Board">task_7</button></p>',
  )
})

test('renderMessageContent renders safe block markdown', () => {
  assert.equal(
    renderMessageContent([
      '## Review',
      '',
      '- **Approved**',
      '- [x] Tests pass',
      '',
      '> Use `npm test`',
      '',
      '1. Ship',
      '2. Monitor',
      '',
      '```ts',
      'const safe = "<ok>"',
      '```',
    ].join('\n')),
    '<h2>Review</h2><ul><li><strong>Approved</strong></li><li><input class="markdown-task-checkbox" type="checkbox" disabled checked>Tests pass</li></ul><blockquote><p>Use <code>npm test</code></p></blockquote><ol><li>Ship</li><li>Monitor</li></ol><pre><code class="language-ts">const safe = &quot;&lt;ok&gt;&quot;</code></pre>',
  )
})

test('renderMessageContent bounds adversarial blockquote nesting', () => {
  const html = renderMessageContent(`${'>'.repeat(5_000)} safe`)
  assert.match(html, /safe/)
  assert.ok((html.match(/<blockquote>/g) || []).length <= 9)
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


test('board notification display shows names and tasks without agent control instructions', () => {
  const notification = message({
    sender: 'letagents', source: 'system',
    text: '@agent:owner/lumen Board intent bi_123 was approved. Continue with board_intent_id.',
    display_text: '@LumenRiver — Your request to claim task_19: “Tests and CI” was approved. You can continue.',
  })
  const html = renderMessageContent(messageDisplayText(notification), new Set(['task_19']))
  assert.match(html, /mention-token[^>]*>@LumenRiver/)
  assert.match(html, /data-task-reference-id="task_19"/)
  assert.match(html, /Tests and CI/)
  assert.doesNotMatch(html, /owner\/lumen|bi_123|board_intent_id/)
  assert.match(notification.text, /board_intent_id/)
  assert.equal(messageDisplayText(message({ text: 'Ordinary message' })), 'Ordinary message')
})
