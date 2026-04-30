<template>
  <section
    class="task-merge-readiness"
    :data-tone="readiness.tone"
    aria-label="Merge readiness"
  >
    <div class="merge-readiness-topline">
      <div class="merge-readiness-title">
        <span class="merge-readiness-dot" aria-hidden="true"></span>
        <span>{{ readiness.label }}</span>
      </div>
      <a
        v-if="status.pr_url"
        class="merge-readiness-link"
        :href="status.pr_url"
        target="_blank"
        rel="noreferrer"
      >
        {{ prLabel }}
      </a>
    </div>

    <p class="merge-readiness-summary">{{ readiness.summary }}</p>

    <div class="merge-readiness-signals">
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ checkSignal }}</span>
        <span class="signal-label">CI</span>
      </div>
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ reviewSignal }}</span>
        <span class="signal-label">Review</span>
      </div>
      <div class="merge-readiness-signal">
        <span class="signal-value">{{ prStateSignal }}</span>
        <span class="signal-label">PR state</span>
      </div>
    </div>

    <ul v-if="readiness.blockers.length" class="merge-readiness-blockers">
      <li v-for="blocker in readiness.blockers" :key="blocker">{{ blocker }}</li>
    </ul>

    <div v-if="status.reviews.length" class="merge-readiness-reviews">
      <span
        v-for="review in status.reviews"
        :key="`${review.actor || 'reviewer'}:${review.state || 'pending'}`"
        class="merge-review-chip"
        :data-state="normalizedReviewState(review.state)"
      >
        {{ review.actor || 'reviewer' }}: {{ reviewStateLabel(review.state) }}
      </span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type TaskGitHubArtifactStatus } from '@/composables/useRoom'

type ReadinessTone = 'ready' | 'blocked' | 'pending' | 'merged' | 'neutral'

interface ReadinessVerdict {
  label: string
  summary: string
  tone: ReadinessTone
  blockers: string[]
}

const props = defineProps<{
  status: TaskGitHubArtifactStatus
}>()

const status = computed(() => props.status)

const prLabel = computed(() => {
  if (status.value.pr_number) return `PR #${status.value.pr_number}`
  return 'Pull request'
})

const prState = computed(() => normalized(status.value.pr_state))
const prAuthor = computed(() => normalized(status.value.pr_author || status.value.pr_actor))

const approvedReviews = computed(() => (
  status.value.reviews.filter(review => normalized(review.state) === 'approved')
))

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
    summary: 'Checks are green and a non-author approval is present.',
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

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`
}
</script>

<style scoped>
.task-merge-readiness {
  position: relative;
  margin-top: 10px;
  padding: 10px 11px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 12px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.018)),
    rgba(15, 23, 42, 0.3);
  animation: readiness-enter 180ms ease-out both;
  overflow: hidden;
}

.task-merge-readiness::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--readiness-accent, #94a3b8);
  opacity: 0.85;
}

.task-merge-readiness[data-tone="ready"] {
  --readiness-accent: #34d399;
  --readiness-soft: rgba(52, 211, 153, 0.12);
  --readiness-text: #86efac;
}

.task-merge-readiness[data-tone="blocked"] {
  --readiness-accent: #f87171;
  --readiness-soft: rgba(248, 113, 113, 0.12);
  --readiness-text: #fca5a5;
}

.task-merge-readiness[data-tone="pending"] {
  --readiness-accent: #f59e0b;
  --readiness-soft: rgba(245, 158, 11, 0.12);
  --readiness-text: #fbbf24;
}

.task-merge-readiness[data-tone="merged"] {
  --readiness-accent: #60a5fa;
  --readiness-soft: rgba(96, 165, 250, 0.12);
  --readiness-text: #93c5fd;
}

.task-merge-readiness[data-tone="neutral"] {
  --readiness-accent: #94a3b8;
  --readiness-soft: rgba(148, 163, 184, 0.12);
  --readiness-text: #cbd5e1;
}

.merge-readiness-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 5px;
}

.merge-readiness-title {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 7px;
  color: var(--readiness-text, #cbd5e1);
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.045em;
  text-transform: uppercase;
}

.merge-readiness-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--readiness-accent, #94a3b8);
  box-shadow: 0 0 16px var(--readiness-accent, #94a3b8);
}

.merge-readiness-link {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 3px 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.68rem;
  font-weight: 700;
  text-decoration: none;
  transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
}

.merge-readiness-link:hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.075);
}

.merge-readiness-summary {
  margin: 0 0 9px;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.75rem;
  line-height: 1.45;
}

.merge-readiness-signals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.merge-readiness-signal {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.16);
}

.signal-value,
.signal-label {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.signal-value {
  color: var(--text-primary, #ffffff);
  font-size: 0.72rem;
  font-weight: 700;
}

.signal-label {
  margin-top: 2px;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.merge-readiness-blockers {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 5px;
}

.merge-readiness-blockers li {
  position: relative;
  padding-left: 13px;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.7rem;
  line-height: 1.35;
}

.merge-readiness-blockers li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.55em;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--readiness-accent, #94a3b8);
}

.merge-readiness-reviews {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.merge-review-chip {
  padding: 3px 7px;
  border-radius: 999px;
  background: rgba(113, 113, 122, 0.12);
  color: var(--muted, #a1a1aa);
  font-size: 0.64rem;
  font-weight: 700;
}

.merge-review-chip[data-state="approved"] {
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
}

.merge-review-chip[data-state="changes_requested"] {
  background: rgba(248, 113, 113, 0.12);
  color: #fca5a5;
}

.merge-review-chip[data-state="commented"] {
  background: rgba(96, 165, 250, 0.1);
  color: #93c5fd;
}

@keyframes readiness-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 768px) {
  .merge-readiness-topline {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .merge-readiness-signals {
    grid-template-columns: 1fr;
  }
}
</style>
