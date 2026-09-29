<template>
  <dialog ref="dialog" class="task-dialog" :aria-labelledby="titleId" @cancel.prevent="requestClose" @click="onBackdropClick" @keydown="trapFocus">
    <div class="task-dialog-content">
      <header class="task-dialog-header">
        <div class="task-dialog-heading">
          <div class="task-dialog-meta">
            <span class="task-dialog-id">{{ formatTaskShortId(task.id) }}</span>
            <span :style="{ color: taskStatusAccent(task.status) }">{{ taskStatusLabel(task.status) }}</span>
            <button v-if="canManageLeases && saveContent && !editing" type="button" class="task-dialog-edit" :disabled="busy" @click="startEditing">Edit task</button>
          </div>
          <h2 :id="titleId">{{ task.title }}</h2>
        </div>
        <button type="button" class="task-dialog-close" title="Close task" aria-label="Close task" :disabled="busy" autofocus @click="requestClose">
          <CloseIcon :size="18" aria-hidden="true" />
        </button>
      </header>
      <p v-if="error" class="task-dialog-error" role="alert">{{ error }}</p>
      <section v-if="confirmDiscard" class="task-dialog-discard" role="alert">
        <p>Discard unsaved changes?</p>
        <div><button type="button" :disabled="busy" @click="confirmDiscard = false">Keep editing</button><button type="button" class="cancel" :disabled="busy" @click="discard">Discard changes</button></div>
      </section>

      <form v-if="editing" id="task-content-form" class="task-dialog-edit-form" @submit.prevent="save">
        <label class="task-title-field"><span>Title</span><input ref="titleInput" v-model="draftTitle" type="text" required :disabled="busy" /></label>
        <TaskMarkdownEditor v-model="draftDescription" :disabled="busy" />
      </form>
      <div v-else class="task-dialog-body">
        <section class="task-dialog-description">
          <h3>Description</h3>
          <div class="task-markdown-preview" v-html="renderMessageContent(task.description || 'No description yet.')"></div>
        </section>
        <dl class="task-dialog-properties">
          <div><dt>Owner</dt><dd>{{ formatActorName(task.assignee) || 'Unassigned' }}</dd></div>
          <div><dt>Created by</dt><dd>{{ formatActorName(task.created_by) || 'Unknown' }}</dd></div>
          <div><dt>Created</dt><dd :title="task.created_at">{{ formatTimestamp(task.created_at) }}</dd></div>
          <div><dt>Updated</dt><dd :title="task.updated_at">{{ formatTimestamp(task.updated_at) }}</dd></div>
        </dl>

        <div class="task-dialog-sections">
          <TaskLeaseAuthority
            v-if="shouldShowAuthority(task)" :task="task" :presence="presence"
            :canManageLeases="canManageLeases" :updating="busy"
            @leaseAction="emit('leaseAction', $event)"
          />
          <TaskReviewAuthority
            v-if="shouldShowReviewAuthority(task)" :task="task" :presence="presence"
            :canManageReviewLeases="canManageLeases" :updating="busy"
            @reviewLeaseAction="emit('reviewLeaseAction', $event)"
          />
          <section v-if="secondaryLeases.length || task.active_locks?.length" class="task-dialog-section">
            <h3>Coordination</h3>
            <p v-for="lease in secondaryLeases" :key="lease.id">{{ lease.kind }}: {{ formatActorName(lease.actor_label) }}</p>
            <p v-for="lock in task.active_locks" :key="lock.id">{{ lock.scope }} lock: {{ lock.reason || 'Locked' }}<template v-if="lock.message">. {{ lock.message }}</template></p>
          </section>
          <section v-if="workflowRefs.length" class="task-dialog-section">
            <h3>Linked work</h3>
            <div class="task-dialog-links">
              <a v-for="ref in workflowRefs" :key="ref.url" :href="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.label }}</a>
            </div>
          </section>
          <TaskMergeReadiness v-if="githubStatus" :status="githubStatus" :task="task" />
        </div>
      </div>

      <footer v-if="editing" class="task-dialog-footer">
        <button type="button" :disabled="busy" @click="finishEditing">Cancel edits</button>
        <button type="submit" form="task-content-form" class="task-dialog-primary" :disabled="busy || !draftTitle.trim() || !dirty">{{ busy ? 'Saving...' : 'Save changes' }}</button>
      </footer>
      <footer v-else-if="taskActions.length || canFocusTask(task)" class="task-dialog-footer">
        <div class="task-dialog-secondary">
          <button v-if="canFocusTask(task)" type="button" :disabled="busy" @click="emit('focusTask', task.id)">Focus on this</button>
          <button v-for="action in secondaryActions" :key="action.status" type="button" :class="action.cls" :disabled="busy" @click="emit('updateStatus', task.id, action.status)">{{ updating ? 'Updating...' : action.label }}</button>
        </div>
        <button v-if="primaryAction" type="button" class="task-dialog-primary" :disabled="busy" @click="emit('updateStatus', task.id, primaryAction.status)">{{ updating ? 'Updating...' : primaryAction.label }}</button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import { taskContentPatch, type TaskContentPatch } from '../../../../../../shared/task-markdown-editing.mjs'
