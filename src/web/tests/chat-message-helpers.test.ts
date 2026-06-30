import assert from 'node:assert/strict'
import test from 'node:test'

import type { RoomMessage, StalePromptTaskState } from '../src/composables/useRoom'
import { renderMessageContent } from '../src/components/room/chat-message/formatting'
import { isCurrentStalePrompt, stalePromptTaskIdFor } from '../src/components/room/chat-message/stalePrompt'
import { buildVisibleThreadSummaries } from '../src/components/room/chat-message/threadSummaries'

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

test('renderMessageContent turns standalone message ids into reference tokens', () => {
  assert.equal(
    renderMessageContent('compare msg_14 with msg_15.'),
    'compare <button type="button" class="message-ref-token" data-message-ref-id="msg_14" aria-label="Open msg_14">msg_14</button> with <button type="button" class="message-ref-token" data-message-ref-id="msg_15" aria-label="Open msg_15">msg_15</button>.',
  )
})

test('renderMessageContent does not tokenize message ids inside inline code', () => {
  assert.equal(
    renderMessageContent('plain msg_14 and `msg_15`'),
    'plain <button type="button" class="message-ref-token" data-message-ref-id="msg_14" aria-label="Open msg_14">msg_14</button> and <code>msg_15</code>',
  )
})

test('renderMessageContent tokenizes comma-separated message ids', () => {
  assert.equal(
    renderMessageContent('see msg_14,msg_15;msg_16'),
    'see <button type="button" class="message-ref-token" data-message-ref-id="msg_14" aria-label="Open msg_14">msg_14</button>,<button type="button" class="message-ref-token" data-message-ref-id="msg_15" aria-label="Open msg_15">msg_15</button>;<button type="button" class="message-ref-token" data-message-ref-id="msg_16" aria-label="Open msg_16">msg_16</button>',
  )
})

test('renderMessageContent does not tokenize message ids inside paths', () => {
  assert.equal(
    renderMessageContent('GET /rooms/main/messages/msg_14/thread then open msg_15'),
    'GET /rooms/main/messages/msg_14/thread then open <button type="button" class="message-ref-token" data-message-ref-id="msg_15" aria-label="Open msg_15">msg_15</button>',
  )
})

test('buildVisibleThreadSummaries ignores quote replies without explicit thread roots', () => {
  const root = message({ id: 'msg_1', text: 'Original topic', thread_root_id: 'msg_1' })
  const quoteReply = message({
    id: 'msg_2',
    text: 'Quoted reply',
    reply_to: {
      id: 'msg_1',
      sender: 'human',
      text: 'Original topic',
      source: 'browser',
      timestamp: '2026-05-28T10:00:00.000Z',
    },
    thread_root_id: 'msg_2',
  })

  assert.equal(buildVisibleThreadSummaries([root, quoteReply]).size, 0)
})

test('buildVisibleThreadSummaries counts explicit thread replies', () => {
  const root = message({ id: 'msg_1', text: 'Original topic', thread_root_id: 'msg_1' })
  const threadReply = message({
    id: 'msg_2',
    text: 'Thread reply',
    reply_to: {
      id: 'msg_1',
      sender: 'human',
      text: 'Original topic',
      source: 'browser',
      timestamp: '2026-05-28T10:00:00.000Z',
    },
    thread_root_id: 'msg_1',
    thread_reply_to_id: 'msg_1',
  })

  const summaries = buildVisibleThreadSummaries([root, threadReply])
  assert.equal(summaries.get('msg_1')?.count, 1)
  assert.equal(summaries.get('msg_1')?.latest?.id, 'msg_2')
})

test('buildVisibleThreadSummaries uses server summaries for loaded roots', () => {
  const root = message({
    id: 'msg_1',
    text: 'Original topic',
    thread_root_id: 'msg_1',
    thread: {
      root_message_id: 'msg_1',
      reply_count: 3,
      unread_count: 0,
      has_unread: false,
      latest_reply: {
        id: 'msg_9',
        sender: 'agent',
        text: 'Latest reply outside the loaded window',
        source: 'agent',
        timestamp: '2026-05-28T10:09:00.000Z',
      },
      last_read_message_id: null,
    },
  })

  const summaries = buildVisibleThreadSummaries([root])
  assert.equal(summaries.get('msg_1')?.count, 3)
  assert.equal(summaries.get('msg_1')?.latest?.id, 'msg_9')
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
