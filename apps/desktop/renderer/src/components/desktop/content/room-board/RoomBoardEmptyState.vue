<template>
  <div
    class="desktop-task-empty desktop-board-empty-state"
    :data-variant="state.variant"
    :data-testid="state.testId"
  >
    <div class="desktop-board-empty-copy">
      <h3>{{ state.title }}</h3>
      <p>{{ state.description }}</p>
    </div>
    <button
      type="button"
      :class="actionClass"
      :disabled="state.action === 'add-task' && busy"
      @click="emit('action', state.action)"
    >
      <svg v-if="state.action === 'add-task'" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      </svg>
      {{ state.actionLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  type BoardEmptyState,
  type BoardEmptyStateAction,
} from "./board-presentation";

const props = defineProps<{
  state: BoardEmptyState;
  busy: boolean;
}>();

const emit = defineEmits<{
  action: [action: BoardEmptyStateAction];
}>();

const actionClass = computed(() => props.state.action === "add-task"
  ? "desktop-board-primary-action desktop-board-empty-action"
  : "desktop-board-clear-filter"
);
</script>
