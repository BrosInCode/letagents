<template>
  <section class="lease-authority" :data-state="authority.state">
    <div class="lease-authority__header">
      <div class="lease-authority__heading">
        <span class="lease-authority__kicker">Execution authority</span>
        <h5>{{ authority.label }}</h5>
      </div>
      <AppBadge class="lease-authority__badge" :variant="badgeVariant" size="sm" dot>
        {{ badgeLabel }}
      </AppBadge>
    </div>

    <div class="lease-authority__grid">
      <div class="lease-authority__tile">
        <span>Task owner</span>
        <strong>{{ formatActorName(task.assignee) || 'Unassigned' }}</strong>
      </div>
      <div class="lease-authority__tile">
        <span>Work lease</span>
        <strong>{{ workLease ? formatActorName(workLease.actor_label) : 'No active lease' }}</strong>
      </div>
    </div>

    <p class="lease-authority__detail">{{ authority.detail }}</p>

    <div v-if="workLease && hasLeaseArtifacts" class="lease-authority__artifacts">
      <span v-for="artifact in leaseArtifacts" :key="artifact.key">
        {{ artifact.label }}
      </span>
      <a
        v-if="workLease.pr_url"
        :href="workLease.pr_url"
        target="_blank"
        rel="noreferrer"
      >
        PR linked
      </a>
    </div>

    <div v-if="workLease" class="lease-authority__actions">
      <template v-if="canManageLeases">
        <AppButton
          class="lease-authority__button lease-authority__button--release"
          variant="secondary"
          size="sm"
          :disabled="updating"
          :loading="pendingAction === 'release'"
          @click="handleReleaseLease"
        >
          Release lane
        </AppButton>

        <div v-if="handoffCandidatesForTask.length" class="lease-authority__handoff">
          <AppSelect
            :model-value="selectedHandoffTarget"
            :disabled="updating"
            @update:modelValue="selectedHandoffTarget = $event"
          >
            <option value="">Handoff to...</option>
            <option
              v-for="candidate in handoffCandidatesForTask"
              :key="getHandoffCandidateKey(candidate)"
              :value="getHandoffCandidateKey(candidate)"
            >
              {{ formatHandoffCandidate(candidate) }}
            </option>
          </AppSelect>
          <AppButton
            class="lease-authority__button lease-authority__button--handoff"
            variant="secondary"
            size="sm"
            :disabled="updating || !canHandoffLease"
            :loading="pendingAction === 'handoff'"
            @click="handleHandoffLease"
          >
            Handoff
          </AppButton>
        </div>

        <p v-else class="lease-authority__note">
          No other reachable worker sessions are available for handoff.
        </p>
      </template>

      <p v-else class="lease-authority__note">
        Lease recovery is restricted to room admins. The active worker can still release its own lane through MCP.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { type RoomAgentPresence, type RoomTask } from '@/composables/useRoom'
import { useTaskLeaseAuthority } from './useTaskLeaseAuthority'
import type { LeaseActionPayload } from './model'

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
}>()

const emit = defineEmits<{
  leaseAction: [payload: LeaseActionPayload]
}>()

const {
  authority,
  badgeLabel,
  badgeVariant,
  canHandoffLease,
  formatActorName,
  formatHandoffCandidate,
  getHandoffCandidateKey,
  handoffCandidatesForTask,
  handleHandoffLease,
  handleReleaseLease,
  hasLeaseArtifacts,
  leaseArtifacts,
  pendingAction,
  selectedHandoffTarget,
  workLease,
} = useTaskLeaseAuthority(props, emit)
</script>

<style scoped src="./TaskLeaseAuthority.css"></style>
