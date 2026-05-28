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
