<template>
  <section class="room-tab-page desktop-board-panel" data-testid="room-board-view">
    <div class="desktop-board-toolbar">
      <div class="desktop-board-header">
        <div class="desktop-board-heading">
          <span>Board</span>
          <strong>Open work across this room</strong>
        </div>
        <button
          class="desktop-board-primary-action desktop-board-add-button"
          type="button"
          :disabled="busyAction !== null"
          @click="openCreateTaskModal"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
          Add task
        </button>
      </div>
      <div class="desktop-board-controls">
        <label class="desktop-board-search" for="room-board-search">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
          </svg>
          <span class="sr-only">Search tasks</span>
          <input
            id="room-board-search"
            v-model="searchQuery"
            type="search"
            placeholder="Search tasks by title, id, owner"
          />
        </label>
        <div class="desktop-board-filter-groups">
          <DesktopSegmentedControl
            class="desktop-board-segmented"
            :model-value="activeFilter"
            :options="boardFilterOptions"
            label="Board view filters"
            @update:model-value="setActiveFilter"
          />
        </div>
      </div>
    </div>

    <p v-if="errorMessage" class="desktop-board-error" role="alert">{{ errorMessage }}</p>

    <div v-if="groupedTasks.length === 0" class="desktop-task-empty desktop-board-empty-state" data-testid="room-board-empty">
      <div>
        <h3>No tasks yet</h3>
        <p>Add a task or use the <code>add_task</code> MCP tool.</p>
      </div>
    </div>

    <div v-else-if="visibleTaskCount === 0" class="desktop-task-empty desktop-board-empty-state">
      <div>
        <h3>No matching tasks</h3>
        <p>Clear the search or switch filters.</p>
      </div>
      <button type="button" class="desktop-board-clear-filter" @click="clearFilters">Clear filters</button>
    </div>

    <div v-else class="desktop-board-kanban-scroll">
      <div class="desktop-task-board" :data-filter="activeFilter">
        <section
          v-for="group in visibleGroups"
          :key="group.status"
          class="desktop-task-column"
          :data-status="group.status"
          :data-drop-active="dragOverStatus === group.status && canDropOnStatus(group.status)"
          :data-drop-disabled="draggedTaskId !== null && !canDropOnStatus(group.status)"
          :data-testid="`room-board-group-${group.status}`"
          @dragover="onColumnDragOver($event, group.status)"
          @dragleave="onColumnDragLeave(group.status)"
          @drop="onColumnDrop(group.status)"
        >
          <button
            class="desktop-task-column-header"
            type="button"
            :aria-expanded="!collapsedGroups.has(group.status)"
            @click="toggleGroup(group.status)"
          >
            <span class="desktop-task-column-title">
              <span class="desktop-task-column-dot" aria-hidden="true"></span>
              <span>{{ group.label }}</span>
            </span>
            <strong>{{ group.tasks.length }}</strong>
          </button>

          <div v-if="!collapsedGroups.has(group.status)" class="desktop-task-column-list">
            <RoomBoardTaskCard
              v-for="task in group.tasks"
              :key="task.id"
              :task="task"
              :actions="actionsFor(task)"
              :busy-action="busyAction"
              :draggable-task="canDragTask(task)"
              :selected="modalTask?.id === task.id"
              @drag-start="onTaskDragStart"
              @drag-end="onTaskDragEnd"
              @select="openTaskModal(task.id)"
              @run-action="(action) => runTaskAction(task, action)"
            />
          </div>
          <div v-else class="desktop-task-column-empty">Drop tasks here</div>
        </section>
      </div>
    </div>

    <div
      v-if="modalTask"
      class="desktop-task-modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="`Task details for ${modalTask.title}`"
      @click.self="closeTaskModal"
    >
      <div class="desktop-task-modal">
        <button
          type="button"
          class="desktop-task-modal-close"
          aria-label="Close task details"
          @click="closeTaskModal"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
        </button>
        <RoomBoardTaskInspector
          :task="modalTask"
          :actions="modalTaskActions"
          :busy-action="busyAction"
          :review-assignment-candidates="reviewAssignmentCandidates(modalTask)"
          :selected-reviewer="selectedReviewerByTask[modalTask.id] || ''"
          @assign-review="assignModalReview"
          @run-action="runModalTaskAction"
          @update:selected-reviewer="setModalReviewer"
          @view-events="emit('view-events', $event)"
        />
      </div>
    </div>

    <div
      v-if="isCreateTaskModalOpen"
      class="desktop-task-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="desktop-create-task-title"
      @click.self="closeCreateTaskModal"
    >
      <form class="desktop-task-modal desktop-task-create-modal" @submit.prevent="submitCreateTask">
        <button
          type="button"
          class="desktop-task-modal-close"
          aria-label="Close task creation"
          @click="closeCreateTaskModal"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
          </svg>
        </button>

        <header class="desktop-task-create-header">
          <span>New task</span>
          <h3 id="desktop-create-task-title">Describe the work</h3>
          <p>Write the task clearly enough for a human or agent to pick it up.</p>
        </header>

        <label class="desktop-task-create-field" for="desktop-create-task-description">
          <span>Description</span>
          <textarea
            id="desktop-create-task-description"
            ref="createTaskDescriptionField"
            v-model="createTaskDescription"
            rows="7"
            placeholder="What needs to be done?"
            :disabled="busyAction !== null"
          ></textarea>
        </label>

        <label class="desktop-task-create-field" for="desktop-create-task-title-input">
          <span>Title <small>optional</small></span>
          <input
            id="desktop-create-task-title-input"
            v-model="createTaskTitle"
            type="text"
            placeholder="Short label for the board"
            :disabled="busyAction !== null"
          />
        </label>

        <footer class="desktop-task-create-actions">
          <button
            type="button"
            class="desktop-task-detail-button"
            :disabled="busyAction !== null"
            @click="closeCreateTaskModal"
          >
            Cancel
          </button>
          <button
            class="desktop-board-primary-action"
            type="submit"
            :disabled="!canCreateTask || busyAction !== null"
          >
            {{ busyAction === "add" ? "Creating..." : "Create task" }}
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { DesktopAgentPresence, DesktopTaskSummary, WorkerSnapshot } from "../../../../../electron/ipc-types";
import DesktopSegmentedControl from "../controls/DesktopSegmentedControl.vue";
import RoomBoardTaskCard from "./room-board/RoomBoardTaskCard.vue";
import RoomBoardTaskInspector from "./room-board/RoomBoardTaskInspector.vue";
import { normalizeActor, normalizeRoom, readableStatus } from "./room-board/formatters";
import { reviewLeases, shouldShowReviewPanel, workLease } from "./room-board/task-state";
import { useRoomBoardController } from "./room-board/useRoomBoardController";
import type { TaskAction, TaskGroup } from "./room-board/types";

