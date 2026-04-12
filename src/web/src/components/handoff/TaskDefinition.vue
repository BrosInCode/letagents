<script setup lang="ts">
import { ref } from 'vue';

const title = ref('');
const acceptanceCriteria = ref('');

const emit = defineEmits<{
  (e: 'update:task', payload: { title: string, ac: string }): void
}>();

function updateState() {
  emit('update:task', { title: title.value, ac: acceptanceCriteria.value });
}
</script>

<template>
  <div class="task-def-container">
    <h3>Task Definition</h3>
    <div class="form-group">
      <label for="title">Title (Intent)</label>
      <input id="title" v-model="title" type="text" placeholder="What should the agent do?" @input="updateState" />
    </div>

    <div class="form-group">
      <label for="ac">Acceptance Criteria (Bounds)</label>
      <textarea id="ac" v-model="acceptanceCriteria" rows="4" placeholder="How do we know it is done? What is explicitly out of scope?" @input="updateState"></textarea>
    </div>
  </div>
</template>

<style scoped>
.task-def-container {
  padding: 1rem;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
}
</style>
