<template>
  <div class="board-workspace-host">
    <BoardWorkspace
      ref="workspace"
      :room-id="roomIdentifier || ''"
      :tasks="workspaceTasks"
      :services="workspaceServices"
      :busy="mutationBusy || creatingTask"
      :error="!modalTask && !createOpen ? mutationError : null"
      @select="openTask"
      @create="openCreateTask"
      @refresh="emit('refresh')"
    />
    <RoomBoardCreateTaskDialog :open="createOpen" :planning-snapshot="workspace?.snapshot" :selected-sprint-id="workspace?.selectedSprintId" :busy-action="creatingTask ? 'add' : null" :error="createError" @close="createOpen = false" @create="submitCreateTask" />
    <TaskBoardTaskDialog
      v-if="modalTask" :key="modalTask.id" :task="modalTask" :presence="presence"
      :can-manage-leases="canManageLeases" :github-status="taskGithubStatus[modalTask.id] ?? null"
      :updating="updatingTask === modalTask.id" :locked="mutationBusy" :updating-lease="updatingLeaseTask === modalTask.id"
      :updating-review-lease="updatingReviewLeaseTask === modalTask.id"
      :error="errorTaskId === modalTask.id ? mutationError : ''" :save-content="saveTaskContent"
      @close="closeTask" @update-status="handleUpdateStatus"
      @lease-action="handleLeaseAction" @review-lease-action="handleReviewLeaseAction"
      @focus-task="focusTask"
    >
      <template #planning>
        <BoardTaskPlanning v-if="workspace?.snapshot" :task-id="modalTask.id" :snapshot="workspace.snapshot" :save="workspace.savePlanning" />
      </template>
    </TaskBoardTaskDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { TaskContentPatch } from '../../../../../shared/task-markdown-editing.mjs'
import type { BoardServices } from '../../../../../shared/ui/board/types'
import BoardWorkspace from '../../../../../shared/ui/board/BoardWorkspace.vue'
import BoardTaskPlanning from '../../../../../shared/ui/board/BoardTaskPlanning.vue'
import type { BoardPlanningDocument, BoardPlanningSnapshot, BoardTaskPlanning as BoardTaskPlanningFields } from '../../../../../shared/board-planning.mjs'
import RoomBoardCreateTaskDialog from '../../../../../apps/desktop/renderer/src/components/desktop/content/room-board/RoomBoardCreateTaskDialog.vue'
import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { fetchBoardPlanning, saveBoardPlanning } from '@/composables/room/boardPlanning'
import TaskBoardTaskDialog from './task-board/TaskBoardTaskDialog.vue'
import { getTaskActions, type TaskLeaseActionPayload, type TaskReviewLeaseActionPayload } from './task-board/model'
import { webBoardTask } from './task-board/workspace-tasks'
import type { TaskCreatePayload, TaskUpdatePayload } from './task-board/types'

const props = defineProps<{
  tasks: readonly RoomTask[]
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  selectedTaskId?: string | null
  roomIdentifier?: string | null
}>()
const emit = defineEmits<{
  addTask: [input: TaskCreatePayload]
  updateTask: [payload: TaskUpdatePayload]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
  closeTask: []
  refresh: []
}>()
const workspace = ref<{ snapshot: BoardPlanningSnapshot | null; selectedSprintId: string; applyCreatedPlanning: (id: string, planning: BoardTaskPlanningFields) => Promise<boolean>; savePlanning: (document: BoardPlanningDocument) => Promise<boolean>; revealTask?: (taskId: string) => Promise<void> } | null>(null)
const workspaceTasks = computed(() => props.tasks.map(task => webBoardTask(task, props.presence, props.taskGithubStatus[task.id])))
const workspaceServices: BoardServices = {
  loadPlanning: () => fetchBoardPlanning(props.roomIdentifier || ''),
  savePlanning: (expectedRevision, document) => saveBoardPlanning(props.roomIdentifier || '', { expectedRevision, document }),
  moveTask: async (taskId, transitionId) => {
    const task = props.tasks.find(candidate => candidate.id === taskId)
    if (!task || !getTaskActions(task).some(action => action.status === transitionId)) return false
    return handleUpdateStatus(taskId, transitionId)
  },
  openExternal: url => { window.open(url, '_blank', 'noopener,noreferrer') },
}
const createOpen = ref(false)
const creatingTask = ref(false)
const createError = ref<string | null>(null)
function openCreateTask() { createError.value = null; createOpen.value = true }
function submitCreateTask(input: { title: string; description: string | null; planning?: BoardTaskPlanningFields }) {
  if (creatingTask.value) return
  const room = props.roomIdentifier
  creatingTask.value = true
  createError.value = null
  emit('addTask', { title: input.title, description: input.description, onSettled: async (created, taskId) => {
    if (props.roomIdentifier !== room) return
    creatingTask.value = false
    if (created) {
      createOpen.value = false
      if (taskId) {
        await nextTick()
        if (props.roomIdentifier !== room) return
        openTask(taskId)
        await nextTick()
        if (input.planning && !await workspace.value?.applyCreatedPlanning(taskId, input.planning)) {
          if (props.roomIdentifier !== room) return
          errorTaskId.value = taskId
          mutationError.value = 'Task created, but its planning was not saved. Set it in this panel.'
        }
        if (props.roomIdentifier === room) await workspace.value?.revealTask?.(taskId)
      }
    }
    else createError.value = 'Task could not be created. Your draft is still here.'
  } })
}
const updatingTask = ref<string | null>(null)
const updatingLeaseTask = ref<string | null>(null)
const updatingReviewLeaseTask = ref<string | null>(null)
const modalTaskId = ref<string | null>(null)
const mutationError = ref('')
const errorTaskId = ref<string | null>(null)
const mutationBusy = computed(() => Boolean(updatingTask.value || updatingLeaseTask.value || updatingReviewLeaseTask.value))
const modalTask = computed(() => props.tasks.find(task => task.id === modalTaskId.value) ?? null)
const pendingMovedTask = ref<{
  requestId: number
  taskId: string
  targetStatus: string
} | null>(null)
let nextStatusUpdateRequestId = 0

