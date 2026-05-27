export type FocusParentVisibility =
  | 'summary_only'
  | 'major_activity'
  | 'all_activity'
  | 'silent'
export type FocusActivityScope = 'task_and_branch' | 'task_only' | 'room'
export type FocusGitHubEventRouting =
  | 'task_and_branch'
  | 'focus_owned_only'
  | 'task_only'
  | 'all_parent_repo'
  | 'off'

export interface FocusRoomSettings {
  parent_visibility: FocusParentVisibility
  activity_scope: FocusActivityScope
  github_event_routing: FocusGitHubEventRouting
}

export type FocusRoomSettingsPatch = Partial<FocusRoomSettings>

export const DEFAULT_FOCUS_ROOM_SETTINGS: FocusRoomSettings = {
  parent_visibility: 'summary_only',
  activity_scope: 'task_and_branch',
  github_event_routing: 'task_and_branch',
}

export function focusRoomSettingsFrom(
  value:
    | {
        focus_settings?: FocusRoomSettings | null
        focus_parent_visibility?: FocusParentVisibility | null
        focus_activity_scope?: FocusActivityScope | null
        focus_github_event_routing?: FocusGitHubEventRouting | null
      }
    | null
    | undefined,
): FocusRoomSettings {
  return {
    parent_visibility:
      value?.focus_settings?.parent_visibility ||
      value?.focus_parent_visibility ||
      DEFAULT_FOCUS_ROOM_SETTINGS.parent_visibility,
    activity_scope:
      value?.focus_settings?.activity_scope ||
      value?.focus_activity_scope ||
      DEFAULT_FOCUS_ROOM_SETTINGS.activity_scope,
    github_event_routing:
      value?.focus_settings?.github_event_routing ||
      value?.focus_github_event_routing ||
      DEFAULT_FOCUS_ROOM_SETTINGS.github_event_routing,
  }
}

export interface MessageReplyReference {
  id: string
  sender: string
  text: string
  source: string | null
  timestamp: string
}

export interface RoomMessageAttachment {
  id?: string | null
  name?: string | null
  file_name?: string | null
  filename?: string | null
  mime_type?: string | null
  content_type?: string | null
  size_bytes?: number | null
  byte_size?: number | null
  url?: string | null
  download_url?: string | null
  data_url?: string | null
  content_base64?: string | null
}

export interface OutgoingMessageAttachment {
  file_name: string
  mime_type: string
  size_bytes: number
  file?: File | null
  upload_id?: string | null
}

export interface StagedMessageAttachment {
  upload_id: string
}

export interface AttachmentUploadTarget {
  upload_id?: string
  attachment_id?: string
  id?: string
  upload_url?: string
  url?: string
  method?: string
  headers?: Record<string, string>
  attachment?: {
    upload_id?: string
    attachment_id?: string
    id?: string
  }
}

export interface RoomMessage {
  id: string
  sender: string
  text: string
  attachments?: readonly RoomMessageAttachment[]
  agent_prompt_kind?: string | null
  source: string | null
  timestamp: string
  reply_to?: MessageReplyReference | null
  agent_identity?: {
    name: string
    display_name: string
    owner_label: string
    owner_attribution: string
    ide_label: string
    actor_label: string
  } | null
}

export interface RoomTask {
  id: string
  title: string
  description: string
  status: string
  assignee: string | null
  assignee_agent_key: string | null
  created_by: string | null
  pr_url: string | null
  workflow_artifacts: ReadonlyArray<{
    provider: string
    kind: string
    id?: string | null
    number?: number | null
    title?: string | null
    url?: string | null
    ref?: string | null
    state?: string | null
  }>
  workflow_refs: ReadonlyArray<{
    provider: string
    kind: string
    label: string
    url: string
  }>
  stale_prompt_state?: {
    is_stale: boolean
    reason: string | null
    stale_for_ms: number | null
    muted: boolean
    muted_by: string | null
    muted_at: string | null
  } | null
  created_at: string
  updated_at: string
  active_leases?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string
    kind: 'work' | 'review' | 'coordination'
    status: 'active' | 'released' | 'revoked' | 'expired'
    agent_key: string
    agent_instance_id: string | null
    agent_session_id: string | null
    actor_label: string
    branch_ref: string | null
    pr_url: string | null
    output_intent: string | null
  }>
  active_locks?: ReadonlyArray<{
    id: string
    room_id: string
    task_id: string | null
    scope: 'room' | 'task'
    reason: string | null
    message: string | null
    created_by: string
    cleared_at: string | null
  }>
}

export interface TaskLeaseActionInput {
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
}

export interface TaskReviewLeaseActionInput {
  action: 'assign' | 'claim' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
}

export interface StalePromptTaskState {
  isStale: boolean
  muted: boolean
  taskUpdatedAt: string
}

