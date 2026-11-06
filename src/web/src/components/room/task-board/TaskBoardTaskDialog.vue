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
          <a v-if="primaryPr" class="task-dialog-pr" :href="primaryPr.url" target="_blank" rel="noopener noreferrer">{{ primaryPr.label }} <span aria-hidden="true">↗</span></a>
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
          <slot name="planning" />
        </section>
        <dl class="task-dialog-properties">
          <div><dt>Owner</dt><dd>{{ formatActorName(task.assignee) || 'Unassigned' }}</dd></div>
          <div><dt>Created by</dt><dd>{{ formatActorName(task.created_by) || 'Unknown' }}</dd></div>
          <div><dt>Created</dt><dd :title="task.created_at">{{ formatTimestamp(task.created_at) }}</dd></div>
          <div><dt>Updated</dt><dd :title="task.updated_at">{{ formatTimestamp(task.updated_at) }}</dd></div>
        </dl>

        <div class="task-dialog-sections">
          <details v-if="shouldShowAuthority(task) || shouldShowReviewAuthority(task) || secondaryLeases.length || task.active_locks?.length" class="task-agent-details">
            <summary>Agent details <span aria-hidden="true">⌄</span></summary>
            <div class="task-agent-details-content">
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
            </div>
          </details>
          <section v-if="secondaryWorkflowRefs.length" class="task-dialog-section">
            <h3>Linked work</h3>
            <div class="task-dialog-links">
              <a v-for="ref in secondaryWorkflowRefs" :key="ref.url" :href="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.label }}</a>
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
const primaryPr = computed(() => {
  const url = props.task.pr_url || props.githubStatus?.pr_url || props.task.workflow_artifacts?.find(item => item.kind === 'pull_request')?.url
  if (!url || !/^https?:\/\//i.test(url)) return null
  const number = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1]
  return { url, label: number ? `#${number}` : 'Open pull request' }
})
const secondaryWorkflowRefs = computed(() => workflowRefs.value.filter(ref => ref.url !== primaryPr.value?.url))
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
.task-dialog { position: fixed; inset: 12px 12px 12px auto; width: min(760px, calc(100vw - 24px)); height: calc(100dvh - 24px); max-width: none; max-height: none; margin: 0; padding: 0; border: 1px solid var(--border-strong); border-radius: 16px; background: var(--bg); color: var(--text); box-shadow: 0 24px 72px rgb(0 0 0 / 24%); overflow: hidden; animation: board-inspector-in 240ms cubic-bezier(.22,1,.36,1); }
.task-dialog::backdrop { background: rgb(0 0 0 / 36%); }
.task-dialog-content { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.task-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex: 0 0 auto; padding: 32px 36px 24px; }
.task-dialog-heading { min-width: 0; flex: 1; }
.task-dialog-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; color: var(--text-secondary); font-size: 12px; }
.task-dialog-id { font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.task-dialog h2 { margin: 0; font-size: 28px; line-height: 1.3; font-weight: 600; letter-spacing: -.65px; overflow-wrap: anywhere; }
.task-dialog-pr { display: inline-flex; gap: 8px; margin-top: 16px; color: var(--blue); font-size: 14px; font-weight: 550; text-decoration: none; }
.task-dialog button { min-height: 36px; padding: 0 12px; background: var(--bg-subtle); color: var(--text); border: 1px solid var(--border); border-radius: 7px; font: inherit; font-size: 13px; cursor: pointer; }
.task-dialog button:disabled { opacity: .45; cursor: default; }
.task-dialog .task-dialog-edit { min-height: 28px; padding: 0 8px; background: transparent; color: var(--text-secondary); font-size: 12px; }
.task-dialog .task-dialog-close { display: grid; place-items: center; flex: 0 0 36px; width: 36px; padding: 0; border: 0; background: transparent; color: var(--text-secondary); }
.task-dialog-body, .task-dialog-edit-form { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 0 36px 32px; }
.task-dialog-body { display: grid; align-content: start; gap: 28px; min-width: 0; }
.task-dialog h3 { margin: 0 0 12px; color: var(--text); font-size: 14px; font-weight: 550; line-height: 1.5; }
.task-dialog p { margin: 0; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; }
.task-dialog-description { min-width: 0; }
.task-dialog-description .task-markdown-preview { color: var(--text); font-size: 15px; line-height: 1.75; }
.task-dialog-description :deep(.board-plan-fields) { margin-top: 28px; }
.task-dialog-properties { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 28px; margin: 0; }
.task-dialog dt { color: var(--text-secondary); font-size: 12px; margin-bottom: 6px; }
.task-dialog dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.task-dialog-sections, .task-agent-details-content { display: grid; gap: 24px; min-width: 0; }
.task-dialog-sections:empty { display: none; }
.task-agent-details > summary { display: flex; align-items: center; justify-content: space-between; min-height: 40px; color: var(--text-secondary); font-size: 14px; list-style: none; cursor: pointer; }
.task-agent-details > summary::-webkit-details-marker { display: none; }
.task-agent-details > summary span { transition: transform 180ms ease; }
.task-agent-details[open] > summary span { transform: rotate(180deg); }
.task-agent-details-content { padding-top: 14px; }
.task-dialog-section, .task-dialog-sections :deep(.lease-authority), .task-dialog-sections :deep(.review-authority), .task-dialog-sections :deep(.task-merge-readiness) { padding: 0; border: 0; border-radius: 0; background: transparent; min-width: 0; }
.task-dialog-sections :deep(.lease-authority__tile), .task-dialog-sections :deep(.review-authority__tile), .task-dialog-sections :deep(.merge-readiness-signal) { padding: 0; border: 0; border-radius: 0; background: transparent; }
.task-dialog-links { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.task-dialog-links a { color: var(--blue); font-size: 13px; overflow-wrap: anywhere; }
.task-dialog-footer { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; gap: 16px; padding: 20px 36px; border-top: 1px solid var(--border); background: var(--bg); }
.task-dialog-secondary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; min-width: 0; }
.task-dialog-secondary button.cancel { color: var(--red-text); }
.task-dialog .task-dialog-primary { flex: 0 0 auto; min-width: 104px; color: var(--bg); background: var(--text); border-color: transparent; font-weight: 550; }
.task-dialog-error { margin: 0 36px 18px; color: var(--red-text); font-size: 13px; }
.task-dialog-edit-form { display: grid; align-content: start; gap: 24px; min-width: 0; }
.task-title-field { display: grid; gap: 10px; color: var(--text-secondary); font-size: 13px; }
.task-title-field input { width: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-subtle); color: var(--text); font: inherit; font-size: 16px; }
.task-dialog-discard { display: grid; gap: 12px; margin: 0 36px 20px; padding: 14px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-subtle); }
.task-dialog-discard > div { display: flex; flex-wrap: wrap; gap: 8px; }
.task-dialog :is(button, a, input, select, textarea, summary):focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
@keyframes board-inspector-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
@media (hover: hover) and (pointer: fine) { .task-dialog button:hover:not(:disabled) { background: var(--accent-hover); } .task-dialog .task-dialog-primary:hover:not(:disabled) { background: var(--text); opacity: .9; } }
@media (max-width: 600px) { .task-dialog { inset: 0; width: 100%; height: 100dvh; border: 0; border-radius: 0; } .task-dialog-header { padding: 24px 20px; gap: 12px; } .task-dialog h2 { font-size: 24px; } .task-dialog-body, .task-dialog-edit-form { padding: 0 20px 24px; gap: 24px; } .task-dialog button { min-height: 44px; } .task-dialog .task-dialog-close { flex-basis: 44px; width: 44px; } .task-dialog-footer { padding: 16px 20px max(16px, env(safe-area-inset-bottom)); flex-wrap: wrap; gap: 12px; } .task-dialog-properties { gap: 20px; } .task-dialog-error, .task-dialog-discard { margin-inline: 20px; } }
@media (prefers-reduced-motion: reduce) { .task-dialog { animation: none; } .task-agent-details > summary span { transition: none; } }
</style>
