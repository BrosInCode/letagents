import type { ParticipantActivityState } from './types'

export const STATUS_ORDER = ['working', 'reviewing', 'blocked', 'idle'] as const

export const ACTIVITY_STATE_LABELS: Record<ParticipantActivityState, string> = {
  active: 'Connected',
  away: 'Connected',
  offline: 'Recently disconnected',
}

export const TASK_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  merged: 'Merged',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const COMPLETED_TASK_STATUSES = new Set(['merged', 'done'])
export const OPEN_TASK_STATUSES = new Set([
  'proposed',
  'accepted',
  'assigned',
  'in_progress',
  'blocked',
  'in_review',
])
export const INACTIVE_REASONING_STATUSES = new Set([
  'completed',
  'done',
  'dismissed',
  'closed',
])
