<template>
  <section class="review-authority" :data-state="reviewState.state">
    <div class="review-authority__header">
      <div>
        <span class="review-authority__kicker">Board review authority</span>
        <h5>{{ reviewState.label }}</h5>
      </div>
      <AppBadge :variant="badgeVariant" size="sm" dot>
        {{ badgeLabel }}
      </AppBadge>
    </div>

    <div class="review-authority__grid">
      <div class="review-authority__tile">
        <span>Work holder</span>
        <strong>{{ workLease ? formatActorName(workLease.actor_label) : 'No active work lease' }}</strong>
      </div>
      <div class="review-authority__tile">
        <span>Reviewer</span>
        <strong>{{ reviewLeases.length ? reviewLeases.map(lease => formatActorName(lease.actor_label)).join(', ') : 'Unassigned' }}</strong>
      </div>
    </div>

    <p class="review-authority__detail">{{ reviewState.detail }}</p>

    <div v-if="reviewLeases.length" class="review-authority__reviewers">
      <div
        v-for="lease in reviewLeases"
        :key="lease.id"
        class="reviewer-chip"
        :data-invalid="reviewLeaseMatchesWork(lease)"
      >
        <span>{{ formatActorName(lease.actor_label) }}</span>
        <small>{{ lease.agent_session_id ? lease.agent_session_id.slice(-6) : lease.id.slice(-6) }}</small>
        <button
          v-if="canManageReviewLeases"
          type="button"
          :disabled="updating"
          @click="handleReleaseReviewLease(lease)"
        >
          Release
        </button>
      </div>
    </div>

    <div v-if="canManageReviewLeases && canAssignReview" class="review-authority__actions">
      <AppSelect
        :model-value="selectedReviewer"
        :disabled="updating"
        @update:modelValue="selectedReviewer = $event"
      >
        <option value="">Assign reviewer...</option>
        <option
          v-for="candidate in reviewCandidates"
          :key="getCandidateKey(candidate)"
          :value="getCandidateValue(candidate)"
        >
          {{ formatCandidate(candidate) }}
        </option>
      </AppSelect>
      <AppButton
        variant="secondary"
        size="sm"
        :disabled="updating || !selectedReviewer"
        :loading="pendingAction === 'assign'"
        @click="handleAssignReviewer"
      >
        Assign
      </AppButton>
    </div>

    <p v-else-if="canManageReviewLeases && shouldShowReviewLane" class="review-authority__note">
      No reachable worker sessions are available for review assignment.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { type RoomAgentPresence, type RoomTask } from '@/composables/useRoom'
import { isLivePresenceEntry } from './reachability'

type TaskLease = NonNullable<RoomTask['active_leases']>[number]
type ReviewState = 'assigned' | 'missing' | 'invalid' | 'idle'
type ReviewLeaseActionPayload = {
  taskId: string
  action: 'assign' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}

const REVIEW_STATUSES = new Set(['in_review', 'blocked'])

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageReviewLeases: boolean
  updating: boolean
}>()

const emit = defineEmits<{
  reviewLeaseAction: [payload: ReviewLeaseActionPayload]
}>()

const selectedReviewer = ref('')
const pendingAction = ref<'assign' | 'release' | null>(null)

const workLease = computed(() => props.task.active_leases?.find(lease => lease.kind === 'work') ?? null)
const reviewLeases = computed(() => (props.task.active_leases ?? []).filter(lease => lease.kind === 'review'))
const shouldShowReviewLane = computed(() => REVIEW_STATUSES.has(props.task.status) || reviewLeases.value.length > 0)
const hasInvalidReviewLease = computed(() => reviewLeases.value.some(reviewLeaseMatchesWork))
const validReviewLeaseCount = computed(() =>
  reviewLeases.value.filter(lease => !reviewLeaseMatchesWork(lease)).length
)

