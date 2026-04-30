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
              :value="getHandoffTargetValue(candidate)"
            >
              {{ formatHandoffCandidate(candidate) }}
            </option>
          </AppSelect>
          <AppButton
            class="lease-authority__button lease-authority__button--handoff"
            variant="secondary"
            size="sm"
            :disabled="updating || !selectedHandoffTarget"
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
import { computed, ref } from 'vue'
import AppBadge from '@/components/ui/AppBadge.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { type RoomAgentPresence, type RoomTask } from '@/composables/useRoom'
import { isLivePresenceEntry } from './reachability'

type TaskLease = NonNullable<RoomTask['active_leases']>[number]
type AuthorityState = 'held' | 'mismatch' | 'missing'
type LeaseActionPayload = {
  taskId: string
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
}>()

const emit = defineEmits<{
  leaseAction: [payload: LeaseActionPayload]
}>()

const selectedHandoffTarget = ref('')
const pendingAction = ref<'release' | 'handoff' | null>(null)

const workLease = computed(() => getWorkLease(props.task))
const authority = computed(() => getAuthorityState(props.task))
const badgeVariant = computed(() => {
  switch (authority.value.state) {
    case 'held':
      return 'success'
    case 'mismatch':
      return 'warning'
    default:
      return 'default'
  }
})
const badgeLabel = computed(() => {
  switch (authority.value.state) {
    case 'held':
      return 'Lane held'
    case 'mismatch':
      return 'Mismatch'
    default:
      return 'Missing'
  }
})

const leaseArtifacts = computed(() => {
  const lease = workLease.value
  if (!lease) return []
  return [
    lease.branch_ref ? { key: 'branch', label: `Branch: ${lease.branch_ref}` } : null,
    lease.output_intent ? { key: 'intent', label: lease.output_intent } : null,
  ].filter((item): item is { key: string; label: string } => Boolean(item))
})
const hasLeaseArtifacts = computed(() =>
  Boolean(workLease.value?.pr_url || leaseArtifacts.value.length)
)

const handoffCandidates = computed(() =>
  props.presence
    .filter(entry =>
      isLivePresenceEntry(entry)
      && Boolean(entry.agent_key)
      && Boolean(entry.agent_session_id)
    )
    .sort((left, right) => left.display_name.localeCompare(right.display_name))
)

