import type { ParticipantActivityState } from './types'
import { TASK_STATUS_LABELS } from '../../../domain/taskStatus'

export const STATUS_ORDER = ['working', 'reviewing', 'blocked', 'idle'] as const

export const ACTIVITY_STATE_LABELS: Record<ParticipantActivityState, string> = {
  active: 'Connected',
  away: 'Connected',
  offline: 'Recently disconnected',
}

export { TASK_STATUS_LABELS }

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
