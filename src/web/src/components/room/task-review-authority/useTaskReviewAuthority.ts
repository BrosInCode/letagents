import { computed, ref } from 'vue'
import type { RoomAgentPresence, RoomTask } from '@/composables/useRoom'
import {
  formatAuthorityActorName,
  formatWorkerCandidate,
  getWorkerCandidateKey,
  toLeaseActionTarget,
  type TaskLease,
} from '../task-authority/shared'
import {
  getReviewBadgeLabel,
  getReviewBadgeVariant,
  getReviewCandidates,
  getReviewLeases,
  getReviewState,
  getWorkLease,
  reviewLeaseMatchesWork as leaseMatchesWork,
  shouldShowReviewLane as taskShouldShowReviewLane,
  type ReviewLeaseActionPayload,
} from './model'

type TaskReviewAuthorityProps = {
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageReviewLeases: boolean
  updating: boolean
}

type EmitReviewLeaseAction = (
  event: 'reviewLeaseAction',
  payload: ReviewLeaseActionPayload,
) => void

export function useTaskReviewAuthority(
  props: TaskReviewAuthorityProps,
  emit: EmitReviewLeaseAction,
) {
  const selectedReviewer = ref('')
  const pendingAction = ref<'assign' | 'release' | null>(null)

  const workLease = computed(() => getWorkLease(props.task))
  const reviewLeases = computed(() => getReviewLeases(props.task))
  const shouldShowReviewLane = computed(() => taskShouldShowReviewLane(props.task))
  const reviewState = computed(() => getReviewState(props.task))
  const badgeVariant = computed(() => getReviewBadgeVariant(reviewState.value.state))
  const badgeLabel = computed(() => getReviewBadgeLabel(reviewState.value.state))
  const reviewCandidates = computed(() =>
    getReviewCandidates(props.presence, workLease.value, reviewLeases.value)
  )
  const canAssignReview = computed(() =>
    shouldShowReviewLane.value && reviewCandidates.value.length > 0
  )
  const selectedReviewCandidate = computed(() =>
    reviewCandidates.value.find(
      candidate => getWorkerCandidateKey(candidate) === selectedReviewer.value,
    ) ?? null
  )
  const canAssignSelectedReviewer = computed(() => Boolean(selectedReviewCandidate.value))

  function reviewLeaseMatchesWork(lease: TaskLease): boolean {
    return leaseMatchesWork(lease, workLease.value)
  }

  function settlePending() {
    pendingAction.value = null
  }

  function handleAssignReviewer() {
    const target = selectedReviewCandidate.value
    if (!target) return
    pendingAction.value = 'assign'
    emit('reviewLeaseAction', {
      taskId: props.task.id,
      action: 'assign',
      ...toLeaseActionTarget(target),
      reason: `Assigned board review authority for ${props.task.id}.`,
      onSettled: () => {
        selectedReviewer.value = ''
        settlePending()
      },
    })
  }

  function handleReleaseReviewLease(lease: TaskLease) {
    pendingAction.value = 'release'
    emit('reviewLeaseAction', {
      taskId: props.task.id,
      action: 'release',
      lease_id: lease.id,
      reason: `Released board review authority ${lease.id}.`,
      onSettled: settlePending,
    })
  }

  return {
    badgeLabel,
    badgeVariant,
    canAssignReview,
    canAssignSelectedReviewer,
    formatActorName: formatAuthorityActorName,
    formatCandidate: formatWorkerCandidate,
    getCandidateKey: getWorkerCandidateKey,
    handleAssignReviewer,
    handleReleaseReviewLease,
    pendingAction,
    reviewCandidates,
    reviewLeaseMatchesWork,
    reviewLeases,
    reviewState,
    selectedReviewer,
    shouldShowReviewLane,
    workLease,
  }
}
