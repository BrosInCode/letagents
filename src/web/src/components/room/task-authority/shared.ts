import type { RoomAgentPresence, RoomTask } from '@/composables/useRoom'
import { isLivePresenceEntry } from '../reachability'

export type TaskLease = NonNullable<RoomTask['active_leases']>[number]

export function formatAuthorityActorName(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const parts = normalized.split('|').map(part => part.trim()).filter(Boolean)
  return parts[0] || normalized
}

export function getReachableWorkerCandidates(
  presence: readonly RoomAgentPresence[],
): RoomAgentPresence[] {
  return presence
    .filter(entry =>
      isLivePresenceEntry(entry)
      && Boolean(entry.agent_key)
      && Boolean(entry.agent_session_id)
    )
    .sort((left, right) => left.display_name.localeCompare(right.display_name))
}

export function getWorkerCandidateKey(candidate: RoomAgentPresence): string {
  return [
    candidate.agent_key,
    candidate.agent_instance_id ?? 'no-instance',
    candidate.agent_session_id ?? candidate.actor_label,
  ].join(':')
}

export function formatWorkerCandidate(candidate: RoomAgentPresence): string {
  const owner = candidate.owner_label ? ` · ${candidate.owner_label}` : ''
  const runtime = candidate.runtime && candidate.runtime !== 'unknown' ? ` · ${candidate.runtime}` : ''
  const session = candidate.agent_session_id ? ` · ${candidate.agent_session_id.slice(-6)}` : ''
  return `${candidate.display_name}${owner}${runtime}${session}`
}

export function presenceMatchesLeaseSession(
  entry: RoomAgentPresence,
  lease: TaskLease,
): boolean {
  if (!entry.agent_key || entry.agent_key !== lease.agent_key) return false
  if (lease.agent_session_id) {
    return entry.agent_session_id === lease.agent_session_id
  }
  if (lease.agent_instance_id) {
    return entry.agent_instance_id === lease.agent_instance_id
  }
  return entry.actor_label === lease.actor_label
}

export function presenceMatchesLeaseAgent(
  entry: RoomAgentPresence,
  lease: TaskLease | null,
): boolean {
  return Boolean(lease && entry.agent_key && entry.agent_key === lease.agent_key)
}

export function toLeaseActionTarget(candidate: RoomAgentPresence): {
  target_actor_key: string
  target_actor_instance_id: string | null
  target_agent_session_id: string
} {
  return {
    target_actor_key: candidate.agent_key!,
    target_actor_instance_id: candidate.agent_instance_id ?? null,
    target_agent_session_id: candidate.agent_session_id!,
  }
}
