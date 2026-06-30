import type { RoomMessage } from '@/composables/useRoom'
import type { MessageThreadSummary } from './types'

function explicitThreadRootId(message: RoomMessage): string | null {
  const rootId = (message.thread_root_id || message.thread?.root_message_id || '').trim()
  if (!rootId || rootId === message.id) return null
  return rootId
}

function serverThreadSummary(message: RoomMessage): MessageThreadSummary | null {
  const thread = message.thread
  if (!thread || thread.root_message_id !== message.id || thread.reply_count <= 0) {
    return null
  }
  return {
    count: thread.reply_count,
    latest: thread.latest_reply,
  }
}

export function buildVisibleThreadSummaries(
  messages: readonly RoomMessage[],
): Map<string, MessageThreadSummary> {
  const summaries = new Map<string, MessageThreadSummary>()

  for (const msg of messages) {
    const summary = serverThreadSummary(msg)
    if (summary) {
      summaries.set(msg.id, summary)
    }
  }

  for (const msg of messages) {
    const parentId = explicitThreadRootId(msg)
    if (!parentId || summaries.has(parentId)) continue

    const summary = summaries.get(parentId) || { count: 0, latest: null }
    summary.count += 1
    summary.latest = msg
    summaries.set(parentId, summary)
  }

  return summaries
}
