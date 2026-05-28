<template>
  <section class="room-tab-page desktop-board-panel" data-testid="room-board-view">
    <form class="desktop-board-add-form" @submit.prevent="addTask">
      <input
        v-model="newTaskTitle"
        class="desktop-board-add-input"
        type="text"
        placeholder="New task title..."
        :disabled="busyAction !== null"
      />
      <button
        class="desktop-board-add-button"
        type="submit"
        :disabled="!newTaskTitle.trim() || busyAction !== null"
      >
        Add
      </button>
    </form>

    <p v-if="errorMessage" class="desktop-board-error" role="alert">{{ errorMessage }}</p>

    <div v-if="groupedTasks.length === 0" class="desktop-board-empty" data-testid="room-board-empty">
      <div>
        <h3>No tasks yet</h3>
        <p>Add a task or use the <code>add_task</code> MCP tool.</p>
      </div>
    </div>

    <section
      v-for="group in groupedTasks"
      v-else
      :key="group.status"
      class="desktop-board-group"
      :data-status="group.status"
      :data-testid="`room-board-group-${group.status}`"
    >
      <button
        class="desktop-board-group-title"
        type="button"
        :aria-expanded="!collapsedGroups.has(group.status)"
        @click="toggleGroup(group.status)"
      >
        <span class="desktop-board-group-chevron" :data-collapsed="collapsedGroups.has(group.status)">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
        <span>{{ group.label }}</span>
        <span class="desktop-board-group-count">{{ group.tasks.length }}</span>
      </button>

      <div v-if="!collapsedGroups.has(group.status)" class="desktop-board-group-list">
        <RoomBoardTaskCard
          v-for="task in group.tasks"
          :key="task.id"
          :task="task"
          :actions="actionsFor(task)"
          :busy-action="busyAction"
          :review-assignment-candidates="reviewAssignmentCandidates(task)"
          :selected-reviewer="selectedReviewerByTask[task.id] || ''"
          @assign-review="assignReview(task)"
          @run-action="(action) => runTaskAction(task, action)"
          @update:selected-reviewer="(value) => setSelectedReviewer(task.id, value)"
        />
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import type { DesktopAgentPresence, DesktopTaskSummary, WorkerSnapshot } from "../../../../../electron/ipc-types";
import RoomBoardTaskCard from "./room-board/RoomBoardTaskCard.vue";
import { useRoomBoardController } from "./room-board/useRoomBoardController";

const props = defineProps<{
  roomIdentifier: string;
  tasks: DesktopTaskSummary[];
  presence: DesktopAgentPresence[];
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [];
}>();

const {
  actionsFor,
  addTask,
  assignReview,
  busyAction,
  collapsedGroups,
  errorMessage,
  groupedTasks,
  newTaskTitle,
  reviewAssignmentCandidates,
  runTaskAction,
  selectedReviewerByTask,
  setSelectedReviewer,
  toggleGroup,
} = useRoomBoardController(props, emit);
</script>
