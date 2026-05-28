<template>
  <div class="task-card">
    <div class="task-card-header">
      <div class="task-heading">
        <span
          class="task-id-badge"
          :title="`Task ${formatTaskShortId(task.id)}`"
          :aria-label="`Task ${formatTaskShortId(task.id)}`"
        >
          {{ formatTaskShortId(task.id) }}
        </span>
        <h4 class="task-card-title">{{ task.title }}</h4>
      </div>
      <span class="task-status-badge" :data-status="task.status">
        {{ STATUS_LABELS[task.status] || task.status }}
      </span>
    </div>

    <div class="task-meta">
      <TaskPersonChip v-if="task.assignee" :sender="task.assignee" role="Assignee" />
      <TaskPersonChip v-if="task.created_by" :sender="task.created_by" role="Created by" />
      <span>{{ formatTimestamp(task.created_at) }}</span>
    </div>

    <p v-if="task.description" class="task-description">{{ task.description }}</p>

    <TaskLeaseAuthority
      v-if="showAuthority"
      :task="task"
      :presence="presence"
      :canManageLeases="canManageLeases"
      :updating="updatingLease"
      @leaseAction="emit('leaseAction', $event)"
    />

    <TaskReviewAuthority
      v-if="showReviewAuthority"
      :task="task"
      :presence="presence"
      :canManageReviewLeases="canManageLeases"
      :updating="updatingReviewLease"
      @reviewLeaseAction="emit('reviewLeaseAction', $event)"
    />

    <div v-if="secondaryLeases.length || task.active_locks?.length" class="task-coordination">
      <div v-for="lease in secondaryLeases" :key="lease.id" class="coordination-badge lease">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        <span>{{ lease.kind }} lease: {{ formatActorName(lease.actor_label) }}</span>
      </div>
      <div v-for="lock in task.active_locks" :key="lock.id" class="coordination-badge lock">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
        <span>{{ lock.scope }} lock: {{ lock.reason }}{{ lock.message ? ' - ' + lock.message : '' }}</span>
      </div>
    </div>

    <div
      v-for="workflowRef in workflowRefs"
      :key="workflowRef.url"
      class="task-pr-link"
    >
      <a :href="workflowRef.url" target="_blank">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
        View {{ workflowRef.label }}
      </a>
    </div>

    <div v-if="focusable" class="task-focus-row">
      <button
        class="task-focus-btn"
        type="button"
        @click="emit('focusTask', task.id)"
      >
        Focus on this
      </button>
    </div>

    <TaskMergeReadiness
      v-if="githubStatus"
      :status="githubStatus"
      :task="task"
    />

    <div v-if="taskActions.length" class="task-actions">
      <button
        v-for="action in taskActions"
        :key="action.status"
        :class="['task-action-btn', action.cls]"
        :disabled="updating"
        @click="emit('updateStatus', task.id, action.status)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import TaskLeaseAuthority from '../TaskLeaseAuthority.vue'
import TaskMergeReadiness from '../TaskMergeReadiness.vue'
import TaskPersonChip from '../TaskPersonChip.vue'
import TaskReviewAuthority from '../TaskReviewAuthority.vue'
import {
  canFocusTask,
  formatActorName,
  formatTaskShortId,
  formatTimestamp,
  getSecondaryLeases,
  getTaskActions,
  getTaskWorkflowRefs,
  shouldShowAuthority,
  shouldShowReviewAuthority,
  STATUS_LABELS,
} from './model'
import type { TaskLeaseActionPayload, TaskReviewLeaseActionPayload } from './model'

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
  updatingLease: boolean
  updatingReviewLease: boolean
  githubStatus: TaskGitHubArtifactStatus | null
}>()

const emit = defineEmits<{
  updateStatus: [taskId: string, status: string]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
}>()

const secondaryLeases = computed(() => getSecondaryLeases(props.task))
const taskActions = computed(() => getTaskActions(props.task))
const workflowRefs = computed(() => getTaskWorkflowRefs(props.task))
const showAuthority = computed(() => shouldShowAuthority(props.task))
const showReviewAuthority = computed(() => shouldShowReviewAuthority(props.task))
const focusable = computed(() => canFocusTask(props.task))
</script>

