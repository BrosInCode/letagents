import type { RoomAgentPresence, RoomTask } from '@/composables/useRoom'
import {
  getReachableWorkerCandidates,
  getWorkerCandidateKey,
  presenceMatchesLeaseAgent,
  type TaskLease,
} from '../task-authority/shared'

export type ReviewState = 'assigned' | 'missing' | 'invalid' | 'idle'

export type ReviewLeaseActionPayload = {
  taskId: string
  action: 'assign' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}

export type ReviewAuthoritySummary = {
  state: ReviewState
  label: string
  detail: string
}

const REVIEW_STATUSES = new Set(['in_review', 'blocked'])

export function getWorkLease(task: RoomTask): TaskLease | null {
  return task.active_leases?.find(lease => lease.kind === 'work') ?? null
}

export function getReviewLeases(task: RoomTask): TaskLease[] {
  return (task.active_leases ?? []).filter(lease => lease.kind === 'review')
}

export function shouldShowReviewLane(task: RoomTask): boolean {
  return REVIEW_STATUSES.has(task.status) || getReviewLeases(task).length > 0
}

export function reviewLeaseMatchesWork(
  reviewLease: TaskLease,
  workLease: TaskLease | null,
): boolean {
  return Boolean(workLease && reviewLease.agent_key === workLease.agent_key)
}

export function getReviewState(task: RoomTask): ReviewAuthoritySummary {
  const workLease = getWorkLease(task)
  const reviewLeases = getReviewLeases(task)
  const hasInvalidReviewLease = reviewLeases.some(lease => reviewLeaseMatchesWork(lease, workLease))
  const validReviewLeaseCount = reviewLeases.filter(lease => !reviewLeaseMatchesWork(lease, workLease)).length

  if (!shouldShowReviewLane(task)) {
    return {
      state: 'idle',
      label: 'Review not active',
      detail: 'Move the task to review before assigning board review authority.',
    }
  }
  if (hasInvalidReviewLease) {
    return {
      state: 'invalid',
      label: 'Reviewer conflicts with work holder',
      detail: 'At least one reviewer also matches the active work lease. Assign a different worker before treating the board review as valid.',
    }
  }
  if (validReviewLeaseCount > 0) {
    return {
      state: 'assigned',
      label: 'Reviewer assigned',
      detail: 'A separate worker has board review authority for this task. Review decisions should come from that lane.',
    }
  }
  return {
    state: 'missing',
    label: 'Review unassigned',
    detail: 'This task is waiting for an explicit LetAgents reviewer. Assign a reachable worker before merge handoff.',
  }
}

export function getReviewBadgeVariant(state: ReviewState): 'success' | 'warning' | 'default' {
  switch (state) {
    case 'assigned':
      return 'success'
    case 'missing':
    case 'invalid':
      return 'warning'
    default:
      return 'default'
  }
}

export function getReviewBadgeLabel(state: ReviewState): string {
  switch (state) {
    case 'assigned':
      return 'Assigned'
    case 'invalid':
      return 'Conflict'
    case 'missing':
      return 'Needed'
    default:
      return 'Idle'
  }
}

export function getReviewCandidates(
  presence: readonly RoomAgentPresence[],
  workLease: TaskLease | null,
  reviewLeases: readonly TaskLease[],
): RoomAgentPresence[] {
  const seen = new Set<string>()
  return getReachableWorkerCandidates(presence)
    .filter(entry =>
      !presenceMatchesLeaseAgent(entry, workLease)
      && !reviewLeases.some(lease => presenceMatchesLeaseAgent(entry, lease))
    )
    .filter((entry) => {
      const key = getWorkerCandidateKey(entry)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}
