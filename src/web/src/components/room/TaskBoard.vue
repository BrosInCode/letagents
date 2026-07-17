<template>
  <div ref="boardPanel" class="board-panel">
    <TaskBoardAddForm @addTask="emit('addTask', $event)" />
    <TaskBoardEmptyState v-if="groupedTasks.length === 0" />

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
</template>

<script setup lang="ts">
import { nextTick, ref, toRef, watch } from 'vue'

import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import TaskBoardAddForm from './task-board/TaskBoardAddForm.vue'
import TaskBoardEmptyState from './task-board/TaskBoardEmptyState.vue'
import TaskBoardGroup from './task-board/TaskBoardGroup.vue'
import {
  useTaskGroups,
  type TaskLeaseActionPayload,
  type TaskReviewLeaseActionPayload,
} from './task-board/model'

const props = defineProps<{
  tasks: readonly RoomTask[]
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  selectedTaskId?: string | null
}>()

const emit = defineEmits<{
  addTask: [title: string]
  updateTask: [taskId: string, updates: { status: string }]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
}>()

const updatingTask = ref<string | null>(null)
const updatingLeaseTask = ref<string | null>(null)
const updatingReviewLeaseTask = ref<string | null>(null)
const collapsedGroups = ref(new Set<string>())
const boardPanel = ref<HTMLElement | null>(null)
const groupedTasks = useTaskGroups(toRef(props, 'tasks'))

watch(() => props.selectedTaskId || null, async (taskId) => {
  if (!taskId) return
  const task = props.tasks.find(candidate => candidate.id === taskId)
  if (!task) return
  const nextCollapsed = new Set(collapsedGroups.value)
  nextCollapsed.delete(task.status)
  collapsedGroups.value = nextCollapsed
  await nextTick()
  const card = Array.from(
    boardPanel.value?.querySelectorAll<HTMLElement>('[data-board-task-id]') || [],
  ).find(candidate => candidate.dataset.boardTaskId === taskId)
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  card?.focus({ preventScroll: true })
}, { immediate: true })

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
  updatingTask.value = taskId
  emit('updateTask', taskId, { status })
  setTimeout(() => { updatingTask.value = null }, 1000)
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
  height: 100%;
  overflow-y: auto;
  padding: var(--space-xl) var(--space-lg);
}

@media (max-width: 768px) {
  .board-panel {
    padding: 12px;
  }
}
</style>
