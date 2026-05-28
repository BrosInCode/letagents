export type RoomActivityHistoryKind = 'all' | 'agent' | 'human'

export interface RoomActivityHistoryTaskSummary {
  id: string
  title: string
  status: string
  updated_at: string
  workflow_refs: ReadonlyArray<{
    provider: string
    kind: string
    label: string
    url: string
  }>
}

export interface RoomActivityHistoryEntry {
  id: string
  room: {
    id: string
    display_name: string
    kind: 'main' | 'focus'
    focus_status: 'active' | 'concluded' | null
    source_task_id: string | null
  }
  participant: {
    participant_key: string
    kind: 'human' | 'agent'
    actor_label: string | null
    agent_key: string | null
    github_login: string | null
    display_name: string
    owner_label: string | null
    ide_label: string | null
    hidden_at: string | null
    hidden_by: string | null
    last_live_heartbeat_at: string | null
    activity_state: 'active' | 'away' | 'offline' | null
    source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  }
  first_seen_at: string
  last_seen_at: string
  last_room_activity_at: string
  current_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
  completed_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
  created_tasks: ReadonlyArray<RoomActivityHistoryTaskSummary>
}

export interface RoomActivityHistoryPage {
  room_id: string
  root_room_id: string
  selected_room_id: string
  hidden_count: number
  entries: ReadonlyArray<RoomActivityHistoryEntry>
  page: number
  page_size: number
  page_count: number
  total: number
}
