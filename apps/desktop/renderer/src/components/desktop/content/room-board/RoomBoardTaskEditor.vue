<template>
  <form class="desktop-task-editor" @submit.prevent="save">
    <div class="desktop-task-editor-fields"><header><h3>Edit task</h3></header>
    <label class="desktop-task-create-field"><span>Title</span><input ref="titleInput" v-model="title" type="text" required :disabled="busy" /></label>
    <TaskMarkdownEditor v-model="description" :disabled="busy" />
    <label v-if="ticketKeys" class="desktop-task-create-field">
      <span>Ticket key (optional)</span>
      <input v-model="externalRef" type="text" placeholder="jira:HT-1234" spellcheck="false" autocomplete="off" :disabled="busy" :aria-invalid="externalRefInvalid" />
      <small v-if="externalRefInvalid" class="desktop-task-dialog-error">Use a key such as HT-1234, linear:ENG-12 or github:owner/repo#12.</small>
    </label>
    <p v-if="error" class="desktop-task-dialog-error" role="alert">{{ error }}</p>
    </div>
    <footer class="desktop-task-create-actions">
      <button type="button" class="desktop-task-detail-button" :disabled="busy" @click="emit('cancel')">Cancel edits</button>
      <button type="submit" class="desktop-board-primary-action" :disabled="busy || !title.trim() || !dirty || externalRefInvalid">{{ busy ? 'Saving...' : 'Save changes' }}</button>
    </footer>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DesktopTaskSummary } from '../../../../../../electron/ipc-types';
import TaskMarkdownEditor from './TaskMarkdownEditor.vue';
import { taskContentPatch } from '../../../../../../../../shared/task-markdown-editing.mjs';
import { normalizedExternalRef, type TaskEditPatch } from './ticket-ref';
const props = defineProps<{ task: DesktopTaskSummary; busy: boolean; error: string | null; ticketKeys?: boolean }>();
const emit = defineEmits<{ save: [input: TaskEditPatch]; cancel: []; dirty: [value: boolean] }>();
const title = ref(props.task.title);
const description = ref(props.task.description || '');
const externalRef = ref(props.task.externalRef || '');
const originalTitle = props.task.title;
const originalDescription = props.task.description || '';
const originalExternalRef = props.task.externalRef || null;
const titleInput = ref<HTMLInputElement | null>(null);
const nextExternalRef = computed(() => normalizedExternalRef(externalRef.value));
const externalRefInvalid = computed(() => nextExternalRef.value === undefined);
const contentDirty = computed(() => title.value.trim() !== originalTitle || description.value !== originalDescription);
const externalRefDirty = computed(() => nextExternalRef.value !== undefined && nextExternalRef.value !== originalExternalRef);
const dirty = computed(() => contentDirty.value || externalRef.value.trim() !== (originalExternalRef || ''));
watch(dirty, value => emit('dirty', value));
onMounted(() => titleInput.value?.focus());
function save() {
  if (props.busy || !title.value.trim() || !dirty.value || externalRefInvalid.value) return;
  const patch: TaskEditPatch = contentDirty.value
    ? taskContentPatch(
      { title: originalTitle, description: originalDescription },
      { title: title.value.trim(), description: description.value },
    )
    : {};
  if (externalRefDirty.value) patch.external_ref = nextExternalRef.value ?? null;
  if (patch.expected_content === undefined && patch.external_ref === undefined) {
    emit('cancel');
    return;
  }
  emit('save', patch);
}
</script>

<style scoped>
.desktop-task-editor { display:flex; flex-direction:column; min-width:0; min-height:0; flex:1; }
.desktop-task-editor-fields { display:grid; align-content:start; gap:24px; padding:26px 32px 32px; min-height:0; overflow:auto; flex:1; overscroll-behavior:contain; }
.desktop-task-editor h3 { margin:0; font-size:24px; font-weight:600; line-height:1.4; letter-spacing:-.4px; }
.desktop-task-create-actions { padding:16px 24px; border-top:1px solid var(--border); flex-shrink:0; }
@media(max-width:600px) { .desktop-task-editor-fields { padding:24px 20px; } }
</style>
