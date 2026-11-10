<template>
  <DesktopDialogShell
    :open="Boolean(task)"
    :focus-key="task?.id"
    :aria-label="task ? `Task details for ${task.title}` : undefined"
    backdrop-class="desktop-task-modal-backdrop desktop-task-inspector-backdrop"
    panel-class="desktop-task-modal desktop-task-inspector-modal"
    :show-close="false"
    initial-focus=".task-inspector-close"
    :close-disabled="busyAction !== null"
    @close="requestClose"
  >
    <header class="task-inspector-toolbar">
      <span class="task-inspector-location">Task <span aria-hidden="true">/</span> <strong>{{ task ? ticketRefParts(task.externalRef)?.key || shortTaskId(task.id) : '' }}</strong></span>
      <button type="button" class="task-inspector-close" aria-label="Close task details" :disabled="busyAction !== null" @click="requestClose"><X :size="18" aria-hidden="true" /></button>
    </header>
    <section v-if="confirmDiscard" class="desktop-task-discard" role="alert">
      <p>Discard unsaved changes?</p>
      <div class="desktop-task-actions">
        <button type="button" class="desktop-task-detail-button" :disabled="busyAction !== null" @click="confirmDiscard = false">Keep editing</button>
        <button type="button" class="desktop-task-action" data-tone="danger" :disabled="busyAction !== null" @click="discard">Discard changes</button>
      </div>
    </section>
    <RoomBoardTaskEditor
      v-if="task && editing" :key="task.id" :task="task" :busy="busyAction !== null" :error="error" :ticket-keys="ticketKeys"
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
      :room-identifier="roomIdentifier"
      @edit="editing = true"
      @close="requestClose"
      @assign-review="emit('assign-review')"
      @run-action="emit('run-action', $event)"
      @update:selected-reviewer="emit('update:selected-reviewer', $event)"
      @view-events="emit('view-events', $event)"
      @view-artifacts="emit('view-artifacts', $event)"
      @open-thread="emit('open-thread', $event)"
    >
      <template #planning><slot name="planning" /></template>
    </RoomBoardTaskInspector>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { ticketRefParts, type TaskEditPatch } from './ticket-ref';
import { shortTaskId } from './formatters';
import { X } from '@lucide/vue';
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
  roomIdentifier?: string;
  ticketKeys?: boolean;
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
  save: [input: TaskEditPatch, onSettled: (saved: boolean) => void];
  "assign-review": [];
  "run-action": [action: TaskAction];
  "update:selected-reviewer": [value: string];
  "view-events": [taskId: string];
  "view-artifacts": [taskId: string];
  "open-thread": [threadRootId: string];
}>();
</script>

<style scoped>
.desktop-task-discard { display: grid; gap: 12px; margin: 16px 24px; flex-shrink: 0; padding: 14px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-subtle); }
.desktop-task-discard p { margin: 0; font-size: 14px; }
.task-inspector-toolbar { display:flex; align-items:center; justify-content:space-between; flex:0 0 auto; gap:16px; height:61px; padding:0 20px 0 28px; border-bottom:1px solid var(--border); }
.task-inspector-location { display:flex; align-items:center; gap:12px; color:var(--text-secondary); font-size:12px; }
.task-inspector-location strong { color:var(--text); font-weight:500; }
.task-inspector-close { display:grid; place-items:center; width:32px; height:32px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--text-secondary); cursor:pointer; }
.task-inspector-close:hover { background:var(--bg-subtle); color:var(--text); }
.task-inspector-close:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
</style>

<style>
.desktop-task-inspector-backdrop { padding:12px; }
.desktop-task-modal.desktop-task-inspector-modal { display:flex; flex-direction:column; width:min(920px,100%); height:100%; max-height:100%; padding:0; overflow:hidden; border:1px solid var(--border-strong); border-radius:16px; background:var(--bg); overscroll-behavior:contain; }
.desktop-task-inspector-backdrop.desktop-dialog-enter-active > .desktop-task-inspector-modal { transition:transform 300ms cubic-bezier(.32,.72,0,1),opacity 220ms ease; }
.desktop-task-inspector-backdrop.desktop-dialog-leave-active > .desktop-task-inspector-modal { transition:transform 180ms ease-in,opacity 150ms ease; }
.desktop-task-inspector-backdrop.desktop-dialog-enter-from > .desktop-task-inspector-modal,
.desktop-task-inspector-backdrop.desktop-dialog-leave-to > .desktop-task-inspector-modal { transform:translateX(45px); }
@media(min-width:1600px) { .desktop-task-modal.desktop-task-inspector-modal { width:960px; } }
@media(max-width:600px) { .desktop-task-inspector-backdrop { padding:0; } .desktop-task-modal.desktop-task-inspector-modal { width:100%; border:0; border-radius:0; } }
@media(prefers-reduced-motion:reduce) { .desktop-task-inspector-backdrop.desktop-dialog-enter-active > .desktop-task-inspector-modal,.desktop-task-inspector-backdrop.desktop-dialog-leave-active > .desktop-task-inspector-modal { transition:opacity 100ms ease; } .desktop-task-inspector-backdrop.desktop-dialog-enter-from > .desktop-task-inspector-modal,.desktop-task-inspector-backdrop.desktop-dialog-leave-to > .desktop-task-inspector-modal { transform:none; } }
</style>
