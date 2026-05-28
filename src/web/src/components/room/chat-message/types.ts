import type { RoomMessage } from '@/composables/useRoom'

export interface MessageThreadSummary {
  count: number
  latest: RoomMessage | null
}

export interface ProvenanceBadge {
  label: string
  className: string
}
