<template>
  <section class="room-tab-page" data-testid="room-board-view">
    <RoomBoardSummary :tasks="tasks" />

    <div class="desktop-task-board" data-testid="room-board-tasks">
      <section
        v-for="column in columns"
        :key="column.id"
        class="desktop-task-column"
        :data-testid="`room-board-column-${column.id}`"
      >
        <header class="desktop-task-column-header">
          <div>
            <p class="sidebar-label">{{ column.label }}</p>
            <span>{{ column.description }}</span>
          </div>
          <strong>{{ column.tasks.length }}</strong>
        </header>

        <article
          v-for="task in column.tasks"
          :key="task.id"
          class="desktop-task-card"
          :data-status="task.status"
          :data-testid="`room-board-task-${task.id}`"
        >
          <div class="desktop-task-card-header">
            <span class="state-pill">{{ readableStatus(task.status) }}</span>
            <code>{{ task.id }}</code>
          </div>
          <h4>{{ task.title }}</h4>
          <div class="desktop-task-meta-grid">
            <span>
              <small>Owner</small>
              <strong>{{ task.assignee || "Unassigned" }}</strong>
            </span>
            <span>
              <small>Work lease</small>
              <strong>{{ workLease(task)?.holderLabel || "No active worker" }}</strong>
            </span>
            <span>
              <small>Review</small>
              <strong>{{ reviewLeases(task).length ? reviewLeases(task).map((lease) => lease.holderLabel || "Reviewer").join(", ") : "Not claimed" }}</strong>
            </span>
            <span>
              <small>Updated</small>
              <strong>{{ relativeTime(task.updatedAt) }}</strong>
            </span>
          </div>
          <a
            v-if="task.prUrl"
            class="desktop-task-pr-link"
            :href="task.prUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open pull request
          </a>
        </article>

        <article v-if="!column.tasks.length" class="desktop-task-empty">
          <p>No tasks here.</p>
        </article>
      </section>
    </div>

    <article v-if="!tasks.length" class="room-empty-card" data-testid="room-board-empty">
      <div>
        <h3>No tasks in this room yet.</h3>
        <p>When humans or agents add work, it will appear here with ownership, review, and lease context.</p>
      </div>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopTaskSummary } from "../../../../../electron/ipc-types";
import RoomBoardSummary from "./RoomBoardSummary.vue";

const props = defineProps<{
  tasks: DesktopTaskSummary[];
}>();

const columns = computed(() => [
  {
    id: "open",
    label: "Open",
    description: "Ready to claim or waiting to start.",
    tasks: props.tasks.filter((task) => ["proposed", "accepted", "assigned"].includes(task.status)),
  },
  {
    id: "moving",
    label: "Moving",
    description: "Currently owned or in active work.",
    tasks: props.tasks.filter((task) => ["in_progress", "blocked"].includes(task.status)),
  },
  {
    id: "review",
    label: "Review",
    description: "Needs review, merge, or closure.",
    tasks: props.tasks.filter((task) => ["in_review", "merged"].includes(task.status)),
  },
  {
    id: "done",
    label: "Done",
    description: "Completed or intentionally closed.",
    tasks: props.tasks.filter((task) => ["done", "cancelled"].includes(task.status)),
  },
]);

function readableStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function workLease(task: DesktopTaskSummary) {
  return task.activeLeases.find((lease) => lease.kind === "work") || null;
}

function reviewLeases(task: DesktopTaskSummary) {
  return task.activeLeases.filter((lease) => lease.kind === "review");
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 45) return "just now";
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}
</script>
