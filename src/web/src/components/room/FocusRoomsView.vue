<template>
  <div class="focus-rooms-panel">
    <section class="focus-hero">
      <div class="focus-hero-copy">
        <p class="focus-eyebrow">Rooms</p>
        <h3>Give bigger work a quieter room.</h3>
        <p>Keep the main room clear while agents go deep on one task.</p>
      </div>
      <div class="focus-route">
        <span>Route</span>
        <strong>{{ previewRoute }}</strong>
      </div>
    </section>

    <section v-if="isFocusRoom" class="focus-context" :data-concluded="isConcluded">
      <div>
        <p class="focus-eyebrow">Current Focus Room</p>
        <h4>{{ sourceTaskId || 'Task room' }}</h4>
        <p>{{ focusContextCopy }}</p>
      </div>
      <dl class="focus-facts compact">
        <div>
          <dt>Parent</dt>
          <dd>{{ roomAddress }}</dd>
        </div>
        <div>
          <dt>Source task</dt>
          <dd>{{ sourceTaskId || 'Not linked' }}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{{ focusStatusLabel }}</dd>
        </div>
      </dl>
      <div class="focus-context-actions">
        <button class="focus-secondary" type="button" @click="emit('openParentRoom')">
          Back to parent room
        </button>
      </div>
      <form class="focus-share-form" @submit.prevent="submitShareResults">
        <label class="focus-share-label" for="focus-result-summary">Result summary</label>
        <textarea
          id="focus-result-summary"
          v-model="resultSummary"
          :disabled="isConcluded || isSharingFocusResult"
          :placeholder="sharePlaceholder"
          rows="4"
        />
        <div class="focus-share-footer">
          <p>{{ shareHelpText }}</p>
          <button
            class="focus-primary"
            type="submit"
            :disabled="!canShareResults"
          >
            {{ shareButtonLabel }}
          </button>
        </div>
      </form>
    </section>

    <div class="focus-layout">
      <section class="focus-list">
        <div v-if="!isFocusRoom" class="focus-section-header">
          <div>
            <h4>Open Focus Rooms</h4>
            <p>Active task rooms ready to enter.</p>
          </div>
          <span>{{ openFocusRooms.length }}</span>
        </div>

        <div v-if="!isFocusRoom && openFocusRooms.length === 0" class="focus-empty compact">
          <h4>No open Focus Rooms</h4>
          <p>Open one from a task when the work needs a dedicated room.</p>
        </div>

        <button
          v-for="focusRoom in openFocusRooms"
          :key="focusRoom.room_id"
          class="focus-task focus-room-link"
          type="button"
          @click="emit('openFocusRoom', focusRoom.focus_key || focusRoom.source_task_id || focusRoom.room_id)"
        >
          <div>
            <strong>{{ focusRoom.display_name }}</strong>
            <span>{{ focusRoom.source_task_id || focusRoom.room_id }}</span>
          </div>
          <small>{{ focusRoom.focus_status || 'active' }}</small>
        </button>

        <template v-if="!isFocusRoom && concludedFocusRooms.length > 0">
          <div class="focus-section-header concluded">
            <div>
              <h4>Shared results</h4>
              <p>Concluded task rooms with outcomes in the parent room.</p>
            </div>
            <span>{{ concludedFocusRooms.length }}</span>
          </div>

          <button
            v-for="focusRoom in concludedFocusRooms"
            :key="focusRoom.room_id"
            class="focus-task focus-room-link"
            data-concluded="true"
            type="button"
            @click="emit('openFocusRoom', focusRoom.focus_key || focusRoom.source_task_id || focusRoom.room_id)"
          >
            <div>
              <strong>{{ focusRoom.display_name }}</strong>
              <span>{{ focusRoom.conclusion_summary || focusRoom.source_task_id || focusRoom.room_id }}</span>
            </div>
            <small>concluded</small>
          </button>
        </template>

        <div class="focus-section-header">
          <div>
            <h4>Focus candidates</h4>
            <p>Large, noisy, or multi-agent work belongs here.</p>
          </div>
          <span>{{ candidateTasks.length }}</span>
        </div>

        <div v-if="candidateTasks.length === 0" class="focus-empty">
          <h4>No open tasks yet</h4>
          <p>Add a task first, then focus it into a room.</p>
        </div>

        <button
          v-for="task in candidateTasks"
          :key="task.id"
          class="focus-task"
          :data-selected="task.id === currentTask?.id"
          type="button"
          @click="emit('selectTask', task.id)"
        >
          <div>
            <strong>{{ task.title }}</strong>
            <span>{{ task.description || task.id }}</span>
          </div>
          <small>{{ taskStatusLabel(task.status) }}</small>
        </button>
      </section>

      <aside class="focus-detail">
        <template v-if="currentTask">
          <p class="focus-eyebrow">Selected task</p>
          <h4>{{ currentTask.title }}</h4>
          <p class="focus-detail-copy">
            Open a Focus Room when this task needs its own discussion, agents, logs, or decisions.
          </p>

          <dl class="focus-facts">
            <div>
              <dt>Parent</dt>
              <dd>{{ roomLabel }}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{{ taskStatusLabel(currentTask.status) }}</dd>
            </div>
            <div>
              <dt>Share back</dt>
              <dd>{{ shareBackLabel }}</dd>
            </div>
          </dl>

          <button
            class="focus-primary"
            type="button"
            :disabled="isFocusRoom || isCreatingFocusRoom"
            @click="currentFocusRoom ? emit('openFocusRoom', currentFocusRoom.focus_key || currentTask.id) : emit('createFocusRoom', currentTask.id)"
          >
            {{ actionLabel }}
          </button>
          <p class="focus-note">
            {{ actionNote }}
          </p>
        </template>

        <template v-else>
          <p class="focus-eyebrow">No task selected</p>
          <h4>Choose a task to focus.</h4>
          <p class="focus-detail-copy">
            Start from the board or pick a candidate here.
          </p>
        </template>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { type FocusRoomInfo, type RoomTask } from '@/composables/useRoom'

