<template>
  <div class="add-task-form">
    <input
      v-model="newTaskTitle"
      class="input"
      type="text"
      name="task-title"
      placeholder="New task title..."
      @keydown.enter="handleAdd"
    />
    <AppButton
      class="add-task-button"
      variant="secondary"
      size="sm"
      type="button"
      @click="handleAdd"
    >
      Add
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
  margin-bottom: var(--space-lg);
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
}

.add-task-form .input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary, #ffffff);
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
  transition: border-color 150ms;
}

.add-task-form .input:focus {
  border-color: rgba(255, 255, 255, 0.2);
}

.add-task-form .input::placeholder {
  color: var(--text-tertiary, #a1a1aa);
}

.add-task-button {
  min-height: 40px;
  --btn-secondary-bg: rgba(255, 255, 255, 0.07);
  --btn-secondary-hover-bg: rgba(255, 255, 255, 0.12);
  --btn-secondary-border: rgba(255, 255, 255, 0.1);
  --btn-secondary-color: var(--text-secondary, #d4d4d8);
}

@media (max-width: 768px) {
  .add-task-form {
    flex-direction: column;
    gap: 8px;
    padding: 8px;
  }

  .add-task-button {
    width: 100%;
  }

  .add-task-form .input {
    padding: 10px;
    font-size: 0.82rem;
  }
}
</style>
