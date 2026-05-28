export type RoomTab = 'chat' | 'events' | 'board' | 'activity' | 'rooms'

export const ROOM_TABS: readonly RoomTab[] = [
  'chat',
  'events',
  'board',
  'activity',
  'rooms',
]

export interface TaskLeaseActionPayload {
  taskId: string
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}

export interface TaskReviewLeaseActionPayload {
  taskId: string
  action: 'assign' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}
