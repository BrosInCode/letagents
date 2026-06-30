import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildMessageThreadSummaries,
  messageThreadParentId,
} from '../src/components/room/messageThreading'
import type { RoomMessage } from '../src/composables/useRoom'

describe('web message threading helpers', () => {
  it('keeps quote replies out of thread summaries without an explicit thread root', () => {
    const messages = [
      message({ id: 'msg_1', thread_root_id: 'msg_1' }),
      message({
        id: 'msg_2',
        thread_root_id: 'msg_2',
        thread_reply_to_id: 'msg_1',
        reply_to: replyReference('msg_1'),
      }),
      message({
        id: 'msg_3',
        thread_root_id: 'msg_1',
        thread_reply_to_id: 'msg_1',
        reply_to: replyReference('msg_1'),
      }),
    ]

    const summaries = buildMessageThreadSummaries(messages)

    assert.equal(messageThreadParentId(messages[1]), null)
    assert.equal(messageThreadParentId(messages[2]), 'msg_1')
    assert.equal(summaries.get('msg_1')?.count, 1)
    assert.equal(summaries.get('msg_1')?.latest?.id, 'msg_3')
  })
})

function message(overrides: Partial<RoomMessage>): RoomMessage {
  return {
    id: 'msg_1',
    sender: 'Emmy',
    text: 'hello',
    attachments: [],
    source: 'browser',
    timestamp: '2026-05-28T00:00:00.000Z',
    thread_root_id: 'msg_1',
    thread_reply_to_id: null,
    reply_to: null,
    ...overrides,
  }
}

function replyReference(id: string): NonNullable<RoomMessage['reply_to']> {
  return {
    id,
    sender: 'Emmy',
    text: id,
    source: 'browser',
    timestamp: '2026-05-28T00:00:00.000Z',
  }
}
