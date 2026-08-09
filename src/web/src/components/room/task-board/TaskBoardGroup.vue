<template>
  <section class="board-group" :style="{ '--task-accent': taskStatusAccent(group.status) }">
    <h3 class="board-group-heading-shell">
      <button
        class="board-group-title"
        type="button"
        :aria-expanded="!collapsed"
        :aria-controls="`task-group-${group.status}`"
        @click="emit('toggle', group.status)"
      >
        <span class="board-group-heading">
          <span class="board-group-chevron">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
          <span class="board-group-dot" aria-hidden="true"></span>
          {{ group.label }}
        </span>
        <span class="board-group-count">{{ group.tasks.length }}</span>
      </button>
    </h3>
    <div v-if="!collapsed" :id="`task-group-${group.status}`" class="board-group-list">
      <TaskBoardCard
        v-for="task in group.tasks"
        :key="task.id"
        :task="task"
        :presence="presence"
        :canManageLeases="canManageLeases"
        :githubStatus="taskGithubStatus[task.id] ?? null"
        :updating="updatingTask === task.id"
        :updatingLease="updatingLeaseTask === task.id"
        :updatingReviewLease="updatingReviewLeaseTask === task.id"
        :selected="selectedTaskId === task.id"
        @updateStatus="(taskId, status) => emit('updateStatus', taskId, status)"
        @leaseAction="emit('leaseAction', $event)"
        @reviewLeaseAction="emit('reviewLeaseAction', $event)"
        @focusTask="emit('focusTask', $event)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { RoomAgentPresence, TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { taskStatusAccent } from '../../../domain/taskStatus'
import TaskBoardCard from './TaskBoardCard.vue'
import type {
  TaskGroup,
  TaskLeaseActionPayload,
  TaskReviewLeaseActionPayload,
} from './model'

defineProps<{
  group: TaskGroup
  collapsed: boolean
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  updatingTask: string | null
  updatingLeaseTask: string | null
  updatingReviewLeaseTask: string | null
  selectedTaskId?: string | null
}>()

const emit = defineEmits<{
  toggle: [status: string]
  updateStatus: [taskId: string, status: string]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
}>()
</script>

<style scoped>
.board-group {
  --task-accent: var(--text-tertiary);
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 252px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}

.board-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 0 2px 6px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.board-group-heading-shell {
  margin: 0;
}

.board-group-title:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.board-group-heading {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.board-group-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  transition: transform var(--duration-fast) ease;
}

.board-group-title[aria-expanded="false"] .board-group-chevron {
  transform: rotate(-90deg);
}

.board-group-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--task-accent);
}

.board-group-count {
  display: inline-grid;
  place-items: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}

.board-group-list {
  display: grid;
  gap: 8px;
}

@media (hover: hover) and (pointer: fine) {
  .board-group-title:hover { color: var(--text); }
}

@media (max-width: 640px) {
  .board-group-title { min-height: 44px; }
}
</style>
