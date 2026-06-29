import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomMessage, StalePromptTaskState } from '../src/composables/useRoom'
import { renderMessageContent } from '../src/components/room/chat-message/formatting'
import { isCurrentStalePrompt, stalePromptTaskIdFor } from '../src/components/room/chat-message/stalePrompt'

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

test('renderMessageContent turns loaded message ids into reference tokens', () => {
  assert.equal(
    renderMessageContent('compare msg_14 with msg_15', {
      resolveMessageReference: (messageId) => (
        messageId === 'msg_14'
          ? { id: 'msg_14', sender: 'agent', text: 'Earlier decision details' }
          : null
      ),
    }),
    'compare <button type="button" class="message-ref-token" data-message-ref-id="msg_14" data-message-ref-preview="agent: Earlier decision details" aria-label="Open msg_14" title="Open msg_14">msg_14</button> with <button type="button" class="message-ref-token unresolved" data-message-ref-id="msg_15" data-message-ref-preview="Message is not loaded in this transcript window." aria-label="msg_15 is not loaded" title="msg_15 is not loaded">msg_15</button>',
  )
})

test('renderMessageContent does not tokenize message ids inside inline code', () => {
  assert.equal(
    renderMessageContent('plain msg_14 and `msg_15`', {
      resolveMessageReference: (messageId) => ({ id: messageId, sender: 'agent', text: 'loaded' }),
    }),
    'plain <button type="button" class="message-ref-token" data-message-ref-id="msg_14" data-message-ref-preview="agent: loaded" aria-label="Open msg_14" title="Open msg_14">msg_14</button> and <code>msg_15</code>',
  )
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
