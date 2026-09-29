<template>
  <form class="desktop-task-editor" @submit.prevent="save">
    <header><span class="desktop-task-id">{{ shortTaskId(task.id) }}</span><h3>Edit task</h3></header>
    <label class="desktop-task-create-field"><span>Title</span><input ref="titleInput" v-model="title" type="text" required :disabled="busy" /></label>
    <TaskMarkdownEditor v-model="description" :disabled="busy" />
    <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>
    <footer class="desktop-task-create-actions">
      <button type="button" class="desktop-task-detail-button" :disabled="busy" @click="emit('cancel')">Cancel edits</button>
      <button type="submit" class="desktop-board-primary-action" :disabled="busy || !title.trim() || !dirty">{{ busy ? 'Saving...' : 'Save changes' }}</button>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DesktopTaskSummary } from '../../../../../../electron/ipc-types';
import { shortTaskId } from './formatters';
import TaskMarkdownEditor from './TaskMarkdownEditor.vue';
import { taskContentPatch, type TaskContentPatch } from '../../../../../../../../shared/task-markdown-editing.mjs';
const props = defineProps<{ task: DesktopTaskSummary; busy: boolean; error: string | null }>();
const emit = defineEmits<{ save: [input: TaskContentPatch]; cancel: []; dirty: [value: boolean] }>();
const title = ref(props.task.title);
const description = ref(props.task.description || '');
const originalTitle = props.task.title;
const originalDescription = props.task.description || '';
const titleInput = ref<HTMLInputElement | null>(null);
const dirty = computed(() => title.value.trim() !== originalTitle || description.value !== originalDescription);
watch(dirty, value => emit('dirty', value));
onMounted(() => titleInput.value?.focus());
function save() {
  if (!props.busy && title.value.trim() && dirty.value) emit('save', taskContentPatch(
    { title: originalTitle, description: originalDescription },
    { title: title.value.trim(), description: description.value },
  ));
}
</script>

<style scoped>
.desktop-task-editor { display: grid; gap: 24px; min-width: 0; }
.desktop-task-editor header { padding-right: 48px; }
.desktop-task-editor h3 { margin: 10px 0 0; font-size: 18px; line-height: 1.4; letter-spacing: 0; }
</style>
