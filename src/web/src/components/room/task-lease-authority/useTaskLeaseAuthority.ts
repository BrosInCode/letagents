import { computed, ref } from 'vue'
import type { RoomAgentPresence, RoomTask } from '@/composables/useRoom'
import {
  formatAuthorityActorName,
  formatWorkerCandidate,
  getReachableWorkerCandidates,
  getWorkerCandidateKey,
  presenceMatchesLeaseSession,
  toLeaseActionTarget,
} from '../task-authority/shared'
import {
  getAuthorityBadgeLabel,
  getAuthorityBadgeVariant,
  getAuthorityState,
  getLeaseArtifacts,
  getWorkLease,
  type LeaseActionPayload,
} from './model'

type TaskLeaseAuthorityProps = {
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
}

type EmitLeaseAction = (event: 'leaseAction', payload: LeaseActionPayload) => void

export function useTaskLeaseAuthority(
  props: TaskLeaseAuthorityProps,
  emit: EmitLeaseAction,
) {
  const selectedHandoffTarget = ref('')
  const pendingAction = ref<'release' | 'handoff' | null>(null)

  const workLease = computed(() => getWorkLease(props.task))
  const authority = computed(() => getAuthorityState(props.task))
  const badgeVariant = computed(() => getAuthorityBadgeVariant(authority.value.state))
  const badgeLabel = computed(() => getAuthorityBadgeLabel(authority.value.state))
  const leaseArtifacts = computed(() => getLeaseArtifacts(workLease.value))
  const hasLeaseArtifacts = computed(() =>
    Boolean(workLease.value?.pr_url || leaseArtifacts.value.length)
  )

  const handoffCandidatesForTask = computed(() => {
    const lease = workLease.value
    const seen = new Set<string>()
    return getReachableWorkerCandidates(props.presence).filter((candidate) => {
      if (!candidate.agent_key) return false
      if (lease && presenceMatchesLeaseSession(candidate, lease)) return false
      const key = getWorkerCandidateKey(candidate)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })

  const selectedHandoffCandidate = computed(() =>
    handoffCandidatesForTask.value.find(
      candidate => getWorkerCandidateKey(candidate) === selectedHandoffTarget.value,
    ) ?? null
  )

  function settlePending() {
    pendingAction.value = null
  }

  function handleReleaseLease() {
    if (!workLease.value) return
    pendingAction.value = 'release'
    emit('leaseAction', {
      taskId: props.task.id,
      action: 'release',
      lease_id: workLease.value.id,
      reason: `Released work lease ${workLease.value.id} from the task board.`,
      onSettled: settlePending,
    })
  }

  function handleHandoffLease() {
    const lease = workLease.value
    const target = selectedHandoffCandidate.value
    if (!lease || !target) return
    pendingAction.value = 'handoff'
    emit('leaseAction', {
      taskId: props.task.id,
      action: 'handoff',
      lease_id: lease.id,
      ...toLeaseActionTarget(target),
      reason: `Handed off work lease ${lease.id} from the task board.`,
      onSettled: () => {
        selectedHandoffTarget.value = ''
        settlePending()
      },
    })
  }

  return {
    authority,
    badgeLabel,
    badgeVariant,
    formatActorName: formatAuthorityActorName,
    formatHandoffCandidate: formatWorkerCandidate,
    getHandoffCandidateKey: getWorkerCandidateKey,
    handoffCandidatesForTask,
    handleHandoffLease,
    handleReleaseLease,
    hasLeaseArtifacts,
    leaseArtifacts,
    pendingAction,
    selectedHandoffTarget,
    workLease,
  }
}
