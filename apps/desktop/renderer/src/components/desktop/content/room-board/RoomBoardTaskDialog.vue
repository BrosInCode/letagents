<template>
  <DesktopDialogShell
    :open="Boolean(task)"
    :focus-key="task?.id"
    :aria-label="task ? `Task details for ${task.title}` : undefined"
    backdrop-class="desktop-task-modal-backdrop desktop-task-inspector-backdrop"
    panel-class="desktop-task-modal desktop-task-inspector-modal"
    close-label="Close task details"
    :close-disabled="busyAction !== null"
    @close="requestClose"
  >
    <section v-if="confirmDiscard" class="desktop-task-discard" role="alert">
      <p>Discard unsaved changes?</p>
      <div class="desktop-task-actions">
        <button type="button" class="desktop-task-detail-button" :disabled="busyAction !== null" @click="confirmDiscard = false">Keep editing</button>
        <button type="button" class="desktop-task-action" data-tone="danger" :disabled="busyAction !== null" @click="discard">Discard changes</button>
      </div>
    </section>
    <RoomBoardTaskEditor
      v-if="task && editing" :key="task.id" :task="task" :busy="busyAction !== null" :error="error"
      @dirty="dirty = $event" @cancel="finishEditing"
      @save="input => emit('save', input, saved => { if (saved) void finishEditing(); })"
    />
    <RoomBoardTaskInspector
      v-else-if="task"
      ref="inspector"
      :task="task"
      :actions="actions"
      :busy-action="busyAction"
      :error="error"
      :review-assignment-candidates="reviewAssignmentCandidates"
      :selected-reviewer="selectedReviewer"
      :can-edit="canEdit"
      @edit="editing = true"
      @assign-review="emit('assign-review')"
      @run-action="emit('run-action', $event)"
      @update:selected-reviewer="emit('update:selected-reviewer', $event)"
      @view-events="emit('view-events', $event)"
      @view-artifacts="emit('view-artifacts', $event)"
    />
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { TaskContentPatch } from '../../../../../../../../shared/task-markdown-editing.mjs';
import type {
  DesktopAgentPresence,
  DesktopTaskSummary,
} from "../../../../../../electron/ipc-types";
import DesktopDialogShell from "../DesktopDialogShell.vue";
import RoomBoardTaskInspector from "./RoomBoardTaskInspector.vue";
import RoomBoardTaskEditor from "./RoomBoardTaskEditor.vue";
import type { TaskAction } from "./types";

const props = defineProps<{
  task: DesktopTaskSummary | null;
  actions: TaskAction[];
  busyAction: string | null;
  error: string | null;
  reviewAssignmentCandidates: DesktopAgentPresence[];
  selectedReviewer: string;
  canEdit?: boolean;
}>();
const editing = ref(false);
const dirty = ref(false);
const confirmDiscard = ref(false);
const inspector = ref<InstanceType<typeof RoomBoardTaskInspector> | null>(null);
async function finishEditing() {
  if (props.busyAction !== null) return;
  editing.value = false;
  dirty.value = false;
  confirmDiscard.value = false;
  await nextTick();
  const panel = inspector.value?.$el as HTMLElement | undefined;
  panel?.querySelector<HTMLButtonElement>('[aria-label="Edit task"]')?.focus();
}
function discard() {
  if (props.busyAction === null) emit('close');
}
watch(() => props.task?.id, () => { editing.value = false; dirty.value = false; confirmDiscard.value = false; });
function requestClose() {
  if (props.busyAction !== null) return;
  if (editing.value && dirty.value) confirmDiscard.value = true;
  else emit('close');
}

const emit = defineEmits<{
  close: [];
  save: [input: TaskContentPatch, onSettled: (saved: boolean) => void];
  "assign-review": [];
  "run-action": [action: TaskAction];
  "update:selected-reviewer": [value: string];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
}>();
</script>

<style scoped>
.desktop-task-discard { display: grid; gap: 12px; margin-bottom: 24px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-subtle); }
.desktop-task-discard p { margin: 0; font-size: 14px; }
</style>
