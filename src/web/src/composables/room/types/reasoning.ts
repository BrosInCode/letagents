export interface RoomReasoningSnapshot {
  summary: string
  goal?: string | null
  checking?: string | null
  hypothesis?: string | null
  blocker?: string | null
  next_action?: string | null
  milestone?: string | null
  status?: string | null
  confidence?: number | null
}

export interface RoomReasoningEntry {
  id: string
  kind?: string | null
  label?: string | null
  text: string
  timestamp: string
}

export interface RoomReasoningUpdate {
  id: string
  actor_label?: string | null
  status?: string | null
  summary: string
  milestone?: string | null
  payload?: RoomReasoningSnapshot | null
  created_at: string
}

export interface RoomReasoningSession {
  id: string
  room_id?: string | null
  actor_label?: string | null
  agent_key?: string | null
  anchor_message_id?: string | null
  task_id?: string | null
  title?: string | null
  status?: string | null
  visibility?: string | null
  summary?: string | null
  latest_payload?: RoomReasoningSnapshot | null
  goal?: string | null
  checking?: string | null
  hypothesis?: string | null
  blocker?: string | null
  next_action?: string | null
  milestone?: string | null
  confidence?: number | null
  entries?: ReadonlyArray<RoomReasoningEntry> | null
  updates?: ReadonlyArray<RoomReasoningUpdate> | null
  closed_at?: string | null
  created_at?: string | null
  updated_at?: string | null
}