const props = defineProps<{
  tasks: readonly RoomTask[]
  focusRooms: readonly FocusRoomInfo[]
  selectedTaskId: string | null
  roomLabel: string
  roomAddress: string
  isFocusRoom: boolean
  sourceTaskId: string | null
  focusStatus: 'active' | 'concluded' | null
  conclusionSummary: string | null
  isCreatingFocusRoom: boolean
  isSharingFocusResult: boolean
}>()

const emit = defineEmits<{
  selectTask: [taskId: string]
  createFocusRoom: [taskId: string]
  openFocusRoom: [focusKey: string]
  openParentRoom: []
  shareResults: [summary: string]
}>()

const resultSummary = ref('')
const shareAttempted = ref(false)

const candidateTasks = computed(() =>
  props.tasks.filter(task => !['done', 'cancelled'].includes(task.status))
)

const openFocusRooms = computed(() =>
  props.focusRooms.filter(room => room.kind === 'focus' && room.focus_status !== 'concluded')
)

const concludedFocusRooms = computed(() =>
  props.focusRooms.filter(room => room.kind === 'focus' && room.focus_status === 'concluded')
)

const focusRoomByTask = computed(() => {
  const entries = props.focusRooms
    .filter(room => room.source_task_id)
    .map(room => [room.source_task_id as string, room] as const)
  return new Map(entries)
})

const currentTask = computed(() => {
  const selected = props.selectedTaskId
    ? candidateTasks.value.find(task => task.id === props.selectedTaskId)
    : null
  return selected ?? candidateTasks.value[0] ?? null
})

const currentFocusRoom = computed(() => {
  const taskId = currentTask.value?.id
  return taskId ? focusRoomByTask.value.get(taskId) ?? null : null
})