<style scoped>
.task-card {
  margin-bottom: 6px;
  padding: var(--space-md) var(--space-lg);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  background: var(--bg-card, #131316);
  transition: border-color 150ms;
}

.task-card:hover {
  border-color: rgba(255, 255, 255, 0.12);
}

.task-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.task-heading {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: flex-start;
  min-width: 0;
  gap: 6px 8px;
}

.task-id-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid rgba(147, 197, 253, 0.42);
  border-radius: 4px;
  background: rgba(147, 197, 253, 0.08);
  color: #93c5fd;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.68rem;
  font-weight: 700;
  line-height: 1.45;
}

.task-card-title {
  flex: 1;
  min-width: min(100%, 12rem);
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-size: 0.82rem;
  font-weight: 600;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.task-status-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}

.task-status-badge[data-status="proposed"] { color: #71717a; border-color: rgba(113, 113, 122, 0.4); }
.task-status-badge[data-status="accepted"] { color: #60a5fa; border-color: rgba(96, 165, 250, 0.4); }
.task-status-badge[data-status="assigned"] { color: #a855f7; border-color: rgba(168, 85, 247, 0.4); }
.task-status-badge[data-status="in_progress"] { color: #fbbf24; border-color: rgba(251, 191, 36, 0.4); }
.task-status-badge[data-status="blocked"] { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
.task-status-badge[data-status="in_review"] { color: #38bdf8; border-color: rgba(56, 189, 248, 0.4); }
.task-status-badge[data-status="merged"] { color: #34d399; border-color: rgba(52, 211, 153, 0.4); }
.task-status-badge[data-status="done"] { color: #22c55e; border-color: rgba(34, 197, 94, 0.4); }
.task-status-badge[data-status="cancelled"] { color: #64748b; border-color: rgba(100, 116, 139, 0.4); }

.task-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.72rem;
}

.task-description {
  margin: 0 0 10px;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.82rem;
  line-height: 1.5;
}

.task-coordination {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.coordination-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--line, #27272a);
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 600;
}

.coordination-badge.lease {
  border-color: rgba(168, 85, 247, 0.2);
  background: rgba(168, 85, 247, 0.08);
  color: #c084fc;
}

.coordination-badge.lock {
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
}

.task-pr-link {
  margin-bottom: 8px;
}

.task-pr-link a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary, #d4d4d8);
  font-size: 0.72rem;
  font-weight: 600;
  text-decoration: none;
  transition: color 150ms;
}

.task-pr-link a:hover {
  color: var(--text-primary, #ffffff);
}

.task-focus-row {
  margin-bottom: 8px;
}

.task-focus-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary, #a1a1aa);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 600;
  transition: background 150ms, border-color 150ms, color 150ms;
}

.task-focus-btn:hover {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary, #d4d4d8);
}

.task-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}

.task-action-btn {
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary, #a1a1aa);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 600;
  transition: background 150ms, color 150ms, border-color 150ms;
}

.task-action-btn:hover {
  border-color: rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary, #d4d4d8);
}

.task-action-btn:disabled {
  cursor: wait;
  opacity: 0.4;
}

.task-action-btn.accept { color: #60a5fa; border-color: rgba(96, 165, 250, 0.3); }
.task-action-btn.cancel { color: #f87171; border-color: rgba(248, 113, 113, 0.3); }
.task-action-btn.merge { color: #34d399; border-color: rgba(52, 211, 153, 0.3); }

@media (max-width: 768px) {
  .task-card {
    padding: 10px;
  }

  .task-card-header {
    flex-direction: column;
    gap: 4px;
  }

  .task-heading {
    width: 100%;
  }

  .task-card-title {
    font-size: 0.8rem;
  }

  .task-meta {
    gap: 6px;
    font-size: 0.68rem;
  }

  .task-description {
    font-size: 0.78rem;
  }

  .task-actions {
    flex-wrap: wrap;
  }

  .task-action-btn {
    flex: 1;
    min-width: 60px;
    text-align: center;
  }
}
</style>
