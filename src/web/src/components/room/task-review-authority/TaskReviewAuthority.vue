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
          :value="getCandidateKey(candidate)"
        >
          {{ formatCandidate(candidate) }}
        </option>
      </AppSelect>
      <AppButton
        variant="secondary"
        size="sm"
        :disabled="updating || !canAssignSelectedReviewer"
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
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { type RoomAgentPresence, type RoomTask } from '@/composables/useRoom'
import type { ReviewLeaseActionPayload } from './model'
import { useTaskReviewAuthority } from './useTaskReviewAuthority'

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageReviewLeases: boolean
  updating: boolean
}>()

const emit = defineEmits<{
  reviewLeaseAction: [payload: ReviewLeaseActionPayload]
}>()

const {
  badgeLabel,
  badgeVariant,
  canAssignReview,
  canAssignSelectedReviewer,
  formatActorName,
  formatCandidate,
  getCandidateKey,
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
} = useTaskReviewAuthority(props, emit)
</script>

<style scoped src="./TaskReviewAuthority.css"></style>