const handoffCandidatesForTask = computed(() => {
  const lease = workLease.value
  const seen = new Set<string>()
  return handoffCandidates.value.filter((candidate) => {
    if (!candidate.agent_key) return false
    if (lease && presenceMatchesLease(candidate, lease)) return false
    const key = getHandoffCandidateKey(candidate)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

function normalizeActor(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase()
}

function formatActorName(value: string | null | undefined): string {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  const parts = normalized.split('|').map(part => part.trim()).filter(Boolean)
  return parts[0] || normalized
}

function getWorkLease(task: RoomTask): TaskLease | null {
  return task.active_leases?.find(lease => lease.kind === 'work') ?? null
}

function taskOwnerMatchesLease(task: RoomTask, lease: TaskLease): boolean {
  const assigneeKey = normalizeActor(task.assignee_agent_key)
  const leaseAgentKey = normalizeActor(lease.agent_key)
  if (assigneeKey && leaseAgentKey) {
    return assigneeKey === leaseAgentKey
  }
  return normalizeActor(task.assignee) === normalizeActor(lease.actor_label)
}

function getAuthorityState(task: RoomTask): { state: AuthorityState; label: string; detail: string } {
  const lease = getWorkLease(task)
  if (lease) {
    const owner = formatActorName(task.assignee)
    const holder = formatActorName(lease.actor_label)
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

function presenceMatchesLease(entry: RoomAgentPresence, lease: TaskLease): boolean {
  if (!entry.agent_key || entry.agent_key !== lease.agent_key) return false
  if (lease.agent_session_id) {
    return entry.agent_session_id === lease.agent_session_id
  }
  if (lease.agent_instance_id) {
    return entry.agent_instance_id === lease.agent_instance_id
  }
  return entry.actor_label === lease.actor_label
}

function getHandoffCandidateKey(candidate: RoomAgentPresence): string {
  return [
    candidate.agent_key,
    candidate.agent_instance_id ?? 'no-instance',
    candidate.agent_session_id ?? candidate.actor_label,
  ].join(':')
}

function getHandoffTargetValue(candidate: RoomAgentPresence): string {
  return JSON.stringify({
    agent_key: candidate.agent_key,
    agent_instance_id: candidate.agent_instance_id,
    agent_session_id: candidate.agent_session_id,
  })
}

function parseHandoffTarget(value: string | null | undefined): {
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

function formatHandoffCandidate(candidate: RoomAgentPresence): string {
  const owner = candidate.owner_label ? ` · ${candidate.owner_label}` : ''
  const runtime = candidate.runtime && candidate.runtime !== 'unknown' ? ` · ${candidate.runtime}` : ''
  const session = candidate.agent_session_id ? ` · ${candidate.agent_session_id.slice(-6)}` : ''
  return `${candidate.display_name}${owner}${runtime}${session}`
}

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
  const target = parseHandoffTarget(selectedHandoffTarget.value)
  if (!lease || !target) return
  pendingAction.value = 'handoff'
  emit('leaseAction', {
    taskId: props.task.id,
    action: 'handoff',
    lease_id: lease.id,
    target_actor_key: target.agentKey,
    target_actor_instance_id: target.agentInstanceId,
    target_agent_session_id: target.agentSessionId,
    reason: `Handed off work lease ${lease.id} from the task board.`,
    onSettled: () => {
      selectedHandoffTarget.value = ''
      settlePending()
    },
  })
}
</script>

<style scoped>
.lease-authority {
  --lease-accent: #94a3b8;
  position: relative;
  display: grid;
  gap: 12px;
  margin: 12px 0;
  padding: 14px;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  background:
    radial-gradient(circle at 18px 18px, color-mix(in srgb, var(--lease-accent) 14%, transparent), transparent 44px),
    linear-gradient(135deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.018));
}

.lease-authority[data-state="held"] {
  --lease-accent: #22c55e;
  border-color: rgba(34, 197, 94, 0.22);
}

.lease-authority[data-state="mismatch"] {
  --lease-accent: #f59e0b;
  border-color: rgba(245, 158, 11, 0.32);
}

.lease-authority__header,
.lease-authority__actions,
.lease-authority__handoff {
  display: flex;
  align-items: center;
  gap: 10px;
}

.lease-authority__header {
  justify-content: space-between;
  min-width: 0;
}

.lease-authority__heading {
  min-width: 0;
}

.lease-authority__heading h5 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-size: 0.82rem;
  font-weight: 750;
  line-height: 1.25;
}

.lease-authority__kicker,
.lease-authority__tile span {
  display: block;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  line-height: 1.35;
  text-transform: uppercase;
}

.lease-authority__kicker {
  margin-bottom: 3px;
}

.lease-authority__badge {
  flex-shrink: 0;
}

.lease-authority__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.lease-authority__tile {
  min-width: 0;
  padding: 10px 11px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 11px;
  background: rgba(0, 0, 0, 0.16);
}

.lease-authority__tile strong {
  display: block;
  margin-top: 3px;
  overflow-wrap: anywhere;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.78rem;
  font-weight: 750;
  line-height: 1.3;
}

.lease-authority__detail,
.lease-authority__note {
  margin: 0;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.72rem;
  line-height: 1.5;
}

.lease-authority__artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.lease-authority__artifacts span,
.lease-authority__artifacts a {
  max-width: 100%;
  padding: 4px 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.66rem;
  font-weight: 750;
  line-height: 1.25;
  text-decoration: none;
  overflow-wrap: anywhere;
}

.lease-authority__artifacts a:hover {
  color: var(--text-primary, #ffffff);
  background: rgba(96, 165, 250, 0.14);
}

.lease-authority__actions {
  flex-wrap: wrap;
}

.lease-authority__handoff {
  flex: 1 1 300px;
  min-width: min(100%, 280px);
}

.lease-authority__handoff :deep(.app-select) {
  --app-select-height: 34px;
  --app-select-radius: 10px;
  --app-select-bg: rgba(0, 0, 0, 0.2);
  --app-select-border: rgba(255, 255, 255, 0.1);
  --app-select-padding-left: 11px;
  --app-select-padding-right: 32px;
  flex: 1 1 180px;
}

.lease-authority__button {
  min-height: 34px;
  --btn-secondary-bg: rgba(255, 255, 255, 0.045);
  --btn-secondary-hover-bg: rgba(255, 255, 255, 0.085);
  --btn-secondary-border: rgba(255, 255, 255, 0.12);
  --btn-secondary-color: var(--text-secondary, #d4d4d8);
}

.lease-authority__button--release {
  --btn-secondary-color: #fbbf24;
  --btn-secondary-border: rgba(251, 191, 36, 0.24);
}

.lease-authority__button--handoff {
  --btn-secondary-color: #93c5fd;
  --btn-secondary-border: rgba(147, 197, 253, 0.24);
}

.lease-authority__note {
  width: 100%;
  padding: 9px 11px;
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
}

@media (max-width: 640px) {
  .lease-authority {
    padding: 12px;
  }

  .lease-authority__header,
  .lease-authority__handoff {
    align-items: stretch;
    flex-direction: column;
  }

  .lease-authority__badge,
  .lease-authority__button {
    width: 100%;
  }

  .lease-authority__grid {
    grid-template-columns: 1fr;
  }
}
</style>
