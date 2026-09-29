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
          <span class="board-group-dot" aria-hidden="true"></span>
          {{ group.label }}
          <span class="board-group-count">{{ group.tasks.length }}</span>
        </span>
        <span class="board-group-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
    </h3>
    <div v-show="!collapsed" :id="`task-group-${group.status}`" class="board-group-list">
      <TaskBoardCard
        v-for="task in group.tasks"
        :key="task.id"
        :task="task"
        :githubStatus="taskGithubStatus[task.id] ?? null"
        :updating="updatingTask === task.id"
        :mutation-busy="mutationBusy"
        :selected="selectedTaskId === task.id"
        @updateStatus="(taskId, status) => emit('updateStatus', taskId, status)"
        @select="emit('select', $event)"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { taskStatusAccent } from '../../../domain/taskStatus'
import TaskBoardCard from './TaskBoardCard.vue'
import type {
  TaskGroup,
} from './model'

defineProps<{
  group: TaskGroup
  collapsed: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  updatingTask: string | null
  mutationBusy: boolean
  selectedTaskId?: string | null
}>()

const emit = defineEmits<{
  toggle: [status: string]
  updateStatus: [taskId: string, status: string]
  select: [taskId: string]
}>()
</script>

<style scoped>
.board-group {
  --task-accent: var(--text-tertiary);
  display: grid;
  align-content: start;
  gap: 14px;
  min-width: 0;
}

.board-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  padding: 0 2px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 550;
  letter-spacing: 0;
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
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
}

.board-group-list {
  display: grid;
  gap: 12px;
}

@media (hover: hover) and (pointer: fine) {
  .board-group-title:hover { color: var(--text); }
}

@media (max-width: 640px) {
  .board-group-title { min-height: 44px; }
}
</style>