const isConcluded = computed(() => props.focusStatus === 'concluded')
const conclusionSummaryText = computed(() => props.conclusionSummary?.trim() || '')
const focusStatusLabel = computed(() => props.focusStatus ? taskStatusLabel(props.focusStatus) : 'active')
const focusContextCopy = computed(() =>
  isConcluded.value
    ? 'Result shared with the parent room.'
    : 'Keep task-specific work here, then bring the outcome back to the parent room.'
)
const sharePlaceholder = computed(() =>
  isConcluded.value
    ? 'Result already shared.'
    : 'Summarize the decision, implementation, blocker, or next action for the parent room.'
)
const canShareResults = computed(() =>
  !isConcluded.value && !props.isSharingFocusResult && resultSummary.value.trim().length > 0
)
const shareButtonLabel = computed(() => {
  if (isConcluded.value) return 'Results shared'
  if (props.isSharingFocusResult) return 'Sharing...'
  return 'Share results'
})
const shareHelpText = computed(() => {
  if (isConcluded.value) {
    return conclusionSummaryText.value || 'The parent room has the outcome.'
  }
  if (shareAttempted.value && !resultSummary.value.trim()) {
    return 'Write a short outcome before sharing.'
  }
  return 'Send a concise outcome to the parent room.'
})
const shareBackLabel = computed(() => {
  if (!currentFocusRoom.value) return 'Outcome summary'
  return currentFocusRoom.value.focus_status === 'concluded' ? 'Shared' : 'Ready'
})

const previewRoute = computed(() => {
  const base = props.roomAddress || 'room'
  const focusKey = props.isFocusRoom
    ? props.sourceTaskId || currentTask.value?.id || 'task'
    : currentFocusRoom.value?.focus_key || currentTask.value?.id || 'task'
  return `/in/${base}/focus/${focusKey}`
})

const actionLabel = computed(() => {
  if (props.isFocusRoom) return 'Focus Room active'
  if (currentFocusRoom.value?.focus_status === 'concluded') return 'View shared result'
  if (currentFocusRoom.value) return 'Open Focus Room'
  if (props.isCreatingFocusRoom) return 'Opening...'
  return 'Focus on this'
})

const actionNote = computed(() => {
  if (props.isFocusRoom) return 'Open new Focus Rooms from the parent room.'
  if (currentFocusRoom.value?.focus_status === 'concluded') return 'This task already has a shared result.'
  if (currentFocusRoom.value) return 'This task already has a Focus Room.'
  return 'This opens a dedicated room for task-level execution.'
})

watch(
  conclusionSummaryText,
  (summary) => {
    if (summary) {
      resultSummary.value = summary
    }
  },
  { immediate: true }
)

function submitShareResults() {
  shareAttempted.value = true
  const trimmedSummary = resultSummary.value.trim()
  if (!trimmedSummary || isConcluded.value || props.isSharingFocusResult) return
  emit('shareResults', trimmedSummary)
}

function taskStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}
</script>

<style scoped>
.focus-rooms-panel {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 22px;
  background: var(--bg-0, #09090b);
}

.focus-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 0.72fr);
  gap: 14px;
  align-items: stretch;
  margin-bottom: 14px;
}

