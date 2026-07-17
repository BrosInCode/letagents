<template>
  <div class="board-group">
    <h3 class="board-group-title" @click="emit('toggle', group.status)">
      <span class="board-group-chevron" :class="{ collapsed }">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
      {{ group.label }}
      <span class="board-group-count">{{ group.tasks.length }}</span>
    </h3>
    <template v-if="!collapsed">
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
    </template>
  </div>
</template>

<script setup lang="ts">
import type { RoomAgentPresence, TaskGitHubArtifactStatus } from '@/composables/useRoom'
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
  margin-bottom: 16px;
}

.board-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--muted, #71717a);
  cursor: pointer;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  transition: color 150ms;
  user-select: none;
}

.board-group-title:hover {
  color: var(--text, #fafafa);
}

.board-group-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 200ms ease;
}

.board-group-chevron.collapsed {
  transform: rotate(-90deg);
}

.board-group-count {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-size: 0.66rem;
}
</style>
