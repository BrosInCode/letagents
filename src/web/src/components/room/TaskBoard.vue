<template>
  <div ref="boardPanel" class="board-panel">
    <header class="board-header">
      <div class="board-heading">
        <h2>Board</h2>
        <p>{{ openCount }} active {{ openCount === 1 ? 'task' : 'tasks' }}</p>
      </div>
      <TaskBoardAddForm @addTask="emit('addTask', $event)" />
    </header>

    <div class="board-controls">
      <div class="board-filters" role="group" aria-label="Task filters">
        <button
          v-for="filter in filters"
          :key="filter.id"
          type="button"
          :aria-pressed="activeFilter === filter.id"
          @click="activeFilter = filter.id; statusFilter = ''"
        >
          {{ filter.label }} <span>{{ filter.count }}</span>
        </button>
      </div>
      <div class="board-refine">
        <input v-model="searchQuery" type="search" aria-label="Search tasks" placeholder="Search tasks..." class="board-search" />
        <AppSelect v-model="ownerFilter" aria-label="Filter by owner">
          <option value="">All owners</option>
          <option value="unassigned">Unassigned</option>
          <option v-for="owner in owners" :key="owner.key" :value="owner.key">{{ owner.label }}</option>
        </AppSelect>
        <AppSelect v-model="statusFilter" aria-label="Filter by status" @update:model-value="activeFilter = 'all'">
          <option value="">All statuses</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ taskStatusLabel(status) }}</option>
        </AppSelect>
        <AppSelect :model-value="sortOrder" aria-label="Sort tasks" @update:model-value="sortOrder = $event as typeof sortOrder">
          <option value="recent">Recently updated</option>
          <option value="oldest">Oldest first</option>
          <option value="title">Title A-Z</option>
        </AppSelect>
        <button v-if="searchQuery || ownerFilter || statusFilter" type="button" class="board-clear" @click="clearFilters">Clear filters</button>
      </div>
    </div>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ statusAnnouncement }}
    </p>
    <p v-if="mutationError && !modalTask" class="board-mutation-error" role="alert">{{ mutationError }}</p>

    <TaskBoardEmptyState v-if="tasks.length === 0" />
    <div v-else-if="filteredTasks.length === 0" class="board-filter-empty">
      <h3>{{ searchQuery ? 'No matching tasks' : 'No tasks in this view' }}</h3>
      <button type="button" @click="clearFilters(); activeFilter = 'all'">Show all tasks</button>
    </div>

    <div v-else class="board-kanban-scroll" tabindex="0" aria-label="Task lifecycle board">
      <div class="board-kanban">
        <TaskBoardGroup
          v-for="group in groupedTasks"
          :key="group.status"
          :group="group"
          :collapsed="collapsedGroups.has(group.status)"
          :taskGithubStatus="taskGithubStatus"
          :updatingTask="updatingTask"
          :mutationBusy="mutationBusy"
          :selectedTaskId="modalTaskId || selectedTaskId"
          @toggle="toggleGroup"
          @updateStatus="handleUpdateStatus"
          @select="openTask"
        />
      </div>
    </div>
    <TaskBoardTaskDialog
      v-if="modalTask" :key="modalTask.id" :task="modalTask" :presence="presence"
      :can-manage-leases="canManageLeases" :github-status="taskGithubStatus[modalTask.id] ?? null"
      :updating="updatingTask === modalTask.id" :locked="mutationBusy" :updating-lease="updatingLeaseTask === modalTask.id"
      :updating-review-lease="updatingReviewLeaseTask === modalTask.id"
      :error="errorTaskId === modalTask.id ? mutationError : ''" :save-content="saveTaskContent"
      @close="closeTask" @update-status="handleUpdateStatus"
      @lease-action="handleLeaseAction" @review-lease-action="handleReviewLeaseAction"
      @focus-task="focusTask"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { TaskContentPatch } from '../../../../../shared/task-markdown-editing.mjs'

import { type RoomAgentPresence, type RoomTask, type TaskGitHubArtifactStatus } from '@/composables/useRoom'
import { TASK_STATUS_ORDER, taskStatusLabel } from '@/domain/taskStatus'
import AppSelect from '@/components/ui/AppSelect.vue'
import TaskBoardAddForm from './task-board/TaskBoardAddForm.vue'
import TaskBoardEmptyState from './task-board/TaskBoardEmptyState.vue'
import TaskBoardGroup from './task-board/TaskBoardGroup.vue'
import TaskBoardTaskDialog from './task-board/TaskBoardTaskDialog.vue'
import {
  useTaskGroups,
  filterBoardTasks,
  isCloseoutTask,
  boardOwnerKey,
  formatActorName,
  type TaskLeaseActionPayload,
  type TaskReviewLeaseActionPayload,
} from './task-board/model'
import type { TaskUpdatePayload } from './task-board/types'

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
  updateTask: [payload: TaskUpdatePayload]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
  closeTask: []
}>()

