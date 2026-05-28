import type { RoomTask } from '@/composables/useRoom'
import {
  formatAuthorityActorName,
  type TaskLease,
} from '../task-authority/shared'

export type AuthorityState = 'held' | 'mismatch' | 'missing'

export type LeaseActionPayload = {
  taskId: string
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}

export function getWorkLease(task: RoomTask): TaskLease | null {
  return task.active_leases?.find(lease => lease.kind === 'work') ?? null
}

export function getLeaseArtifacts(lease: TaskLease | null): Array<{ key: string; label: string }> {
  if (!lease) return []
  return [
    lease.branch_ref ? { key: 'branch', label: `Branch: ${lease.branch_ref}` } : null,
    lease.output_intent ? { key: 'intent', label: lease.output_intent } : null,
  ].filter((item): item is { key: string; label: string } => Boolean(item))
}

export function getAuthorityState(task: RoomTask): {
  state: AuthorityState
  label: string
  detail: string
} {
  const lease = getWorkLease(task)
  if (lease) {
    const owner = formatAuthorityActorName(task.assignee)
    const holder = formatAuthorityActorName(lease.actor_label)
    if (owner && !taskOwnerMatchesLease(task, lease)) {
      return {
        state: 'mismatch',
        label: 'Lease overrides owner',
        detail: `Assigned to ${owner}, but execution authority is held by ${holder}. Handoff or release the lease to make the lane explicit.`,
      }
    }
    return {
      state: 'held',
      label: 'Lane held',
      detail: `${holder} has the active work lease. This is the actor/session authorized to mutate the work lane.`,
    }
  }

  if (task.assignee && ['assigned', 'in_progress', 'blocked', 'in_review'].includes(task.status)) {
    return {
      state: 'missing',
      label: 'No active lease',
      detail: 'This task has an owner/status but no work lease, so execution authority is not explicit yet.',
    }
  }

  return {
    state: 'missing',
    label: 'No active lease',
    detail: 'No worker currently holds execution authority for this task.',
  }
}

export function getAuthorityBadgeVariant(state: AuthorityState): 'success' | 'warning' | 'default' {
  switch (state) {
    case 'held':
      return 'success'
    case 'mismatch':
      return 'warning'
    default:
      return 'default'
  }
}

export function getAuthorityBadgeLabel(state: AuthorityState): string {
  switch (state) {
    case 'held':
      return 'Lane held'
    case 'mismatch':
      return 'Mismatch'
    default:
      return 'Missing'
  }
}

function normalizeActor(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function taskOwnerMatchesLease(task: RoomTask, lease: TaskLease): boolean {
  const assigneeKey = normalizeActor(task.assignee_agent_key)
  const leaseAgentKey = normalizeActor(lease.agent_key)
  if (assigneeKey && leaseAgentKey) {
    return assigneeKey === leaseAgentKey
  }
  return normalizeActor(task.assignee) === normalizeActor(lease.actor_label)
}
