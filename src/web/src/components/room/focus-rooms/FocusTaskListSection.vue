<template>
  <div class="focus-section-card category-card">
    <div class="focus-section-header">
      <div>
        <h3>Focus candidates</h3>
        <p>Large, noisy, or multi-agent work belongs here.</p>
      </div>
      <span class="focus-badge">{{ tasks.length }}</span>
    </div>

    <div class="focus-card-list">
      <div v-if="tasks.length === 0" class="focus-empty">
        <h4>No open tasks yet</h4>
        <p>Add a task or branch a room from an idea.</p>
      </div>

      <button
        v-for="task in tasks"
        :key="task.id"
        class="focus-task"
        :data-selected="!hasSelectedFocusRoom && task.id === selectedTaskId"
        :aria-pressed="!hasSelectedFocusRoom && task.id === selectedTaskId"
        aria-controls="focus-room-detail-panel"
        type="button"
        @click="emit('select', task.id)"
      >
        <div>
          <strong>{{ task.title }}</strong>
          <span>{{ task.description || task.id }}</span>
        </div>
        <small>{{ taskStatusLabel(task.status) }}</small>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { RoomTask } from '@/composables/useRoom'
import { taskStatusLabel } from './options'

defineProps<{
  tasks: readonly RoomTask[]
  selectedTaskId: string | null
  hasSelectedFocusRoom: boolean
}>()

const emit = defineEmits<{
  select: [taskId: string]
}>()
</script>