watch(() => props.roomIdentifier, () => {
  nextStatusUpdateRequestId += 1
  pendingMovedTask.value = null
  updatingTask.value = null
  createOpen.value = false
  creatingTask.value = false
  modalTaskId.value = null
  mutationError.value = ''
  updatingLeaseTask.value = null
  updatingReviewLeaseTask.value = null
})

watch([
  () => props.selectedTaskId || null,
  () => {
    const taskId = props.selectedTaskId || null
    return taskId
      ? props.tasks.find(candidate => candidate.id === taskId)?.status ?? null
      : null
  },
], async ([taskId, status], previous) => {
  if (!taskId || !status) return
  if (previous?.[0] !== taskId || !previous?.[1]) openTask(taskId)
  await revealAndFocusTask(taskId, status)
}, { immediate: true })

async function revealAndFocusTask(taskId: string, _status: string) {
  await nextTick()
  await workspace.value?.revealTask?.(taskId)
}

async function closeTask() {
  const task = modalTask.value
  modalTaskId.value = null
  emit('closeTask')
  if (task) await revealAndFocusTask(task.id, task.status)
}

function openTask(taskId: string) {
  mutationError.value = ''
  modalTaskId.value = taskId
}

function focusTask(taskId: string) {
  modalTaskId.value = null
  emit('closeTask')
  emit('focusTask', taskId)
}

function handleUpdateStatus(taskId: string, status: string): Promise<boolean> {
  if (mutationBusy.value) return Promise.resolve(false)
  const requestId = ++nextStatusUpdateRequestId
  pendingMovedTask.value = { requestId, taskId, targetStatus: status }
  mutationError.value = ''
  errorTaskId.value = taskId
  updatingTask.value = taskId
  return new Promise(resolve => emit('updateTask', {
    taskId, status,
    onSettled: updated => {
      if (pendingMovedTask.value?.requestId !== requestId) { resolve(false); return }
      pendingMovedTask.value = null
      updatingTask.value = null
      if (!updated) mutationError.value = 'Task could not be updated. Try again.'
      resolve(updated)
    },
  }))
}

function saveTaskContent(input: TaskContentPatch): Promise<boolean> {
  const taskId = modalTaskId.value
  if (!taskId || mutationBusy.value) return Promise.resolve(false)
  const requestId = ++nextStatusUpdateRequestId
  updatingTask.value = taskId
  mutationError.value = ''
  errorTaskId.value = taskId
  return new Promise(resolve => emit('updateTask', {
    taskId, ...input,
    onSettled: updated => {
      if (requestId !== nextStatusUpdateRequestId) { resolve(false); return }
      updatingTask.value = null
      if (!updated) mutationError.value = 'Changes could not be saved. Your draft is still here.'
      resolve(updated)
    },
  }))
}

function settleLeaseBusy(taskId: string) {
  if (updatingLeaseTask.value === taskId) {
    updatingLeaseTask.value = null
  }
}

function handleLeaseAction(payload: TaskLeaseActionPayload) {
  if (mutationBusy.value) return
  const room = props.roomIdentifier
  mutationError.value = ''
  errorTaskId.value = payload.taskId
  updatingLeaseTask.value = payload.taskId
  emit('leaseAction', {
    ...payload,
    onSettled: (updated) => {
      if (props.roomIdentifier !== room) return
      settleLeaseBusy(payload.taskId)
      if (updated === false) mutationError.value = 'Task ownership could not be updated. Try again.'
      payload.onSettled?.(updated)
    },
  })
}

function settleReviewLeaseBusy(taskId: string) {
  if (updatingReviewLeaseTask.value === taskId) {
    updatingReviewLeaseTask.value = null
  }
}

function handleReviewLeaseAction(payload: TaskReviewLeaseActionPayload) {
  if (mutationBusy.value) return
  const room = props.roomIdentifier
  mutationError.value = ''
  errorTaskId.value = payload.taskId
  updatingReviewLeaseTask.value = payload.taskId
  emit('reviewLeaseAction', {
    ...payload,
    onSettled: (updated) => {
      if (props.roomIdentifier !== room) return
      settleReviewLeaseBusy(payload.taskId)
      if (updated === false) mutationError.value = 'Review assignment could not be updated. Try again.'
      payload.onSettled?.(updated)
    },
  })
}
</script>

<style scoped>
.board-workspace-host { height: 100%; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
</style>