const props = defineProps<{
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
  selectedTaskId?: string | null;
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
  "update:selected-task-id": [taskId: string | null];
  "view-events": [taskId: string];
}>();

const {
  actionsFor,
  addTask,
  assignReview,
  busyAction,
  collapsedGroups,
  errorMessage,
  groupedTasks,
  reviewAssignmentCandidates,
  runTaskAction,
  selectedReviewerByTask,
  setSelectedReviewer,
  toggleGroup,
} = useRoomBoardController(props, emit);

type BoardFilter = "open" | "mine" | "unclaimed" | "needs-review" | "closed";

const ACTIVE_BOARD_STATUSES = ["proposed", "accepted", "assigned", "in_progress", "blocked", "in_review", "merged"];
const CLOSED_BOARD_STATUSES = ["done", "cancelled"];
const searchQuery = ref("");
const activeFilter = ref<BoardFilter>("open");
const draggedTaskId = ref<string | null>(null);
const dragOverStatus = ref<string | null>(null);
const localSelectedTaskId = ref<string | null>(props.selectedTaskId || null);
const isCreateTaskModalOpen = ref(false);
const createTaskTitle = ref("");
const createTaskDescription = ref("");
const createTaskDescriptionField = ref<HTMLTextAreaElement | null>(null);
const boardFilters: Array<{ id: BoardFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "mine", label: "Mine" },
  { id: "unclaimed", label: "Unclaimed" },
  { id: "needs-review", label: "Needs review" },
  { id: "closed", label: "Closed" },
];

