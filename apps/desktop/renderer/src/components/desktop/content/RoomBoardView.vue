<template>
  <section class="room-tab-page" data-testid="room-board-view">
    <RoomBoardSummary :tasks="tasks" />

    <div class="surface-list room-task-list" data-testid="room-board-tasks">
      <article class="surface-row single-line">
        <div>
          <p class="surface-title">Tasks in this room</p>
          <p class="surface-subtitle">A compact view of what is open, moving, or waiting.</p>
        </div>
      </article>

      <article
        v-for="task in tasks"
        :key="task.id"
        class="surface-row"
        :data-testid="`room-board-task-${task.id}`"
      >
        <div>
          <p class="surface-title">{{ task.title }}</p>
          <p class="surface-subtitle">{{ task.assignee || "Unassigned" }}</p>
        </div>
        <div class="surface-meta">
          <span class="state-pill">{{ task.status }}</span>
          <code>{{ task.id }}</code>
        </div>
      </article>

      <article v-if="!tasks.length" class="surface-row single-line" data-testid="room-board-empty">
        <p class="surface-title">No tasks in this room yet.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DesktopTaskSummary } from "../../../../../electron/ipc-types";
import RoomBoardSummary from "./RoomBoardSummary.vue";

defineProps<{
  tasks: DesktopTaskSummary[];
}>();
</script>
