import type {
  FocusActivityScope,
  FocusGitHubEventRouting,
  FocusParentVisibility,
  FocusRoomBlockerState,
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomParentTaskNextAction,
  FocusRoomReviewState,
} from '@/composables/useRoom'
import {
  gitRoomAccessLabel,
  gitRoomProviderLabel,
  gitRoomRefLabel,
  gitRoomRefTypeLabel,
} from '../gitRoomLabels'

export {
  gitRoomAccessLabel,
  gitRoomProviderLabel,
  gitRoomRefLabel,
  gitRoomRefTypeLabel,
}

export interface FocusOption<T extends string> {
  value: T
  label: string
}

export const parentVisibilityOptions: Array<FocusOption<FocusParentVisibility>> = [
  { value: 'summary_only', label: 'Only the final note' },
  { value: 'major_activity', label: 'Important updates' },
  { value: 'all_activity', label: 'Every update' },
  { value: 'silent', label: 'Nothing automatic' },
]

export const activityScopeOptions: Array<FocusOption<FocusActivityScope>> = [
  { value: 'task_and_branch', label: 'Task and linked code' },
  { value: 'task_only', label: 'This task only' },
  { value: 'room', label: 'Everything in this room' },
]

export const githubEventRoutingOptions: Array<FocusOption<FocusGitHubEventRouting>> = [
  { value: 'task_and_branch', label: 'Related code activity' },
  { value: 'focus_owned_only', label: 'Keep related code here' },
  { value: 'task_only', label: 'Only task mentions' },
  { value: 'all_parent_repo', label: 'All repo activity' },
  { value: 'off', label: 'No code activity' },
]

export const reviewStateOptions: Array<FocusOption<FocusRoomReviewState>> = [
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'not_required', label: 'Review not required' },
]

export const blockerStateOptions: Array<FocusOption<FocusRoomBlockerState>> = [
  { value: 'none', label: 'No blockers' },
  { value: 'resolved', label: 'Blockers resolved' },
  { value: 'blocked', label: 'Still blocked' },
]

export const parentTaskNextOptions: Array<FocusOption<FocusRoomParentTaskNextAction>> = [
  { value: 'keep_open', label: 'Keep open' },
  { value: 'move_to_review', label: 'Move to review' },
  { value: 'mark_blocked', label: 'Mark blocked' },
  { value: 'mark_done', label: 'Mark done' },
  { value: 'follow_up', label: 'Create follow-up' },
]

const parentVisibilityLabels = new Map(parentVisibilityOptions.map(option => [option.value, option.label]))
const activityScopeLabels = new Map(activityScopeOptions.map(option => [option.value, option.label]))
const githubEventRoutingLabels = new Map(githubEventRoutingOptions.map(option => [option.value, option.label]))
const reviewStateLabels = new Map(reviewStateOptions.map(option => [option.value, option.label]))
const blockerStateLabels = new Map(blockerStateOptions.map(option => [option.value, option.label]))
const parentTaskNextLabels = new Map(parentTaskNextOptions.map(option => [option.value, option.label]))

export function createEmptyCloseoutDetails(): FocusRoomConclusionDetails {
  return {
    artifact: '',
    review_state: 'needs_review',
    blocker_state: 'none',
    parent_task_next: 'keep_open',
    next_owner: '',
  }
}

export function focusRoomOpenKey(focusRoom: FocusRoomInfo): string {
  return focusRoom.focus_key || focusRoom.source_task_id || focusRoom.room_id
}

export function parentVisibilityLabel(value: FocusParentVisibility): string {
  return parentVisibilityLabels.get(value) ?? parentVisibilityLabels.get('summary_only')!
}

export function activityScopeLabel(value: FocusActivityScope): string {
  return activityScopeLabels.get(value) ?? activityScopeLabels.get('task_and_branch')!
}

export function githubRoutingLabel(value: FocusGitHubEventRouting): string {
  return githubEventRoutingLabels.get(value) ?? githubEventRoutingLabels.get('task_and_branch')!
}

export function reviewStateLabel(value: FocusRoomReviewState): string {
  return reviewStateLabels.get(value) ?? value
}

export function blockerStateLabel(value: FocusRoomBlockerState): string {
  return blockerStateLabels.get(value) ?? value
}

export function parentTaskNextLabel(value: FocusRoomParentTaskNextAction): string {
  return parentTaskNextLabels.get(value) ?? value
}

export function taskStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

export function formatAuditTime(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