.focus-hero-copy,
.focus-route,
.focus-list,
.focus-detail {
  border: 1px solid var(--line, #27272a);
  background: var(--bg-1, #0f0f11);
  border-radius: 8px;
}

.focus-hero-copy {
  padding: 18px;
}

.focus-eyebrow {
  margin: 0 0 8px;
  color: #93c5fd;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.focus-hero h3,
.focus-context h4,
.focus-detail h4,
.focus-empty h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-weight: 800;
  letter-spacing: -0.02em;
}

.focus-hero h3 {
  font-size: 1.28rem;
}

.focus-hero p,
.focus-context p,
.focus-section-header p,
.focus-detail-copy,
.focus-note,
.focus-empty p {
  margin: 6px 0 0;
  color: var(--muted, #71717a);
  line-height: 1.55;
  font-size: 0.82rem;
}

.focus-route {
  display: grid;
  align-content: center;
  gap: 6px;
  padding: 18px;
}

.focus-route span,
.focus-facts dt {
  color: var(--muted, #71717a);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.focus-route strong {
  display: block;
  color: var(--text, #fafafa);
  font-family: var(--font-mono, monospace);
  font-size: 0.76rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.focus-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.52fr);
  gap: 14px;
  min-height: 0;
}

.focus-list,
.focus-detail {
  padding: 14px;
}

.focus-context {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 0.8fr) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 14px;
  padding: 14px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-1, #0f0f11);
}

.focus-context h4 {
  font-size: 1rem;
}

.focus-context-actions {
  display: grid;
  gap: 8px;
}

.focus-context[data-concluded="true"] {
  border-color: rgba(34, 197, 94, 0.35);
}

.focus-share-form {
  grid-column: 1 / -1;
  display: grid;
  gap: 8px;
  padding-top: 4px;
}

.focus-share-label {
  color: var(--text, #fafafa);
  font-size: 0.78rem;
  font-weight: 800;
}

.focus-share-form textarea {
  width: 100%;
  min-height: 96px;
  resize: vertical;
  padding: 10px 11px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.82rem;
  line-height: 1.5;
}

.focus-share-form textarea:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.focus-share-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.focus-share-footer p {
  margin: 0;
  color: var(--muted, #71717a);
  font-size: 0.78rem;
  line-height: 1.45;
}

.focus-share-footer .focus-primary {
  width: auto;
  min-width: 136px;
}

.focus-section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.focus-section-header.concluded {
  margin-top: 16px;
}

.focus-section-header h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.86rem;
}

.focus-section-header span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  font-size: 0.72rem;
  font-weight: 800;
}

.focus-task {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 11px 12px;
  margin-bottom: 7px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  cursor: pointer;
  text-align: left;
  transition: border-color 150ms, background 150ms;
}

.focus-task:hover,
.focus-task[data-selected="true"] {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(96, 165, 250, 0.08);
}

.focus-task[data-concluded="true"] small {
  color: #86efac;
}

.focus-task strong,
.focus-task span {
  display: block;
}

.focus-task strong {
  font-size: 0.82rem;
  line-height: 1.4;
}

.focus-task span {
  margin-top: 3px;
  color: var(--muted, #71717a);
  font-size: 0.74rem;
  line-height: 1.45;
}

.focus-task small {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--surface, #18181b);
  color: #93c5fd;
  font-size: 0.64rem;
  font-weight: 800;
  text-transform: capitalize;
}

.focus-detail {
  position: sticky;
  top: 0;
  align-self: start;
}

.focus-facts {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}

.focus-facts.compact {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin: 0;
}

.focus-facts div {
  display: grid;
  gap: 4px;
  padding: 9px 10px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
}

.focus-facts dd {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.focus-primary {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(96, 165, 250, 0.3);
  background: #dbeafe;
  color: #111827;
  font-size: 0.82rem;
  font-weight: 800;
  cursor: pointer;
  transition: opacity 150ms;
}

.focus-secondary {
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  font-size: 0.76rem;
  font-weight: 800;
  cursor: pointer;
}

.focus-secondary:disabled {
  cursor: not-allowed;
  opacity: 0.58;
}

.focus-primary:hover {
  opacity: 0.9;
}

.focus-primary:disabled {
  cursor: progress;
  opacity: 0.7;
}

.focus-note {
  text-align: center;
}

.focus-empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--muted, #71717a);
}

.focus-empty.compact {
  padding: 14px;
  margin-bottom: 12px;
  border: 1px dashed var(--line, #27272a);
  border-radius: 8px;
}

@media (max-width: 860px) {
  .focus-hero,
  .focus-context,
  .focus-layout {
    grid-template-columns: 1fr;
  }

  .focus-detail {
    position: static;
  }
}

@media (max-width: 768px) {
  .focus-rooms-panel {
    padding: 12px 12px 16px;
  }

  .focus-hero-copy,
  .focus-route,
  .focus-list,
  .focus-detail {
    padding: 12px;
  }

  .focus-task {
    flex-direction: column;
    gap: 8px;
  }

  .focus-facts.compact {
    grid-template-columns: 1fr;
  }

  .focus-share-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .focus-share-footer .focus-primary {
    width: 100%;
  }
}
</style>