import type { RoomAgentPresence, RoomTask, TaskGitHubArtifactStatus } from '@/composables/useRoom'
import CloseIcon from '@/components/icons/CloseIcon.vue'
import { taskStatusAccent, taskStatusLabel } from '@/domain/taskStatus'
import TaskLeaseAuthority from '../task-lease-authority/TaskLeaseAuthority.vue'
import TaskReviewAuthority from '../task-review-authority/TaskReviewAuthority.vue'
import TaskMergeReadiness from '../TaskMergeReadiness.vue'
import TaskMarkdownEditor from './TaskMarkdownEditor.vue'
import { renderMessageContent } from '../chat-message/formatting'
import {
  canFocusTask, formatActorName, formatTaskShortId, formatTimestamp,
  getSecondaryLeases, getTaskActions, getTaskWorkflowRefs,
  shouldShowAuthority, shouldShowReviewAuthority,
  type TaskLeaseActionPayload, type TaskReviewLeaseActionPayload,
} from './model'

const props = defineProps<{
  task: RoomTask
  presence: readonly RoomAgentPresence[]
  canManageLeases: boolean
  updating: boolean
  updatingLease: boolean
  updatingReviewLease: boolean
  locked?: boolean
  githubStatus: TaskGitHubArtifactStatus | null
  error?: string
  saveContent?: (input: TaskContentPatch) => Promise<boolean>
}>()
const emit = defineEmits<{
  close: []
  updateStatus: [taskId: string, status: string]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const editing = ref(false)
const draftTitle = ref('')
const draftDescription = ref('')
const initialContent = ref({ title: '', description: '' })
const titleInput = ref<HTMLInputElement | null>(null)
const confirmDiscard = ref(false)
const dirty = computed(() => draftTitle.value.trim() !== initialContent.value.title || draftDescription.value !== initialContent.value.description)
async function startEditing() {
  initialContent.value = { title: props.task.title, description: props.task.description || '' }
  draftTitle.value = initialContent.value.title
  draftDescription.value = initialContent.value.description
  editing.value = true
  await nextTick()
  titleInput.value?.focus()
}
async function save() {
  if (busy.value || !draftTitle.value.trim() || !dirty.value || !props.saveContent) return
  if (await props.saveContent(taskContentPatch(initialContent.value, { title: draftTitle.value.trim(), description: draftDescription.value }))) await finishEditing()
}
async function finishEditing() {
  if (busy.value) return
  editing.value = false
  confirmDiscard.value = false
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>('.task-dialog-edit')?.focus()
}
function discard() {
  if (!busy.value) emit('close')
}
const titleId = `task-dialog-${useId()}`
const busy = computed(() => props.locked || props.updating || props.updatingLease || props.updatingReviewLease)
const taskActions = computed(() => getTaskActions(props.task))
const primaryAction = computed(() => taskActions.value.find(action => action.cls !== 'cancel'))
const secondaryActions = computed(() => taskActions.value.filter(action => action !== primaryAction.value))
const secondaryLeases = computed(() => getSecondaryLeases(props.task))
const workflowRefs = computed(() => getTaskWorkflowRefs(props.task))
let previousBodyOverflow = ''
onMounted(() => {
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  document.body.style.overflow = previousBodyOverflow
})
function requestClose() {
  if (busy.value) return
  if (editing.value && dirty.value) confirmDiscard.value = true
  else emit('close')
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const elements = Array.from(dialog.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]',
  ) ?? []).filter(element => element.getClientRects().length > 0)
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
function onBackdropClick(event: MouseEvent) {
  if (!dialog.value || event.target !== dialog.value) return
  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) requestClose()
}
</script>

