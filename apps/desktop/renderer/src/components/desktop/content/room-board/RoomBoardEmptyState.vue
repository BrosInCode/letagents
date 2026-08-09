<template>
  <div
    class="desktop-task-empty desktop-board-empty-state"
    :data-testid="state.testId"
  >
    <div>
      <h3>{{ state.title }}</h3>
      <p>{{ state.description }}</p>
    </div>
    <button
      type="button"
      :class="actionClass"
      :disabled="state.action === 'add-task' && busy"
      @click="emit('action', state.action)"
    >
      {{ state.actionLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  BoardEmptyState,
  BoardEmptyStateAction,
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
