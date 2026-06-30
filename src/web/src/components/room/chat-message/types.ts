import type { MessageReplyReference, RoomMessage } from '@/composables/useRoom'

export interface MessageThreadSummary {
  count: number
  latest: MessageReplyReference | RoomMessage | null
}

export interface ProvenanceBadge {
  label: string
  className: string
}
