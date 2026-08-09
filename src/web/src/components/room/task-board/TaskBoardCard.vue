<template>
  <div
    class="task-card"
    :class="{ selected }"
    :data-board-task-id="task.id"
    :style="{ '--task-accent': taskStatusAccent(task.status) }"
    :aria-current="selected ? 'true' : undefined"
    :aria-label="`${formatTaskShortId(task.id)}: ${task.title}. ${taskStatusLabel(task.status)}.`"
    tabindex="-1"
  >
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
      <a :href="workflowRef.url" target="_blank" rel="noopener noreferrer">
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
import TaskLeaseAuthority from '../task-lease-authority/TaskLeaseAuthority.vue'
import TaskMergeReadiness from '../TaskMergeReadiness.vue'
import TaskPersonChip from '../TaskPersonChip.vue'
import TaskReviewAuthority from '../task-review-authority/TaskReviewAuthority.vue'
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
} from './model'
import { taskStatusAccent, taskStatusLabel } from '../../../domain/taskStatus'
import type { TaskLeaseActionPayload, TaskReviewLeaseActionPayload } from './model'

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
  updatingLease: boolean
  updatingReviewLease: boolean
  githubStatus: TaskGitHubArtifactStatus | null
  selected?: boolean
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
  --task-accent: var(--text-tertiary);
  padding: 11px;
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--task-accent);
  border-radius: 10px;
  background: var(--bg-elevated);
  transition: border-color var(--duration-fast) ease, background-color var(--duration-fast) ease;
}

@media (hover: hover) and (pointer: fine) {
  .task-card:hover {
    border-top-color: var(--border-accent);
    border-right-color: var(--border-accent);
    border-bottom-color: var(--border-accent);
  }
}

.task-card.selected {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px var(--blue-dim);
}

.task-card:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.task-card-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 7px;
}

.task-heading {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: flex-start;
  min-width: 0;
  gap: 6px;
}

.task-id-badge {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  line-height: 1.3;
}

.task-card-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--text);
  font-size: 0.84rem;
  font-weight: 650;
  letter-spacing: -0.008em;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.task-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-tertiary);
  font-size: 0.72rem;
}

.task-description {
  margin: 0 0 9px;
  color: var(--text-secondary);
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
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 600;
}

.coordination-badge.lease {
  border-color: color-mix(in srgb, var(--task-assigned) 30%, var(--border));
  background: color-mix(in srgb, var(--task-assigned) 7%, var(--bg-elevated));
  color: color-mix(in srgb, var(--task-assigned) 70%, var(--text));
}

.coordination-badge.lock {
  border-color: color-mix(in srgb, var(--red) 30%, var(--border));
  background: var(--red-dim);
  color: color-mix(in srgb, var(--red) 76%, var(--text));
}

.task-pr-link {
  margin-bottom: 8px;
}

.task-pr-link a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
  font-size: 0.72rem;
  font-weight: 600;
  text-decoration: none;
  transition: color 150ms;
}

.task-pr-link a:hover {
  color: var(--text);
}

.task-focus-row {
  margin-bottom: 8px;
}

.task-focus-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 9px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 600;
  transition: background var(--duration-fast) ease, border-color var(--duration-fast) ease, color var(--duration-fast) ease;
}

.task-focus-btn:hover {
  border-color: var(--border-accent);
  background: var(--accent-hover);
  color: var(--text);
}

.task-focus-btn:focus-visible,
.task-action-btn:focus-visible,
.task-pr-link a:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.task-actions {
  display: flex;
  gap: 4px;
  margin-top: 8px;
}

.task-action-btn {
  padding: 3px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.7rem;
  font-weight: 600;
  transition: background var(--duration-fast) ease, color var(--duration-fast) ease, border-color var(--duration-fast) ease;
}

.task-action-btn:hover {
  border-color: var(--border-accent);
  background: var(--accent-hover);
  color: var(--text);
}

.task-action-btn:disabled {
  cursor: wait;
  opacity: 0.4;
}

.task-action-btn.accept { color: var(--task-accepted); border-color: color-mix(in srgb, var(--task-accepted) 38%, var(--border)); }
.task-action-btn.cancel { color: var(--task-blocked); border-color: color-mix(in srgb, var(--task-blocked) 38%, var(--border)); }
.task-action-btn.merge { color: var(--task-merged); border-color: color-mix(in srgb, var(--task-merged) 38%, var(--border)); }

@media (max-width: 768px) {
  .task-card {
    padding: 10px;
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
    min-height: 44px;
    min-width: 60px;
    text-align: center;
  }

  .task-focus-btn {
    min-height: 44px;
  }

  .task-pr-link a {
    min-height: 44px;
    padding-block: 8px;
  }
}
</style>
