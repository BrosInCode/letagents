<template>
  <dialog ref="dialog" class="task-dialog" :aria-labelledby="titleId" @cancel.prevent="requestClose" @click="onBackdropClick" @keydown="trapFocus">
    <div class="task-dialog-content">
      <header class="task-dialog-toolbar">
        <span class="task-dialog-location">Task <span aria-hidden="true">/</span> <strong>{{ formatTaskShortId(task.id) }}</strong></span>
        <button type="button" class="task-dialog-close" title="Close task" aria-label="Close task" :disabled="busy" autofocus @click="requestClose"><CloseIcon :size="18" aria-hidden="true" /></button>
      </header>
      <p v-if="error" class="task-dialog-error" role="alert">{{ error }}</p>
      <section v-if="confirmDiscard" class="task-dialog-discard" role="alert">
        <p>Discard unsaved changes?</p>
        <div><button type="button" :disabled="busy" @click="confirmDiscard = false">Keep editing</button><button type="button" class="cancel" :disabled="busy" @click="discard">Discard changes</button></div>
      </section>

      <form v-if="editing" id="task-content-form" class="task-dialog-edit-form" @submit.prevent="save">
        <h2 :id="titleId">Edit task</h2>
        <label class="task-title-field"><span>Title</span><input ref="titleInput" v-model="draftTitle" type="text" required :disabled="busy" /></label>
        <TaskMarkdownEditor v-model="draftDescription" :disabled="busy" />
      </form>
      <TaskDetailLayout v-else :summary="formatActorName(task.assignee) || 'Unassigned'" :detail-key="task.id">
        <template #heading>
      <header class="task-dialog-header">
        <div class="task-dialog-heading">
          <div class="task-dialog-meta">
            <span :style="{ color: taskStatusAccent(task.status) }">{{ taskStatusLabel(task.status) }}</span>
            <button v-if="canManageLeases && saveContent && !editing" type="button" class="task-dialog-edit" :disabled="busy" @click="startEditing" aria-label="Edit task" title="Edit task"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5M3 21l5-1L21 7a3 3 0 0 0-4-4L4 16Z" /></svg></button>
          </div>
          <h2 :id="titleId">{{ task.title }}</h2>
          <a v-if="primaryPr" class="task-dialog-pr" :href="primaryPr.url" target="_blank" rel="noopener noreferrer"><GitPullRequestIcon :size="16" aria-hidden="true" />{{ primaryPr.label }}<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg></a>
        </div>
      </header>
        </template>
        <section class="task-dialog-description">
          <h3>Description</h3>
          <div class="task-markdown-preview" v-html="renderMessageContent(task.description || 'No description yet.')"></div>
        </section>
        <div class="task-dialog-sections">
          <section v-if="secondaryWorkflowRefs.length" class="task-dialog-section">
            <h3>Linked work</h3>
            <div class="task-dialog-links">
              <a v-for="ref in secondaryWorkflowRefs" :key="ref.url" :href="ref.url" target="_blank" rel="noopener noreferrer">{{ ref.label }}</a>
            </div>
          </section>
          <TaskMergeReadiness v-if="githubStatus" :status="githubStatus" :task="task" />
        </div>
        <template #details>
          <dl class="task-dialog-properties"><div><dt>Assignee</dt><dd>{{ formatActorName(task.assignee) || 'Unassigned' }}</dd></div></dl>
          <slot name="planning" />
          <dl class="task-dialog-properties task-dialog-created">
            <div><dt>Created by</dt><dd>{{ formatActorName(task.created_by) || 'Unknown' }}</dd></div>
            <div><dt>Created</dt><dd :title="task.created_at">{{ formatTimestamp(task.created_at) }}</dd></div>
            <div><dt>Updated</dt><dd :title="task.updated_at">{{ formatTimestamp(task.updated_at) }}</dd></div>
          </dl>
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
        </template>
        <template #actions>
          <button type="button" class="task-dialog-back" :disabled="busy" @click="requestClose">View on board</button>
          <div class="task-dialog-secondary">
            <button v-if="canFocusTask(task)" type="button" :disabled="busy" @click="emit('focusTask', task.id)">Focus on this</button>
            <button v-for="action in secondaryActions" :key="action.status" type="button" :class="action.cls" :disabled="busy" @click="emit('updateStatus', task.id, action.status)">{{ updating ? 'Updating...' : action.label }}</button>
            <button v-if="primaryAction" type="button" class="task-dialog-primary" :disabled="busy" @click="emit('updateStatus', task.id, primaryAction.status)">{{ updating ? 'Updating...' : primaryAction.label }}</button>
          </div>
        </template>
      </TaskDetailLayout>

      <footer v-if="editing" class="task-dialog-footer">
        <button type="button" :disabled="busy" @click="finishEditing">Cancel edits</button>
        <button type="submit" form="task-content-form" class="task-dialog-primary" :disabled="busy || !draftTitle.trim() || !dirty">{{ busy ? 'Saving...' : 'Save changes' }}</button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId } from 'vue'
