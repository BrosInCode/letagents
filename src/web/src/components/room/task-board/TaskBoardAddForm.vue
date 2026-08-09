<template>
  <div class="add-task-form">
    <input
      v-model="newTaskTitle"
      class="input"
      type="text"
      name="task-title"
      aria-label="New task title"
      placeholder="New task title"
      @keydown.enter="handleAdd"
    />
    <AppButton
      class="add-task-button"
      variant="secondary"
      size="sm"
      type="button"
      @click="handleAdd"
    >
      Add task
    </AppButton>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import AppButton from '@/components/ui/AppButton.vue'

const emit = defineEmits<{
  addTask: [title: string]
}>()

const newTaskTitle = ref('')

function handleAdd() {
  const title = newTaskTitle.value.trim()
  if (!title) return
  emit('addTask', title)
  newTaskTitle.value = ''
}
</script>

<style scoped>
.add-task-form {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 1 400px;
  min-width: min(100%, 260px);
}

.add-task-form .input {
  flex: 1;
  min-height: 36px;
  min-width: 0;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text);
  font-family: inherit;
  font-size: 0.78rem;
  outline: none;
  transition: border-color var(--duration-fast) ease, background-color var(--duration-fast) ease;
}

.add-task-form .input:focus-visible {
  border-color: var(--blue);
  background: var(--bg-elevated);
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.add-task-form .input::placeholder {
  color: var(--text-tertiary);
  opacity: 1;
}

.add-task-button {
  min-height: 36px;
  --btn-secondary-bg: var(--text);
  --btn-secondary-hover-bg: color-mix(in srgb, var(--text) 88%, var(--bg));
  --btn-secondary-border: var(--text);
  --btn-secondary-color: var(--bg);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.add-task-button:focus-visible {
  box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--blue);
}

@media (max-width: 768px) {
  .add-task-form {
    width: 100%;
    flex-basis: auto;
  }

  .add-task-form .input,
  .add-task-button {
    min-height: 44px;
  }

  .add-task-form .input {
    font-size: 0.82rem;
  }
}
</style>