const reviewState = computed<{ state: ReviewState; label: string; detail: string }>(() => {
  if (!shouldShowReviewLane.value) {
    return {
      state: 'idle',
      label: 'Review not active',
      detail: 'Move the task to review before assigning board review authority.',
    }
  }
  if (hasInvalidReviewLease.value) {
    return {
      state: 'invalid',
      label: 'Reviewer conflicts with work holder',
      detail: 'At least one reviewer also matches the active work lease. Assign a different worker before treating the board review as valid.',
    }
  }
  if (validReviewLeaseCount.value > 0) {
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
})

const badgeVariant = computed(() => {
  switch (reviewState.value.state) {
    case 'assigned':
      return 'success'
    case 'missing':
    case 'invalid':
      return 'warning'
    default:
      return 'default'
  }
})

const badgeLabel = computed(() => {
  switch (reviewState.value.state) {
    case 'assigned':
      return 'Assigned'
    case 'invalid':
      return 'Conflict'
    case 'missing':
      return 'Needed'
    default:
      return 'Idle'
  }
})

const reviewCandidates = computed(() => {
  const seen = new Set<string>()
  return props.presence
    .filter(entry =>
      isLivePresenceEntry(entry)
      && Boolean(entry.agent_key)
      && Boolean(entry.agent_session_id)
      && !presenceMatchesLease(entry, workLease.value)
      && !reviewLeases.value.some(lease => presenceMatchesLease(entry, lease))
    )
    .filter((entry) => {
      const key = getCandidateKey(entry)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.display_name.localeCompare(right.display_name))
})

const canAssignReview = computed(() =>
  shouldShowReviewLane.value && reviewCandidates.value.length > 0
)

function formatActorName(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const parts = normalized.split('|').map(part => part.trim()).filter(Boolean)
  return parts[0] || normalized
}

function reviewLeaseMatchesWork(lease: TaskLease): boolean {
  const currentWorkLease = workLease.value
  if (!currentWorkLease) return false
  return leasesMatchActor(lease, currentWorkLease)
}

function leasesMatchActor(left: TaskLease, right: TaskLease): boolean {
  return left.agent_key === right.agent_key
}

function presenceMatchesLease(entry: RoomAgentPresence, lease: TaskLease | null): boolean {
  if (!lease || !entry.agent_key || entry.agent_key !== lease.agent_key) return false
  return true
}

function getCandidateKey(candidate: RoomAgentPresence): string {
  return [
    candidate.agent_key,
    candidate.agent_instance_id ?? 'no-instance',
    candidate.agent_session_id ?? candidate.actor_label,
  ].join(':')
}

function getCandidateValue(candidate: RoomAgentPresence): string {
  return JSON.stringify({
    agent_key: candidate.agent_key,
    agent_instance_id: candidate.agent_instance_id,
    agent_session_id: candidate.agent_session_id,
  })
}

function parseCandidate(value: string): {
  agentKey: string
  agentInstanceId: string | null
  agentSessionId: string
} | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as {
      agent_key?: unknown
      agent_instance_id?: unknown
      agent_session_id?: unknown
    }
    const agentKey = typeof parsed.agent_key === 'string' ? parsed.agent_key.trim() : ''
    const agentSessionId = typeof parsed.agent_session_id === 'string' ? parsed.agent_session_id.trim() : ''
    if (!agentKey || !agentSessionId) return null
    return {
      agentKey,
      agentInstanceId: typeof parsed.agent_instance_id === 'string' && parsed.agent_instance_id.trim()
        ? parsed.agent_instance_id.trim()
        : null,
      agentSessionId,
    }
  } catch {
    return null
  }
}

function formatCandidate(candidate: RoomAgentPresence): string {
  const owner = candidate.owner_label ? ` · ${candidate.owner_label}` : ''
  const runtime = candidate.runtime && candidate.runtime !== 'unknown' ? ` · ${candidate.runtime}` : ''
  const session = candidate.agent_session_id ? ` · ${candidate.agent_session_id.slice(-6)}` : ''
  return `${candidate.display_name}${owner}${runtime}${session}`
}

function settlePending() {
  pendingAction.value = null
}

function handleAssignReviewer() {
  const target = parseCandidate(selectedReviewer.value)
  if (!target) return
  pendingAction.value = 'assign'
  emit('reviewLeaseAction', {
    taskId: props.task.id,
    action: 'assign',
    target_actor_key: target.agentKey,
    target_actor_instance_id: target.agentInstanceId,
    target_agent_session_id: target.agentSessionId,
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
</script>

<style scoped>
.review-authority {
  --review-accent: #94a3b8;
  display: grid;
  gap: 12px;
  margin: 12px 0;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  background:
    radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--review-accent) 13%, transparent), transparent 80px),
    linear-gradient(135deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.018));
}

.review-authority[data-state="assigned"] {
  --review-accent: #38bdf8;
  border-color: rgba(56, 189, 248, 0.22);
}

.review-authority[data-state="missing"],
.review-authority[data-state="invalid"] {
  --review-accent: #f59e0b;
  border-color: rgba(245, 158, 11, 0.28);
}

.review-authority__header,
.review-authority__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.review-authority__header {
  justify-content: space-between;
  min-width: 0;
}

.review-authority__kicker {
  display: block;
  margin-bottom: 3px;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.66rem;
  font-weight: 800;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.review-authority h5 {
  margin: 0;
  color: var(--text-primary, #fff);
  font-size: 0.88rem;
}

.review-authority__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.review-authority__tile {
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid rgba(255, 255, 255, 0.065);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.14);
}

.review-authority__tile span,
.review-authority__tile strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.review-authority__tile span {
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.review-authority__tile strong {
  margin-top: 3px;
  color: var(--text-primary, #fff);
  font-size: 0.78rem;
}

.review-authority__detail,
.review-authority__note {
  margin: 0;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.75rem;
  line-height: 1.45;
}

.review-authority__reviewers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.reviewer-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 4px 6px 4px 9px;
  border: 1px solid rgba(56, 189, 248, 0.22);
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.08);
  color: #bae6fd;
  font-size: 0.7rem;
  font-weight: 700;
}

.reviewer-chip[data-invalid="true"] {
  border-color: rgba(248, 113, 113, 0.3);
  background: rgba(248, 113, 113, 0.09);
  color: #fecaca;
}

.reviewer-chip small {
  color: var(--text-tertiary, #a1a1aa);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.62rem;
}

.reviewer-chip button {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.055);
  color: var(--text-secondary, #d4d4d8);
  cursor: pointer;
  font: inherit;
  font-size: 0.65rem;
  transition: background 140ms ease, border-color 140ms ease;
}

.reviewer-chip button:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.1);
}

.reviewer-chip button:disabled {
  opacity: 0.5;
  cursor: wait;
}

.review-authority__actions {
  align-items: stretch;
}

.review-authority__actions :deep(.app-select) {
  flex: 1;
  min-width: 0;
}

@media (max-width: 768px) {
  .review-authority__header,
  .review-authority__actions {
    align-items: stretch;
    flex-direction: column;
  }

  .review-authority__grid {
    grid-template-columns: 1fr;
  }
}
</style>
