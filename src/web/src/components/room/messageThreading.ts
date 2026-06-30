import type { RoomMessage } from '@/composables/useRoom'
import type { MessageThreadSummary } from './chat-message/types'

export type { MessageThreadSummary } from './chat-message/types'

export function messageThreadParentId(message: Pick<RoomMessage, 'id' | 'thread_root_id'>): string | null {
  const threadRootId = message.thread_root_id?.trim()
  return threadRootId && threadRootId !== message.id ? threadRootId : null
}

export function buildMessageThreadSummaries(messages: readonly RoomMessage[]): Map<string, MessageThreadSummary> {
  const summaries = new Map<string, MessageThreadSummary>()

  for (const message of messages) {
    const parentId = messageThreadParentId(message)
    if (!parentId) continue

    const summary = summaries.get(parentId) || { count: 0, latest: null }
    summary.count += 1
    summary.latest = message
    summaries.set(parentId, summary)
  }

  return summaries
}