const boardFilterOptions = computed(() =>
  boardFilters.map((filter) => ({
    ...filter,
    count: filterCount(filter.id),
  }))
);

const localWorker = computed(() =>
  props.workers.find((worker) =>
    worker.agentSessionId
    && normalizeRoom(worker.roomId) === normalizeRoom(props.roomIdentifier)
    && ["connected", "away"].includes(worker.state)
  ) || null
);

const visibleStatuses = computed(() =>
  activeFilter.value === "closed" ? CLOSED_BOARD_STATUSES : ACTIVE_BOARD_STATUSES
);

const visibleGroups = computed<TaskGroup[]>(() =>
  visibleStatuses.value.map((status) => ({
    status,
    label: groupedTasks.value.find((group) => group.status === status)?.label || readableStatus(status),
    tasks: props.tasks.filter((task) => task.status === status && taskMatchesActiveView(task)),
  }))
);
const visibleTasks = computed(() => visibleGroups.value.flatMap((group) => group.tasks));
const visibleTaskCount = computed(() => visibleTasks.value.length);
const modalTask = computed(() =>
  visibleTasks.value.find((task) => task.id === localSelectedTaskId.value)
  || props.tasks.find((task) => task.id === localSelectedTaskId.value)
  || null
);
const modalTaskActions = computed(() => modalTask.value ? actionsFor(modalTask.value) : []);
const draggedTask = computed(() =>
  visibleTasks.value.find((task) => task.id === draggedTaskId.value)
  || props.tasks.find((task) => task.id === draggedTaskId.value)
  || null
);
const canCreateTask = computed(() =>
  Boolean(createTaskTitle.value.trim() || createTaskDescription.value.trim())
);

watch(() => props.selectedTaskId || null, (taskId) => {
  localSelectedTaskId.value = taskId;
});

function openTaskModal(taskId: string): void {
  localSelectedTaskId.value = taskId;
  emit("update:selected-task-id", taskId);
}

function closeTaskModal(): void {
  localSelectedTaskId.value = null;
  emit("update:selected-task-id", null);
}

function openCreateTaskModal(): void {
  closeTaskModal();
  isCreateTaskModalOpen.value = true;
  void nextTick(() => createTaskDescriptionField.value?.focus());
}

function closeCreateTaskModal(): void {
  if (busyAction.value !== null) return;
  isCreateTaskModalOpen.value = false;
  resetCreateTaskForm();
}

function resetCreateTaskForm(): void {
  createTaskTitle.value = "";
  createTaskDescription.value = "";
}

async function submitCreateTask(): Promise<void> {
  if (!canCreateTask.value) return;
  const description = createTaskDescription.value.trim();
  const created = await addTask({
    title: deriveTaskTitle(createTaskTitle.value, description),
    description: description || null,
  });
  if (!created) return;
  isCreateTaskModalOpen.value = false;
  resetCreateTaskForm();
}

function deriveTaskTitle(title: string, description: string): string {
  const explicitTitle = title.trim();
  if (explicitTitle) return explicitTitle;
  const firstLine = description
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "Untitled task";
  return firstLine.length > 96 ? `${firstLine.slice(0, 93).trimEnd()}...` : firstLine;
}

function assignModalReview(): void {
  if (!modalTask.value) return;
  void assignReview(modalTask.value);
}