export interface TaskGitHubArtifactStatus {
  task_id: string
  pr_state: string | null
  pr_title: string | null
  pr_url: string | null
  pr_number: string | null
  pr_author: string | null
  pr_actor: string | null
  pr_draft: boolean | null
  pr_merged: boolean | null
  checks: ReadonlyArray<{
    name: string
    conclusion: string | null
    state: string | null
    actor: string | null
  }>
  reviews: ReadonlyArray<{
    actor: string | null
    state: string | null
  }>
  check_summary: {
    total: number
    success: number
    failure: number
    pending: number
  }
  review_summary: {
    total: number
    approved: number
    changes_requested: number
  }
}

export interface RoomInfo {
  projectId: string
  identifier: string
  code: string
  name: string
  displayName: string
  role: string
  authenticated: boolean
  kind: 'main' | 'focus'
  attachmentsEnabled: boolean
  parentRoomId: string | null
  focusKey: string | null
  sourceTaskId: string | null
  focusStatus: 'active' | 'concluded' | null
  focusParentVisibility: FocusParentVisibility | null
  focusActivityScope: FocusActivityScope | null
  focusGitHubEventRouting: FocusGitHubEventRouting | null
  concludedAt: string | null
  conclusionSummary: string | null
  conclusionDetails: FocusRoomConclusionDetails | null
}

export type FocusRoomReviewState = 'reviewed' | 'needs_review' | 'not_required'
export type FocusRoomBlockerState = 'none' | 'resolved' | 'blocked'
export type FocusRoomParentTaskNextAction =
  | 'keep_open'
  | 'move_to_review'
  | 'mark_blocked'
  | 'mark_done'
  | 'follow_up'

export interface FocusRoomConclusionDetails {
  artifact: string
  review_state: FocusRoomReviewState
  blocker_state: FocusRoomBlockerState
  parent_task_next: FocusRoomParentTaskNextAction
  next_owner: string
}

export interface FocusRoomInfo {
  room_id: string
  name: string | null
  display_name: string
  code: string | null
  kind: 'main' | 'focus'
  attachments_enabled?: boolean
  parent_room_id: string | null
  focus_key: string | null
  source_task_id: string | null
  focus_status: 'active' | 'concluded' | null
  focus_parent_visibility: FocusParentVisibility | null
  focus_activity_scope: FocusActivityScope | null
  focus_github_event_routing: FocusGitHubEventRouting | null
  focus_settings?: FocusRoomSettings | null
  concluded_at: string | null
  conclusion_summary: string | null
  conclusion_details: FocusRoomConclusionDetails | null
  created_at: string
  role?: string
  authenticated?: boolean
}

export type RoomAgentPromptKind = 'join' | 'inline' | 'auto'

export interface RoomJoinError {
  status: number | null
  code: string | null
  message: string
  roomId: string | null
  deviceFlowUrl: string | null
}

export type RoomGitHubEventType =
  | 'pull_request'
  | 'issue'
  | 'issue_comment'
  | 'pull_request_review'
  | 'check_run'
  | 'installation'
  | 'installation_repositories'
  | 'repository'

export interface RoomGitHubEvent {
  id: string
  event_type: RoomGitHubEventType
  action: string
  github_object_id: string | null
  github_object_url: string | null
  title: string | null
  state: string | null
  actor_login: string | null
  metadata: Record<string, unknown> | null
  linked_task_id: string | null
  created_at: string
}

export interface RoomAgentPresence {
  room_id: string
  actor_label: string
  agent_key: string | null
  agent_instance_id: string | null
  agent_session_id: string | null
  session_kind: 'controller' | 'worker'
  runtime: string
  display_name: string
  owner_label: string | null
  ide_label: string | null
  status: 'idle' | 'working' | 'reviewing' | 'blocked'
  status_text: string | null
  last_heartbeat_at: string
  created_at: string
  updated_at: string
  freshness: 'active' | 'stale'
  activity_state: 'active' | 'away' | 'offline'
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  liveness_observation: {
    room_id: string
    agent_session_id: string
    source: string
    host_id: string | null
    host_kind: string | null
    host_label: string | null
    liveness_capability: string
    tool_bridge_id: string | null
    last_observed_at: string
    last_tool_call_at: string | null
    detail: string | null
    created_at: string
    updated_at: string
  } | null
}

export interface RoomParticipant {
  room_id: string
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
  last_seen_at: string
  last_room_activity_at: string | null
  last_live_heartbeat_at: string | null
  activity_state: 'active' | 'away' | 'offline' | null
  source_flags: ReadonlyArray<'delivery' | 'presence' | 'messages' | 'tasks'>
  created_at: string
  updated_at: string
}

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

export interface MessagePage {
  messages: RoomMessage[]
  hasOlder: boolean
}

export interface RoomParticipantsPage {
  participants: RoomParticipant[]
  hidden_count: number
}
