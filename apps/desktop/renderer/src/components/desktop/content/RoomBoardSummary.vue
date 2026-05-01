<template>
  <section class="surface-list" data-testid="room-board-summary">
    <article class="surface-row single-line">
      <div>
        <p class="surface-title">Board summary</p>
        <p class="surface-subtitle">A quick read on how work is moving in this room.</p>
      </div>
    </article>

    <div class="stats-grid compact">
      <article class="stat-card" data-testid="board-summary-open">
        <span class="stat-label">Open</span>
        <strong>{{ openCount }}</strong>
        <small>Tasks not finished yet.</small>
      </article>

      <article class="stat-card" data-testid="board-summary-review">
        <span class="stat-label">In review</span>
        <strong>{{ reviewCount }}</strong>
        <small>Waiting on review or merge.</small>
      </article>

      <article class="stat-card" data-testid="board-summary-done">
        <span class="stat-label">Done</span>
        <strong>{{ doneCount }}</strong>
        <small>Completed work already tracked.</small>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopTaskSummary } from "../../../../../electron/ipc-types";

const props = defineProps<{
  tasks: DesktopTaskSummary[];
}>();

const reviewCount = computed(() => props.tasks.filter((task) => task.status === "in_review").length);
const doneCount = computed(() => props.tasks.filter((task) => task.status === "done" || task.status === "merged").length);
const openCount = computed(() =>
  props.tasks.filter((task) => !["done", "merged", "cancelled"].includes(task.status)).length
);
</script>