import { taskContentPatch, type TaskContentPatch } from '../../../../../../shared/task-markdown-editing.mjs'
import type { RoomAgentPresence, RoomTask, TaskGitHubArtifactStatus } from '@/composables/useRoom'
import TaskDetailLayout from '../../../../../../shared/ui/board/TaskDetailLayout.vue'
import GitPullRequestIcon from '@/components/icons/GitPullRequestIcon.vue'
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
  const url = props.task.pr_url || props.githubStatus?.pr_url || props.task.workflow_artifacts?.find(item => item.kind === 'pull_request')?.url || workflowRefs.value.find(item => item.kind === 'pull_request')?.url
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
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
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
.task-dialog { position:fixed; inset:12px 12px 12px auto; width:min(920px,calc(100vw - 24px)); height:calc(100dvh - 24px); max-width:none; max-height:none; margin:0; padding:0; border:1px solid var(--border-strong); border-radius:16px; background:var(--bg); color:var(--text); box-shadow:0 24px 72px rgb(0 0 0 / 24%); overflow:hidden; animation:board-inspector-in 300ms cubic-bezier(.32,.72,0,1); }
.task-dialog::backdrop { background:rgb(0 0 0 / 36%); }
.task-dialog-content { display:flex; flex-direction:column; height:100%; min-height:0; }
.task-dialog-toolbar { display:flex; align-items:center; justify-content:space-between; flex:0 0 auto; gap:16px; height:61px; padding:0 20px 0 28px; border-bottom:1px solid var(--border); }
.task-dialog-location { display:flex; align-items:center; gap:12px; color:var(--text-secondary); font-size:12px; }
.task-dialog-location strong { color:var(--text); font-weight:500; }
.task-dialog-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.task-dialog-heading { min-width:0; flex:1; }
.task-dialog-meta { display:flex; align-items:center; gap:12px; margin-bottom:16px; color:var(--text-secondary); font-size:12px; }
.task-dialog-meta>span { border:1px solid var(--border); border-radius:6px; padding:4px 8px; }
.task-dialog h2 { margin:0; font-size:28px; line-height:1.28; font-weight:600; letter-spacing:-.65px; overflow-wrap:anywhere; }
.task-dialog-pr { display:inline-flex; align-items:center; gap:8px; margin-top:20px; color:var(--blue); font-size:16px; font-weight:600; text-decoration:none; }
.task-dialog-pr:hover { text-decoration:underline; text-underline-offset:3px; }
.task-dialog button { min-height:36px; padding:0 12px; background:var(--bg-subtle); color:var(--text); border:1px solid var(--border); border-radius:7px; font:inherit; font-size:13px; cursor:pointer; }
.task-dialog button:disabled { opacity:.45; cursor:default; }
.task-dialog .task-dialog-edit { display:grid; place-items:center; margin-left:auto; width:32px; min-height:32px; padding:0; background:transparent; border-color:transparent; color:var(--text-secondary); }
.task-dialog .task-dialog-close { display:grid; place-items:center; width:32px; min-height:32px; padding:0; border:0; background:transparent; color:var(--text-secondary); }
.task-dialog h3 { margin:0 0 12px; color:var(--text); font-size:13px; font-weight:600; line-height:1.5; }
.task-dialog p { margin:0; font-size:13px; line-height:1.7; overflow-wrap:anywhere; }
.task-dialog-description { min-width:0; }
.task-dialog-properties { display:grid; gap:4px; margin:0; font-size:12px; }
.task-dialog-properties>div { display:grid; grid-template-columns:78px minmax(0,1fr); gap:6px; align-items:start; min-height:32px; padding:7px 0; }
.task-dialog dt { color:var(--text-secondary); }
.task-dialog dd { margin:0; color:var(--text); overflow-wrap:anywhere; }
.task-dialog-created { padding-top:18px; margin-top:18px; border-top:1px solid var(--border); }
.task-dialog-sections,.task-agent-details-content { display:grid; gap:24px; min-width:0; }
.task-dialog-sections:empty { display:none; }
.task-agent-details { margin-top:14px; }
.task-agent-details>summary { display:flex; align-items:center; justify-content:space-between; min-height:36px; color:var(--text-secondary); font-size:12px; list-style:none; cursor:pointer; border-radius:6px; }
.task-agent-details>summary::-webkit-details-marker { display:none; }
.task-agent-details>summary span { transition:transform 160ms ease; }
.task-agent-details[open]>summary span { transform:rotate(180deg); }
.task-agent-details-content { padding-top:14px; }
.task-dialog-section,.task-agent-details-content :deep(.lease-authority),.task-agent-details-content :deep(.review-authority),.task-dialog-sections :deep(.task-merge-readiness) { padding:0; border:0; border-radius:0; background:transparent; min-width:0; }
.task-agent-details-content :deep(.lease-authority__grid),.task-agent-details-content :deep(.review-authority__grid) { grid-template-columns:minmax(0,1fr); }
.task-agent-details-content :deep(.lease-authority__handoff .app-select) { min-width:0; }
.task-agent-details-content :deep(.lease-authority__button),.task-agent-details-content :deep(.review-authority__actions .btn) { flex-shrink:0; white-space:nowrap; }
.task-agent-details-content :deep(.lease-authority__tile),.task-agent-details-content :deep(.review-authority__tile),.task-dialog-sections :deep(.merge-readiness-signal) { padding:0; border:0; border-radius:0; background:transparent; }
.task-dialog-links { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.task-dialog-links a { color:var(--blue); font-size:13px; overflow-wrap:anywhere; }
.task-dialog-footer { display:flex; align-items:center; justify-content:flex-end; flex:0 0 auto; gap:12px; padding:16px 24px; border-top:1px solid var(--border); background:var(--bg); }
.task-dialog-secondary { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:10px; margin-left:auto; min-width:0; }
.task-dialog-secondary button.cancel { color:var(--red-text); }
.task-dialog .task-dialog-back { background:transparent; border:0; padding:8px 0; color:var(--text-secondary); font-size:12px; }
.task-dialog .task-dialog-primary { flex:0 0 auto; min-width:104px; color:var(--bg); background:var(--text); border-color:transparent; font-weight:550; }
.task-dialog .task-dialog-error { margin:16px 24px; color:var(--red-text); font-size:13px; }
.task-dialog-edit-form { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; display:grid; align-content:start; gap:24px; min-width:0; padding:26px 32px 32px; }
.task-dialog-edit-form h2 { font-size:24px; }
.task-title-field { display:grid; gap:10px; color:var(--text-secondary); font-size:13px; }
.task-title-field input { width:100%; min-height:48px; padding:12px 14px; border:1px solid var(--border-strong); border-radius:8px; background:var(--bg-subtle); color:var(--text); font:inherit; font-size:16px; }
.task-dialog-discard { display:grid; gap:12px; margin:16px 24px; padding:14px; flex-shrink:0; border:1px solid var(--border-strong); border-radius:8px; background:var(--bg-subtle); }
.task-dialog-discard>div { display:flex; flex-wrap:wrap; gap:8px; }
.task-dialog :is(button,a,input,select,textarea,summary):focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
@keyframes board-inspector-in { from { opacity:0; transform:translateX(45px); } to { opacity:1; transform:translateX(0); } }
@media(hover:hover) and (pointer:fine) { .task-dialog button:hover:not(:disabled) { background:var(--accent-hover); } .task-dialog .task-dialog-primary:hover:not(:disabled) { background:var(--text); opacity:.9; } }
@media(min-width:1600px) { .task-dialog { width:960px; } }
@media(max-width:760px) { .task-dialog h2 { font-size:25px; } .task-dialog-properties>div { grid-template-columns:minmax(78px,1fr) 145px; } }
@media(max-width:640px) { .task-agent-details-content :deep(.lease-authority__handoff .app-select) { flex:0 0 auto; } }
@media(max-width:600px) { .task-dialog { inset:0; width:100%; height:100dvh; border:0; border-radius:0; } .task-dialog-edit-form { padding:24px 20px; } .task-dialog-footer { padding:16px 20px max(16px,env(safe-area-inset-bottom)); flex-wrap:wrap; } }
@media(prefers-reduced-motion:reduce) { .task-dialog { animation:none; } .task-agent-details>summary span { transition:none; } }
</style>
