export type RoomTab = 'chat' | 'events' | 'board' | 'activity' | 'rooms'

export const ROOM_TABS: readonly RoomTab[] = [
  'chat',
  'events',
  'board',
  'activity',
  'rooms',
]

export type {
  TaskLeaseActionPayload,
  TaskReviewLeaseActionPayload,
  TaskStatusUpdatePayload,
} from '@/components/room/task-board/types'