const updatingTask = ref<string | null>(null)
const updatingLeaseTask = ref<string | null>(null)
const updatingReviewLeaseTask = ref<string | null>(null)
const collapsedGroups = ref(new Set<string>())
const boardPanel = ref<HTMLElement | null>(null)
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
const statusAnnouncement = ref('')
const activeFilter = ref<'open' | 'review' | 'closeout' | 'all'>('open')
const searchQuery = ref('')
const ownerFilter = ref('')
const statusFilter = ref('')
const sortOrder = ref<'recent' | 'oldest' | 'title'>('recent')
const owners = computed(() => [...new Map(props.tasks.filter(task => task.assignee).map(task => [
  boardOwnerKey(task), { key: boardOwnerKey(task), label: formatActorName(task.assignee) },
])).values()].sort((a, b) => a.label.localeCompare(b.label)))
const statuses = computed(() => [...new Set([...TASK_STATUS_ORDER, ...props.tasks.map(task => task.status)])])
const openCount = computed(() => props.tasks.filter(task => !isCloseoutTask(task)).length)
const filters = computed(() => [
  { id: 'open' as const, label: 'Open', count: openCount.value },
  { id: 'review' as const, label: 'Needs review', count: props.tasks.filter(task => task.status === 'in_review').length },
  { id: 'closeout' as const, label: 'Closeout', count: props.tasks.filter(isCloseoutTask).length },
  { id: 'all' as const, label: 'All tasks', count: props.tasks.length },
])
const filteredTasks = computed(() => filterBoardTasks(props.tasks, activeFilter.value, searchQuery.value, {
  owner: ownerFilter.value, status: statusFilter.value, sort: sortOrder.value,
}))
const groupedTasks = useTaskGroups(filteredTasks)
let nextStatusUpdateRequestId = 0

watch(() => props.roomIdentifier, () => {
  nextStatusUpdateRequestId += 1
  pendingMovedTask.value = null
  updatingTask.value = null
  statusAnnouncement.value = ''
  clearFilters()
  sortOrder.value = 'recent'
  activeFilter.value = 'open'
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

async function revealAndFocusTask(taskId: string, status: string) {
  if (!filteredTasks.value.some(task => task.id === taskId)) {
    clearFilters()
    activeFilter.value = 'all'
  }
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
  if (!modalTaskId.value) card?.focus({ preventScroll: true })
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

function toggleGroup(status: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(status)) {
    next.delete(status)
  } else {
    next.add(status)
  }
  collapsedGroups.value = next
}

function clearFilters() {
  searchQuery.value = ''
  ownerFilter.value = ''
  statusFilter.value = ''
}

function handleUpdateStatus(taskId: string, status: string) {
  if (mutationBusy.value) return
  const requestId = ++nextStatusUpdateRequestId
  const pending = { requestId, taskId, targetStatus: status }
  pendingMovedTask.value = pending
  statusAnnouncement.value = ''
  mutationError.value = ''
  errorTaskId.value = taskId
  updatingTask.value = taskId
  emit('updateTask', {
    taskId,
    status,
    onSettled: async (updated) => {
      if (pendingMovedTask.value?.requestId !== requestId) return
      pendingMovedTask.value = null
      updatingTask.value = null
      if (!updated) {
        mutationError.value = 'Task could not be updated. Try again.'
        statusAnnouncement.value = mutationError.value
        return
      }
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
  padding: 28px 28px 24px;
  container-type: inline-size;
  background: var(--bg);
  color: var(--text);
}
.board-panel:has(> .board-mutation-error) { grid-template-rows: auto auto auto minmax(0, 1fr); }
.board-mutation-error { margin: 16px 0 0; padding: 12px; border: 1px solid var(--red-text); border-radius: 6px; background: var(--red-dim); color: var(--red-text); font-size: 0.8125rem; }

.board-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  margin-bottom: 24px;
}

.board-heading {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.board-heading h2 {
  margin: 0;
  color: var(--text);
  font-size: 1.25rem;
  font-weight: 650;
  letter-spacing: 0;
  line-height: 1.2;
}

.board-heading p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.4;
}

.board-kanban-scroll {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 24px 2px 2px;
  scroll-padding-inline: 2px;
}

.board-kanban-scroll:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

.board-kanban {
  display: grid;
  grid-auto-columns: 280px;
  grid-auto-flow: column;
  grid-template-columns: none;
  gap: 24px;
  align-items: start;
  width: max-content;
  min-width: 100%;
}

.board-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.board-refine { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.board-refine .board-search { width: 220px; }
.board-refine :deep(.app-select) {
  --app-select-height: 36px;
  --app-select-radius: 6px;
  --app-select-bg: var(--bg-subtle);
  --app-select-border: var(--border);
  --app-select-text: var(--text-secondary);
  --app-select-focus: var(--blue);
  flex: 0 1 170px;
  width: 170px;
  min-width: 0;
  max-width: 100%;
}
.board-clear {
  min-width: 0; max-width: 200px; min-height: 36px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-subtle); color: var(--text-secondary);
  font: inherit; font-size: 0.75rem; cursor: pointer;
}
.board-clear { border-color: transparent; background: transparent; }
.board-filters {
  display: flex;
  gap: 18px;
  min-width: 0;
  overflow: auto;
  padding: 2px;
}
.board-filters button {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.8125rem;
  white-space: nowrap;
  cursor: pointer;
}
.board-filters button[aria-pressed="true"] {
  color: var(--text);
  border-bottom-color: var(--text);
}
.board-filters button span {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.board-search {
  min-width: 0;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
}
.board-search::placeholder { color: var(--text-tertiary); }
.board-filter-empty {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 16px;
  min-height: 260px;
}
.board-filter-empty h3 { margin: 0; font-size: 1rem; font-weight: 600; }
.board-filter-empty button {
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--text);
  background: var(--bg-subtle);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}
.board-controls :is(button, input):focus-visible,
.board-filter-empty button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
@container (max-width: 780px) {
  .board-controls { grid-template-columns: minmax(0, 1fr); gap: 12px; }
}
@media (hover: hover) and (pointer: fine) {
  .board-filters button:hover { color: var(--text); }
}
@media (max-width: 768px) {
  .board-search, .board-filters button { min-height: 44px; }
  .board-refine .board-search { width: 100%; }
  .board-refine :deep(.app-select) { flex: 1 1 160px; --app-select-height: 44px; }
  .board-kanban { grid-auto-columns: minmax(260px, calc(100vw - 52px)); }
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
