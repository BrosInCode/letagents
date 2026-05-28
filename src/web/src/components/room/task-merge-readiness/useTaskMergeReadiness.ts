import { computed, type Ref } from 'vue'
import { type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'

type ReadinessTone = 'ready' | 'blocked' | 'pending' | 'merged' | 'neutral'
type ActiveLease = NonNullable<RoomTask['active_leases']>[number]

interface ReadinessVerdict {
  label: string
  summary: string
  tone: ReadinessTone
  blockers: string[]
}

export function useTaskMergeReadiness(
  status: Ref<TaskGitHubArtifactStatus>,
  task: Ref<RoomTask | undefined>
) {
  const prLabel = computed(() => {
    if (status.value.pr_number) return `PR #${status.value.pr_number}`
    return 'Pull request'
  })

  const prState = computed(() => normalized(status.value.pr_state))
  const prAuthor = computed(() => normalized(status.value.pr_author || status.value.pr_actor))

  const approvedReviews = computed(() => (
    status.value.reviews.filter(review => normalized(review.state) === 'approved')
  ))
  const workLease = computed(() => task.value?.active_leases?.find(lease => lease.kind === 'work') ?? null)
  const reviewLeases = computed(() => task.value?.active_leases?.filter(lease => lease.kind === 'review') ?? [])
  const validBoardReviewLeases = computed(() =>
    reviewLeases.value.filter(lease => !workLease.value || !leasesMatchActor(lease, workLease.value))
  )
  const boardReviewRequired = computed(() => task.value?.status === 'in_review')
  const boardReviewBlocker = computed(() => {
    if (!boardReviewRequired.value) return null
    if (validBoardReviewLeases.value.length > 0) return null
    if (reviewLeases.value.length > 0) {
      return 'LetAgents board reviewer conflicts with the active work holder.'
    }
    return 'Assign a LetAgents board reviewer before merge handoff.'
  })

  const hasNonAuthorApproval = computed(() => {
    if (!approvedReviews.value.length) return false
    if (!prAuthor.value) return true
    return approvedReviews.value.some(review => normalized(review.actor) !== prAuthor.value)
  })

  const readiness = computed<ReadinessVerdict>(() => {
    if (!status.value.pr_url && !status.value.pr_number) {
      return {
        label: 'No linked PR',
        summary: status.value.checks.length || status.value.reviews.length
          ? 'GitHub evidence exists, but LetAgents cannot identify the pull request yet.'
          : 'This task has no linked PR evidence yet.',
        tone: 'neutral',
        blockers: [status.value.checks.length || status.value.reviews.length
          ? 'Refresh the PR webhook event or link the PR directly to this task.'
          : 'Link a PR before reviewing merge readiness.'],
      }
    }

    if ((status.value.pr_merged || prState.value === 'merged') && boardReviewBlocker.value) {
      return {
        label: 'Board review required',
        summary: 'The linked PR has merged, but the LetAgents board still needs a separate reviewer before task merge handoff.',
        tone: 'pending',
        blockers: [boardReviewBlocker.value],
      }
    }

    if (status.value.pr_merged || prState.value === 'merged') {
      return {
        label: 'Merged',
        summary: 'The linked PR has merged. The task can move toward done if follow-up is complete.',
        tone: 'merged',
        blockers: [],
      }
    }

    if (prState.value === 'closed') {
      return {
        label: 'Closed without merge',
        summary: 'The linked PR is closed and is not recorded as merged.',
        tone: 'blocked',
        blockers: ['Reopen the PR, link a replacement PR, or close the task as cancelled.'],
      }
    }

    const blockers: string[] = []
    const checks = status.value.check_summary
    const reviews = status.value.review_summary

    if (boardReviewBlocker.value) {
      blockers.push(boardReviewBlocker.value)
    }
    if (status.value.pr_draft || prState.value === 'draft') {
      blockers.push('PR is still draft.')
    }
    if (reviews.changes_requested > 0) {
      blockers.push(`${reviews.changes_requested} change-requesting ${plural(reviews.changes_requested, 'review')} present.`)
    }
    if (checks.failure > 0) {
      blockers.push(`${checks.failure} CI ${plural(checks.failure, 'check')} failing.`)
    }
    if (checks.pending > 0) {
      blockers.push(`${checks.pending} CI ${plural(checks.pending, 'check')} still pending.`)
    }
    if (checks.total === 0) {
      blockers.push('No CI check run has reported yet.')
    }
    if (!hasNonAuthorApproval.value) {
      blockers.push(prAuthor.value
        ? 'Needs approval from someone other than the PR author.'
        : 'Needs reviewer approval.')
    }

    if (blockers.length) {
      const hardBlocked = reviews.changes_requested > 0 || checks.failure > 0
      return {
        label: hardBlocked ? 'Blocked' : 'Not merge-ready',
        summary: hardBlocked
          ? 'GitHub evidence has at least one blocking signal.'
          : 'GitHub evidence is incomplete for a safe merge.',
        tone: hardBlocked ? 'blocked' : 'pending',
        blockers,
      }
    }

    return {
      label: 'Merge eligible',
      summary: boardReviewRequired.value
        ? 'Checks are green, GitHub approval is present, and board review authority is assigned.'
        : 'Checks are green and a non-author approval is present.',
      tone: 'ready',
      blockers: [],
    }
  })

  const checkSignal = computed(() => {
    const checks = status.value.check_summary
    if (checks.total === 0) return 'No checks'
    if (checks.failure > 0) return `${checks.failure} failing`
    if (checks.pending > 0) return `${checks.pending} pending`
    return `${checks.success}/${checks.total} passing`
  })

  const reviewSignal = computed(() => {
    const reviews = status.value.review_summary
    if (reviews.changes_requested > 0) return `${reviews.changes_requested} changes`
    if (hasNonAuthorApproval.value) return `${approvedReviews.value.length} approved`
    if (reviews.total > 0) return `${reviews.total} reviewed`
    return 'No review'
  })

  const prStateSignal = computed(() => {
    if (status.value.pr_draft) return 'Draft'
    if (status.value.pr_merged) return 'Merged'
    return labelize(status.value.pr_state || 'unknown')
  })

  const boardReviewSignal = computed(() => {
    if (!boardReviewRequired.value) return 'Not required'
    if (validBoardReviewLeases.value.length > 0) {
      return `${validBoardReviewLeases.value.length} assigned`
    }
    if (reviewLeases.value.length > 0) return 'Conflict'
    return 'Unassigned'
  })

  return {
    boardReviewSignal,
    checkSignal,
    normalizedReviewState,
    prLabel,
    prStateSignal,
    readiness,
    reviewSignal,
    reviewStateLabel,
  }
}

function normalized(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function normalizedReviewState(value: string | null): string {
  return normalized(value) || 'pending'
}

function reviewStateLabel(value: string | null): string {
  const state = normalized(value)
  if (!state) return 'Pending'
  if (state === 'approved') return 'Approved'
  if (state === 'changes_requested') return 'Changes requested'
  if (state === 'commented') return 'Commented'
  if (state === 'dismissed') return 'Dismissed'
  return labelize(state)
}

function labelize(value: string): string {
  const normalizedValue = value.trim()
  if (!normalizedValue) return 'Unknown'
  return normalizedValue
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function leasesMatchActor(left: ActiveLease, right: ActiveLease): boolean {
  return left.agent_key === right.agent_key
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
