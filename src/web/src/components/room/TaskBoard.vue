<template>
  <div ref="boardPanel" class="board-panel">
    <header class="board-header">
      <div class="board-heading">
        <h2>Tasks</h2>
        <p>Track ownership and move work through review.</p>
      </div>
      <TaskBoardAddForm @addTask="emit('addTask', $event)" />
    </header>

    <TaskBoardLegend />

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ statusAnnouncement }}
    </p>

    <TaskBoardEmptyState v-if="tasks.length === 0" />

    <div v-else class="board-kanban-scroll" tabindex="0" aria-label="Task lifecycle board">
      <div class="board-kanban">
        <TaskBoardGroup
          v-for="group in groupedTasks"
          :key="group.status"
          :group="group"
          :collapsed="collapsedGroups.has(group.status)"
          :presence="presence"
          :canManageLeases="canManageLeases"
          :taskGithubStatus="taskGithubStatus"
          :updatingTask="updatingTask"
          :updatingLeaseTask="updatingLeaseTask"
          :updatingReviewLeaseTask="updatingReviewLeaseTask"
          :selectedTaskId="selectedTaskId"
          @toggle="toggleGroup"
          @updateStatus="handleUpdateStatus"
          @leaseAction="handleLeaseAction"
          @reviewLeaseAction="handleReviewLeaseAction"
          @focusTask="emit('focusTask', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, watch } from 'vue'

import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { taskStatusLabel } from '@/domain/taskStatus'
import TaskBoardAddForm from './task-board/TaskBoardAddForm.vue'
import TaskBoardEmptyState from './task-board/TaskBoardEmptyState.vue'
import TaskBoardGroup from './task-board/TaskBoardGroup.vue'
import TaskBoardLegend from './task-board/TaskBoardLegend.vue'
import {
  useTaskGroups,
  type TaskLeaseActionPayload,
  type TaskReviewLeaseActionPayload,
} from './task-board/model'
import type { TaskStatusUpdatePayload } from './task-board/types'

const props = defineProps<{
  tasks: readonly RoomTask[]
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  selectedTaskId?: string | null
  roomIdentifier?: string | null
}>()

const emit = defineEmits<{
  addTask: [title: string]
  updateTask: [payload: TaskStatusUpdatePayload]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
}>()

const updatingTask = ref<string | null>(null)
const updatingLeaseTask = ref<string | null>(null)
const updatingReviewLeaseTask = ref<string | null>(null)
const collapsedGroups = ref(new Set<string>())
const boardPanel = ref<HTMLElement | null>(null)
const pendingMovedTask = ref<{
  requestId: number
  taskId: string
  targetStatus: string
} | null>(null)
const statusAnnouncement = ref('')
const groupedTasks = useTaskGroups(toRef(props, 'tasks'))
let nextStatusUpdateRequestId = 0

watch(() => props.roomIdentifier, () => {
  pendingMovedTask.value = null
  updatingTask.value = null
  statusAnnouncement.value = ''
})

watch([
  () => props.selectedTaskId || null,
  () => {
    const taskId = props.selectedTaskId || null
    return taskId
      ? props.tasks.find(candidate => candidate.id === taskId)?.status ?? null
      : null
  },
], async ([taskId, status]) => {
  if (!taskId || !status) return
  await revealAndFocusTask(taskId, status)
}, { immediate: true })

async function revealAndFocusTask(taskId: string, status: string) {
  const nextCollapsed = new Set(collapsedGroups.value)
  nextCollapsed.delete(status)
  collapsedGroups.value = nextCollapsed
  await nextTick()
  const card = Array.from(
    boardPanel.value?.querySelectorAll<HTMLElement>('[data-board-task-id]') || [],
  ).find(candidate => candidate.dataset.boardTaskId === taskId)
  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  card?.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'nearest',
    inline: 'nearest',
  })
  card?.focus({ preventScroll: true })
}

function toggleGroup(status: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(status)) {
    next.delete(status)
  } else {
    next.add(status)
  }
  collapsedGroups.value = next
}

function handleUpdateStatus(taskId: string, status: string) {
  const requestId = ++nextStatusUpdateRequestId
  const pending = { requestId, taskId, targetStatus: status }
  pendingMovedTask.value = pending
  statusAnnouncement.value = ''
  updatingTask.value = taskId
  emit('updateTask', {
    taskId,
    status,
    onSettled: async (updated) => {
      if (pendingMovedTask.value?.requestId !== requestId) return
      pendingMovedTask.value = null
      updatingTask.value = null
      if (!updated) return
      await nextTick()
      const task = props.tasks.find(candidate => (
        candidate.id === taskId && candidate.status === status
      ))
      if (!task) return
      await revealAndFocusTask(task.id, task.status)
      statusAnnouncement.value = `${task.title} moved to ${taskStatusLabel(task.status)}.`
    },
  })
}

function settleLeaseBusy(taskId: string) {
  if (updatingLeaseTask.value === taskId) {
    updatingLeaseTask.value = null
  }
}

function handleLeaseAction(payload: TaskLeaseActionPayload) {
  updatingLeaseTask.value = payload.taskId
  emit('leaseAction', {
    ...payload,
    onSettled: () => {
      settleLeaseBusy(payload.taskId)
      payload.onSettled?.()
    },
  })
}

function settleReviewLeaseBusy(taskId: string) {
  if (updatingReviewLeaseTask.value === taskId) {
    updatingReviewLeaseTask.value = null
  }
}

function handleReviewLeaseAction(payload: TaskReviewLeaseActionPayload) {
  updatingReviewLeaseTask.value = payload.taskId
  emit('reviewLeaseAction', {
    ...payload,
    onSettled: () => {
      settleReviewLeaseBusy(payload.taskId)
      payload.onSettled?.()
    },
  })
}
</script>

<style scoped>
.board-panel {
  --text-tertiary: var(--board-muted);
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100%;
  max-width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: clamp(18px, 2vw, 26px) clamp(16px, 2.4vw, 30px) 20px;
  background: var(--bg);
  color: var(--text);
}

.board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin-bottom: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.board-heading {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.board-heading h2 {
  margin: 0;
  color: var(--text);
  font-size: 1.125rem;
  font-weight: 720;
  letter-spacing: -0.015em;
  line-height: 1.2;
}

.board-heading p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
}

.board-kanban-scroll {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 14px 0 2px;
  scroll-padding-inline: 2px;
}

.board-kanban-scroll:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

.board-kanban {
  display: grid;
  grid-auto-columns: minmax(270px, 304px);
  grid-auto-flow: column;
  grid-template-columns: none;
  gap: 12px;
  align-items: start;
  width: max-content;
  min-width: 100%;
}

@media (max-width: 768px) {
  .board-panel {
    padding: 16px 12px 14px;
  }

  .board-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }

  .board-heading p {
    max-width: 32rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .board-panel *, .board-panel *::before, .board-panel *::after {
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
    animation-duration: 1ms !important;
  }
}
</style>
