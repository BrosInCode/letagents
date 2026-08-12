<template>
  <div class="desktop-board-kanban-scroll" tabindex="0" aria-label="Task lifecycle board">
    <div class="desktop-task-board" :data-filter="activeFilter">
      <section
        v-for="group in groups"
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
          @click="emit('toggle-group', group.status)"
        >
          <span class="desktop-task-column-title">
            <svg class="desktop-task-column-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="m5.5 6.5 2.5 2.5 2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
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
            :selected="selectedTaskId === task.id"
            @drag-start="onTaskDragStart"
            @drag-end="onTaskDragEnd"
            @select="emit('select', task.id)"
            @run-action="(action) => emit('run-action', task, action)"
          />
          <div
            v-if="group.tasks.length === 0 && draggedTaskId !== null"
            class="desktop-task-column-empty"
          >
            {{ canDropOnStatus(group.status) ? "Drop task here" : "No valid transition" }}
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesktopTaskSummary } from "../../../../../../electron/ipc-types";
import RoomBoardTaskCard from "./RoomBoardTaskCard.vue";
import type { TaskAction, TaskGroup } from "./types";

const props = defineProps<{
  groups: TaskGroup[];
  activeFilter: string;
  selectedTaskId: string | null;
  busyAction: string | null;
  collapsedGroups: Set<string>;
  actionsFor: (task: DesktopTaskSummary) => TaskAction[];
}>();

const emit = defineEmits<{
  select: [taskId: string];
  "run-action": [task: DesktopTaskSummary, action: TaskAction];
  "drag-start": [taskId: string];
  "toggle-group": [status: string];
}>();

const draggedTaskId = ref<string | null>(null);
const dragOverStatus = ref<string | null>(null);
const visibleTasks = computed(() => props.groups.flatMap((group) => group.tasks));
const draggedTask = computed(() =>
  visibleTasks.value.find((task) => task.id === draggedTaskId.value) || null
);

function onTaskDragStart(taskId: string): void {
  draggedTaskId.value = taskId;
  emit("drag-start", taskId);
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
  if (task && action) emit("run-action", task, action);
}

function canDragTask(task: DesktopTaskSummary): boolean {
  return props.busyAction === null
    && props.actionsFor(task).some((action) => Boolean(action.targetStatus));
}

function canDropOnStatus(status: string): boolean {
  return props.busyAction === null
    && Boolean(draggedTask.value && dropActionFor(draggedTask.value, status));
}

function dropActionFor(task: DesktopTaskSummary, status: string): TaskAction | null {
  if (task.status === status) return null;
  return props.actionsFor(task).find((action) => action.targetStatus === status) || null;
}
</script>