function runModalTaskAction(action: Parameters<typeof runTaskAction>[1]): void {
  if (!modalTask.value) return;
  void runTaskAction(modalTask.value, action);
}

function setModalReviewer(value: string): void {
  if (!modalTask.value) return;
  setSelectedReviewer(modalTask.value.id, value);
}

function onTaskDragStart(taskId: string): void {
  draggedTaskId.value = taskId;
  closeTaskModal();
}

function onTaskDragEnd(): void {
  draggedTaskId.value = null;
  dragOverStatus.value = null;
}

function onColumnDragOver(event: DragEvent, status: string): void {
  if (!canDropOnStatus(status)) {
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  dragOverStatus.value = status;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onColumnDragLeave(status: string): void {
  if (dragOverStatus.value === status) dragOverStatus.value = null;
}

function onColumnDrop(status: string): void {
  const task = draggedTask.value;
  const action = task ? dropActionFor(task, status) : null;
  onTaskDragEnd();
  if (!task || !action) return;
  void runTaskAction(task, action);
}

function canDragTask(task: DesktopTaskSummary): boolean {
  return actionsFor(task).some((action) => Boolean(action.targetStatus));
}

function canDropOnStatus(status: string): boolean {
  const task = draggedTask.value;
  return Boolean(task && dropActionFor(task, status));
}

function dropActionFor(task: DesktopTaskSummary, status: string): TaskAction | null {
  if (task.status === status) return null;
  return actionsFor(task).find((action) => action.targetStatus === status) || null;
}

function clearFilters(): void {
  searchQuery.value = "";
  activeFilter.value = "open";
  closeTaskModal();
}

function setActiveFilter(filter: string): void {
  activeFilter.value = filter as BoardFilter;
}

function filterCount(filter: BoardFilter): number {
  return props.tasks.filter((task) => taskMatchesFilter(task, filter)).length;
}

function taskMatchesActiveView(task: DesktopTaskSummary): boolean {
  return taskMatchesFilter(task, activeFilter.value) && taskMatchesSearch(task);
}

function taskMatchesFilter(task: DesktopTaskSummary, filter: BoardFilter): boolean {
  if (filter === "mine") return taskMatchesLocalWorker(task);
  if (filter === "unclaimed") return taskIsUnclaimed(task);
  if (filter === "needs-review") return taskNeedsReview(task);
  if (filter === "closed") return CLOSED_BOARD_STATUSES.includes(task.status);
  return !["done", "cancelled"].includes(task.status);
}

function taskMatchesSearch(task: DesktopTaskSummary): boolean {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    task.id,
    task.title,
    task.description || "",
    task.status,
    task.assignee || "",
    task.assigneeAgentKey || "",
    task.createdBy || "",
    ...task.workflowRefs.map((ref) => `${ref.provider} ${ref.kind} ${ref.label}`),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function taskMatchesLocalWorker(task: DesktopTaskSummary): boolean {
  const worker = localWorker.value;
  if (!worker) return false;
  const workerActors = [
    worker.agentKey,
    worker.agentSessionId,
    worker.actorLabel,
    worker.detail,
  ].map(normalizeActor).filter(Boolean);
  const taskActors = [
    task.assigneeAgentKey,
    task.assignee,
    ...task.activeLeases.flatMap((lease) => [lease.agentKey, lease.agentSessionId, lease.holderLabel]),
  ].map(normalizeActor).filter(Boolean);
  return taskActors.some((actor) => workerActors.includes(actor));
}

function taskIsUnclaimed(task: DesktopTaskSummary): boolean {
  return ["proposed", "accepted"].includes(task.status) && !task.assignee && !workLease(task);
}

function taskNeedsReview(task: DesktopTaskSummary): boolean {
  return task.status === "in_review" || (shouldShowReviewPanel(task) && reviewLeases(task).length === 0);
}
</script>