<style scoped>
.task-dialog {
  width: min(800px, calc(100vw - 32px));
  max-height: calc(100dvh - 48px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 24px 80px rgb(0 0 0 / 30%);
  overflow: auto;
}
.task-dialog::backdrop { background: rgb(0 0 0 / 60%); }
.task-dialog-error { padding: 12px; border: 1px solid var(--red-text); border-radius: 6px; color: var(--red-text); background: var(--red-dim); }
.task-dialog-content { padding: 28px; display: grid; gap: 28px; }
.task-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.task-dialog-heading { min-width: 0; flex: 1; }
.task-dialog .task-dialog-edit { flex: 0 0 auto; min-height: 28px; padding: 0 8px; background: transparent; color: var(--text-secondary); font-size: 12px; }
.task-dialog-edit-form { display: grid; gap: 20px; min-width: 0; }
.task-title-field { display: grid; gap: 8px; color: var(--text-secondary); font-size: 12px; }
.task-title-field input { width: 100%; min-height: 40px; padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-subtle); color: var(--text); font: inherit; font-size: 14px; }
.task-dialog-discard { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-subtle); }
.task-dialog-discard > div { display: flex; flex-wrap: wrap; gap: 8px; }
.task-dialog-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; color: var(--text-secondary); font-size: 0.75rem; }
.task-dialog-id { font-family: var(--font-mono); overflow-wrap: anywhere; }
.task-dialog h2 { margin: 0; font-size: 1.125rem; line-height: 1.5; font-weight: 600; letter-spacing: 0; overflow-wrap: anywhere; }
.task-dialog button { min-height: 36px; padding: 0 12px; background: var(--bg-subtle); color: var(--text); border: 1px solid var(--border); border-radius: 6px; font: inherit; font-size: 0.8125rem; cursor: pointer; }
.task-dialog button:disabled { opacity: 0.45; cursor: default; }
.task-dialog .task-dialog-close { display: grid; place-items: center; flex: 0 0 36px; width: 36px; padding: 0; }
.task-dialog-body { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 28px; min-width: 0; }
.task-dialog h3 { margin: 0 0 12px; color: var(--text-secondary); font-size: 0.75rem; font-weight: 550; letter-spacing: 0; }
.task-dialog p { margin: 0; font-size: 0.875rem; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
.task-dialog-properties { display: grid; align-content: start; gap: 18px; margin: 0; border-left: 1px solid var(--border); padding-left: 24px; }
.task-dialog dt { color: var(--text-secondary); font-size: 0.75rem; margin-bottom: 6px; }
.task-dialog dd { margin: 0; font-size: 0.8125rem; overflow-wrap: anywhere; }
.task-dialog-sections { grid-column: 1 / -1; display: grid; gap: 24px; min-width: 0; }
.task-dialog-sections:empty { display: none; }
.task-dialog-section, .task-dialog-sections :deep(.lease-authority), .task-dialog-sections :deep(.review-authority), .task-dialog-sections :deep(.task-merge-readiness) { padding: 24px 0 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; background: transparent; min-width: 0; }
.task-dialog-sections :deep(.lease-authority__tile), .task-dialog-sections :deep(.review-authority__tile), .task-dialog-sections :deep(.merge-readiness-signal) { padding: 0; border: 0; border-radius: 0; background: transparent; }
.task-dialog-links { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.task-dialog-links a { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; color: var(--blue); font-size: 0.8125rem; overflow-wrap: anywhere; }
.task-dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 24px; border-top: 1px solid var(--border); padding-top: 20px; }
.task-dialog-secondary { display: flex; align-items: center; gap: 24px; min-width: 0; }
.task-dialog-secondary button { padding-inline: 0; border-color: transparent; background: transparent; color: var(--text-secondary); }
.task-dialog-secondary button.cancel { color: var(--red-text); }
.task-dialog .task-dialog-primary { flex: 0 0 auto; min-width: 104px; color: var(--blue); background: var(--blue-dim); border-color: color-mix(in srgb, var(--blue) 35%, var(--border)); font-weight: 600; }
.task-dialog :is(button, a, input, select, textarea):focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
@media (hover: hover) and (pointer: fine) { .task-dialog button:hover:not(:disabled) { background: var(--accent-hover); } }
@media (max-width: 600px) {
  .task-dialog { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
  .task-dialog-content { padding: 20px; gap: 24px; }
  .task-dialog-header { gap: 16px; }
  .task-dialog-body { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .task-dialog-properties { grid-template-columns: repeat(2, minmax(0, 1fr)); border-left: 0; padding: 20px 0 0; border-top: 1px solid var(--border); }
  .task-dialog button, .task-dialog-links a { min-height: 44px; }
  .task-dialog .task-dialog-close { flex-basis: 44px; width: 44px; }
  .task-dialog-footer { flex-direction: column; align-items: stretch; gap: 12px; padding-top: 16px; }
  .task-dialog-secondary { justify-content: space-between; gap: 12px; }
  .task-dialog-secondary button { min-width: 0; text-align: left; }
  .task-dialog-secondary button.cancel { text-align: right; }
}
</style>
