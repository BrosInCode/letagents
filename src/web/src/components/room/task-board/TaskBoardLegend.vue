<template>
  <section class="task-board-legend" aria-labelledby="task-board-legend-title">
    <span id="task-board-legend-title" class="task-board-legend-label">Lifecycle</span>
    <ul class="task-board-legend-items" aria-label="Task status legend">
      <li v-for="status in TASK_STATUS_ORDER" :key="status">
        <span class="task-board-legend-item" :style="{ '--task-accent': taskStatusAccent(status) }">
          <i aria-hidden="true"></i>
          {{ taskStatusLabel(status) }}
        </span>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { TASK_STATUS_ORDER, taskStatusAccent, taskStatusLabel } from '../../../domain/taskStatus'
</script>

<style scoped>
.task-board-legend {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  color: var(--text-secondary);
}

.task-board-legend-label {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 0.66rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.task-board-legend-items {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-board-legend-item {
  --task-accent: var(--text-tertiary);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 0.68rem;
  font-weight: 550;
  line-height: 1.4;
  white-space: nowrap;
}

.task-board-legend-item i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--task-accent);
}

@media (max-width: 640px) {
  .task-board-legend {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
  }
}
</style>
