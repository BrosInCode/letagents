<template>
  <section v-if="alwaysShow || tasks.length > 0" class="activity-detail-section">
    <div class="activity-detail-section-header">
      <h4>{{ title }}</h4>
      <span>{{ tasks.length }}</span>
    </div>

    <div v-if="tasks.length === 0" class="activity-detail-empty">
      {{ emptyMessage }}
    </div>

    <div v-else class="activity-task-list">
      <article
        v-for="task in tasks"
        :key="task.id"
        class="activity-task-card"
      >
        <div class="activity-task-copy">
          <strong>{{ task.title }}</strong>
          <span>{{ statusLabels[task.status] || task.status }}</span>
        </div>
        <a
          v-if="getTaskLink(task)"
          class="activity-task-link"
          :href="getTaskLink(task)!.url"
          target="_blank"
        >
          {{ getTaskLink(task)!.label }}
        </a>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ActivityTaskListItem } from './types'

defineProps<{
  title: string
  tasks: readonly ActivityTaskListItem[]
  emptyMessage: string
  statusLabels: Record<string, string>
  getTaskLink: (
    task: ActivityTaskListItem,
  ) => { label: string; url: string } | null
  alwaysShow?: boolean
}>()
</script>

<style scoped>
.activity-detail-section {
  display: grid;
  gap: 10px;
}

.activity-detail-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.activity-detail-section-header h4 {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--activity-text-tertiary);
}

.activity-detail-section-header span {
  font-size: 0.74rem;
  color: var(--activity-text-tertiary);
}

.activity-detail-empty {
  padding: 12px;
  border-radius: 8px;
  border: 1px dashed var(--activity-border-strong);
  color: var(--activity-text-tertiary);
  font-size: 0.8rem;
}

.activity-task-list {
  display: grid;
  gap: var(--space-sm, 8px);
}

.activity-task-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
}

.activity-task-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.activity-task-copy strong {
  font-size: 0.82rem;
  color: var(--text, #fafafa);
}

.activity-task-copy span {
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-task-link {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--activity-blue);
  text-decoration: none;
}

.activity-task-link:hover {
  text-decoration: underline;
}

@media (max-width: 760px) {
  .activity-detail-section-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
