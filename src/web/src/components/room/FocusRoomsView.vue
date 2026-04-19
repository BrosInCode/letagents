<template>
  <div class="focus-rooms-panel">
    <section class="focus-hero">
      <div class="focus-hero-copy">
        <p class="focus-eyebrow">Rooms</p>
        <h2>Give bigger work a quieter room.</h2>
        <p>Keep the main room clear while agents go deep on one task.</p>
      </div>
    </section>

    <section v-if="isFocusRoom" class="focus-context" :data-concluded="isConcluded">
      <div>
        <p class="focus-eyebrow">Current Focus Room</p>
        <h4>{{ sourceTaskId || 'Ad-hoc room' }}</h4>
        <p>{{ focusContextCopy }}</p>
      </div>
      <dl class="focus-facts compact">
        <div>
          <dt>Parent</dt>
          <dd>{{ roomAddress }}</dd>
        </div>
        <div>
          <dt>Source task</dt>
          <dd>{{ sourceTaskId || 'Not linked yet' }}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{{ focusStatusLabel }}</dd>
        </div>
        <div>
          <dt>Parent chat</dt>
          <dd>{{ parentVisibilityLabel(settingsDraft.parent_visibility) }}</dd>
        </div>
      </dl>
      <div class="focus-context-actions">
        <button class="focus-secondary" type="button" @click="emit('openParentRoom')">
          Back to parent room
        </button>
      </div>
      <form v-if="settingsTarget" class="focus-settings-form" @submit.prevent="submitFocusSettings">
        <div class="focus-settings-heading">
          <div>
            <p class="focus-eyebrow">Visibility settings</p>
            <h4>Choose what leaves this room.</h4>
          </div>
          <button
            class="focus-secondary"
            type="submit"
            :disabled="!canSaveSettings"
          >
            {{ settingsButtonLabel }}
          </button>
        </div>
        <div class="focus-settings-grid">
          <label>
            <span>Parent chat</span>
            <select v-model="settingsDraft.parent_visibility" :disabled="isUpdatingFocusSettings">
              <option
                v-for="option in parentVisibilityOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <small>{{ parentVisibilityDescription }}</small>
          </label>
          <label>
            <span>Activity scope</span>
            <select v-model="settingsDraft.activity_scope" :disabled="isUpdatingFocusSettings">
              <option
                v-for="option in activityScopeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <small>{{ activityScopeDescription }}</small>
          </label>
          <label>
            <span>GitHub events</span>
            <select v-model="settingsDraft.github_event_routing" :disabled="isUpdatingFocusSettings">
              <option
                v-for="option in githubEventRoutingOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <small>{{ githubEventRoutingDescription }}</small>
          </label>
        </div>
      </form>
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
        <form v-if="!isFocusRoom" class="focus-adhoc" @submit.prevent="submitAdHocFocusRoom">
          <div>
            <p class="focus-eyebrow">Branch from an idea</p>
            <h4>Start with a room, not a task.</h4>
            <p>Give the work a short intent. A task can be linked when execution starts.</p>
          </div>
          <div class="focus-adhoc-controls">
            <label class="sr-only" for="adhoc-focus-title">Focus Room intent</label>
            <input
              id="adhoc-focus-title"
              v-model="adHocTitle"
              :disabled="isCreatingAdHocFocusRoom"
              placeholder="Investigate Focus Room flow"
            />
            <button
              class="focus-primary"
              type="submit"
              :disabled="!canCreateAdHocFocusRoom"
            >
              {{ adHocButtonLabel }}
            </button>
          </div>
          <p v-if="adHocAttempted && !adHocTitle.trim()" class="focus-adhoc-error">
            Name the room first.
          </p>
        </form>

        <div v-if="!isFocusRoom" class="focus-section-header">
          <div>
            <h3>Open Focus Rooms</h3>
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
            <span>{{ focusRoom.source_task_id || 'No linked task yet' }}</span>
          </div>
          <small>{{ focusRoom.focus_status || 'active' }}</small>
        </button>

        <template v-if="!isFocusRoom && concludedFocusRooms.length > 0">
          <div class="focus-section-header concluded">
            <div>
              <h3>Shared results</h3>
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
            <h3>Focus candidates</h3>
            <p>Large, noisy, or multi-agent work belongs here.</p>
          </div>
          <span>{{ candidateTasks.length }}</span>
        </div>

        <div v-if="candidateTasks.length === 0" class="focus-empty">
          <h4>No open tasks yet</h4>
          <p>Add a task or branch a room from an idea.</p>
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
            <div v-if="currentFocusRoom">
              <dt>Parent chat</dt>
              <dd>{{ parentVisibilityLabel(settingsDraft.parent_visibility) }}</dd>
            </div>
          </dl>

          <form
            v-if="settingsTarget"
            class="focus-settings-form compact"
            @submit.prevent="submitFocusSettings"
          >
            <div class="focus-settings-heading">
              <div>
                <p class="focus-eyebrow">Visibility settings</p>
                <h4>Parent visibility</h4>
              </div>
              <button
                class="focus-secondary"
                type="submit"
                :disabled="!canSaveSettings"
              >
                {{ settingsButtonLabel }}
              </button>
            </div>
            <div class="focus-settings-grid compact">
              <label>
                <span>Parent chat</span>
                <select v-model="settingsDraft.parent_visibility" :disabled="isUpdatingFocusSettings">
                  <option
                    v-for="option in parentVisibilityOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <small>{{ parentVisibilityDescription }}</small>
              </label>
              <label>
                <span>Activity scope</span>
                <select v-model="settingsDraft.activity_scope" :disabled="isUpdatingFocusSettings">
                  <option
                    v-for="option in activityScopeOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <small>{{ activityScopeDescription }}</small>
              </label>
              <label>
                <span>GitHub events</span>
                <select v-model="settingsDraft.github_event_routing" :disabled="isUpdatingFocusSettings">
                  <option
                    v-for="option in githubEventRoutingOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </option>
                </select>
                <small>{{ githubEventRoutingDescription }}</small>
              </label>
            </div>
          </form>

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
import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
  type FocusActivityScope,
  type FocusGitHubEventRouting,
  type FocusParentVisibility,
  type FocusRoomInfo,
  type FocusRoomSettings,
  type RoomTask,
} from '@/composables/useRoom'

const props = defineProps<{
  tasks: readonly RoomTask[]
  focusRooms: readonly FocusRoomInfo[]
  selectedTaskId: string | null
  roomLabel: string
  roomAddress: string
  isFocusRoom: boolean
  sourceTaskId: string | null
  focusKey: string | null
  focusStatus: 'active' | 'concluded' | null
  focusSettings: FocusRoomSettings
  conclusionSummary: string | null
  isCreatingFocusRoom: boolean
  isCreatingAdHocFocusRoom: boolean
  isSharingFocusResult: boolean
  isUpdatingFocusSettings: boolean
}>()

const emit = defineEmits<{
  selectTask: [taskId: string]
  createFocusRoom: [taskId: string]
  createAdHocFocusRoom: [title: string]
  openFocusRoom: [focusKey: string]
  openParentRoom: []
  shareResults: [summary: string]
  updateFocusSettings: [focusKey: string, settings: FocusRoomSettings]
}>()

const resultSummary = ref('')
const shareAttempted = ref(false)
const settingsDraft = ref<FocusRoomSettings>({ ...DEFAULT_FOCUS_ROOM_SETTINGS })
const adHocTitle = ref('')
const adHocAttempted = ref(false)

const parentVisibilityOptions: Array<{ value: FocusParentVisibility; label: string }> = [
  { value: 'summary_only', label: 'Result summaries only' },
  { value: 'major_activity', label: 'Major activity' },
  { value: 'all_activity', label: 'All activity' },
  { value: 'silent', label: 'Keep parent quiet' },
]
const activityScopeOptions: Array<{ value: FocusActivityScope; label: string }> = [
  { value: 'task_and_branch', label: 'Task and branch' },
  { value: 'task_only', label: 'Task only' },
  { value: 'room', label: 'Whole Focus Room' },
]
const githubEventRoutingOptions: Array<{ value: FocusGitHubEventRouting; label: string }> = [
  { value: 'task_and_branch', label: 'Matching task/branch' },
  { value: 'task_only', label: 'Task-linked only' },
  { value: 'all_parent_repo', label: 'All parent repo events' },
  { value: 'off', label: 'Do not route' },
]

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

const settingsTarget = computed(() => {
  if (props.isFocusRoom) {
    return {
      focusKey: props.focusKey || props.sourceTaskId,
      settings: props.focusSettings,
    }
  }
  if (!currentFocusRoom.value) return null
  return {
    focusKey: currentFocusRoom.value.focus_key || currentFocusRoom.value.source_task_id,
    settings: focusRoomSettingsFrom(currentFocusRoom.value),
  }
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
  if (settingsDraft.value.parent_visibility === 'silent') return 'Save result'
  return 'Share results'
})
const shareHelpText = computed(() => {
  if (isConcluded.value) {
    return conclusionSummaryText.value || 'The parent room has the outcome.'
  }
  if (shareAttempted.value && !resultSummary.value.trim()) {
    return 'Write a short outcome before sharing.'
  }
  if (settingsDraft.value.parent_visibility === 'silent') {
    return 'Conclude this Focus Room without posting the summary into parent chat.'
  }
  return 'Send a concise outcome to the parent room.'
})
const canCreateAdHocFocusRoom = computed(() =>
  !props.isCreatingAdHocFocusRoom && adHocTitle.value.trim().length > 0
)
const adHocButtonLabel = computed(() =>
  props.isCreatingAdHocFocusRoom ? 'Opening...' : 'Branch room'
)
const shareBackLabel = computed(() => {
  if (!currentFocusRoom.value) return 'Outcome summary'
  return currentFocusRoom.value.focus_status === 'concluded' ? 'Shared' : 'Ready'
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

const hasSettingsChanges = computed(() => {
  const target = settingsTarget.value
  if (!target) return false
  const current = target.settings
  return (
    settingsDraft.value.parent_visibility !== current.parent_visibility ||
    settingsDraft.value.activity_scope !== current.activity_scope ||
    settingsDraft.value.github_event_routing !== current.github_event_routing
  )
})
const canSaveSettings = computed(() =>
  Boolean(settingsTarget.value?.focusKey) &&
  hasSettingsChanges.value &&
  !props.isUpdatingFocusSettings
)
const settingsButtonLabel = computed(() =>
  props.isUpdatingFocusSettings ? 'Saving...' : hasSettingsChanges.value ? 'Save settings' : 'Saved'
)
const parentVisibilityDescription = computed(() => {
  switch (settingsDraft.value.parent_visibility) {
    case 'silent':
      return 'No task activity or result summaries are posted to parent chat.'
    case 'all_activity':
      return 'Every routed Focus Room event may appear in parent chat.'
    case 'major_activity':
      return 'Only major task, PR, and conclusion updates appear in parent chat.'
    case 'summary_only':
    default:
      return 'Only explicit result summaries appear in parent chat.'
  }
})
const activityScopeDescription = computed(() => {
  switch (settingsDraft.value.activity_scope) {
    case 'room':
      return 'Activity can include the whole Focus Room thread.'
    case 'task_only':
      return 'Activity is limited to the linked source task.'
    case 'task_and_branch':
    default:
      return 'Activity is scoped to the linked task and its branch/artifacts.'
  }
})
const githubEventRoutingDescription = computed(() => {
  switch (settingsDraft.value.github_event_routing) {
    case 'off':
      return 'GitHub events stay out of this Focus Room routing lane.'
    case 'all_parent_repo':
      return 'Parent repo GitHub events can be surfaced here.'
    case 'task_only':
      return 'Only GitHub events explicitly linked to the task are routed.'
    case 'task_and_branch':
    default:
      return 'GitHub events must match the task, branch, or workflow artifact.'
  }
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

watch(
  settingsTarget,
  (target) => {
    settingsDraft.value = target
      ? { ...target.settings }
      : { ...DEFAULT_FOCUS_ROOM_SETTINGS }
  },
  { immediate: true }
)

function submitShareResults() {
  shareAttempted.value = true
  const trimmedSummary = resultSummary.value.trim()
  if (!trimmedSummary || isConcluded.value || props.isSharingFocusResult) return
  emit('shareResults', trimmedSummary)
}

function submitFocusSettings() {
  const target = settingsTarget.value
  if (!target?.focusKey || !canSaveSettings.value) return
  emit('updateFocusSettings', target.focusKey, { ...settingsDraft.value })
}

function parentVisibilityLabel(value: FocusParentVisibility): string {
  return parentVisibilityOptions.find(option => option.value === value)?.label || 'Result summaries only'
}

function submitAdHocFocusRoom() {
  adHocAttempted.value = true
  const trimmedTitle = adHocTitle.value.trim()
  if (!trimmedTitle || props.isCreatingAdHocFocusRoom) return
  emit('createAdHocFocusRoom', trimmedTitle)
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
  display: flex;
  margin-bottom: 24px;
}

.focus-hero-copy,
.focus-list,
.focus-detail {
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--bg-card, #131316);
  border-radius: 8px;
}

.focus-hero-copy {
  padding: var(--space-xl);
  width: 100%;
}

.focus-eyebrow {
  margin: 0 0 10px;
  color: #93c5fd;
  font-size: 0.75rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.focus-hero h2 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-weight: 800;
  font-size: 1.45rem;
}

.focus-context h4,
.focus-adhoc h4,
.focus-detail h4,
.focus-empty h4 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-weight: 700;
}

.focus-hero p,
.focus-context p,
.focus-adhoc p,
.focus-section-header p,
.focus-detail-copy,
.focus-note,
.focus-empty p {
  margin: 6px 0 0;
  color: var(--text-tertiary, #a1a1aa);
  line-height: 1.55;
  font-size: 0.85rem;
}

.focus-facts dt {
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.68rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.focus-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(260px, 0.52fr);
  gap: 16px;
  min-height: 0;
}

.focus-list,
.focus-detail {
  padding: 20px;
}

.focus-adhoc {
  display: grid;
  gap: 10px;
  margin-bottom: 14px;
  padding: 12px;
  border-radius: 8px;
  background: var(--bg-0, #09090b);
}

.focus-adhoc h4 {
  font-size: 0.92rem;
}

.focus-adhoc-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.focus-adhoc input {
  width: 100%;
  min-height: 38px;
  padding: 9px 10px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-1, #0f0f11);
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.82rem;
}

.focus-adhoc .focus-primary {
  width: auto;
  min-width: 112px;
}

.focus-adhoc-error {
  color: #fca5a5;
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

.focus-settings-form {
  grid-column: 1 / -1;
  display: grid;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(96, 165, 250, 0.22);
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.08), rgba(20, 184, 166, 0.05));
}

.focus-settings-form.compact {
  margin: 10px 0 14px;
  background: rgba(96, 165, 250, 0.06);
}

.focus-settings-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.focus-settings-heading h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.92rem;
}

.focus-settings-heading .focus-eyebrow {
  margin-bottom: 4px;
}

.focus-settings-heading .focus-secondary {
  flex-shrink: 0;
}

.focus-settings-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.focus-settings-grid.compact {
  grid-template-columns: 1fr;
}

.focus-settings-grid label {
  display: grid;
  gap: 6px;
}

.focus-settings-grid span {
  color: var(--text, #fafafa);
  font-size: 0.74rem;
  font-weight: 800;
}

.focus-settings-grid select {
  min-width: 0;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.78rem;
}

.focus-settings-grid select:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.focus-settings-grid small {
  color: var(--muted, #71717a);
  font-size: 0.68rem;
  line-height: 1.42;
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
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  margin-bottom: 16px;
}

.focus-section-header.concluded {
  margin-top: 32px;
}

.focus-section-header h3 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-size: 1.15rem;
  font-weight: 700;
}

.focus-section-header span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary, #ffffff);
  font-size: 0.78rem;
  font-weight: 800;
}

.focus-task {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  margin-bottom: 10px;
  border: 1px solid rgba(255, 255, 255, 0.04);
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  color: var(--text-secondary, #d4d4d8);
  cursor: pointer;
  text-align: left;
  transition: all 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

.focus-task:hover,
.focus-task[data-selected="true"] {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(96, 165, 250, 0.06);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.focus-task[data-concluded="true"] small {
  color: #86efac;
}

.focus-task strong,
.focus-task span {
  display: block;
}

.focus-task strong {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-primary, #ffffff);
  line-height: 1.4;
  transition: color 150ms;
}

.focus-task:hover strong {
  color: #93c5fd;
}

.focus-task span {
  margin-top: 4px;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.76rem;
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

  .focus-adhoc-controls {
    grid-template-columns: 1fr;
  }

  .focus-adhoc .focus-primary {
    width: 100%;
  }

  .focus-facts.compact {
    grid-template-columns: 1fr;
  }

  .focus-share-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .focus-settings-heading,
  .focus-settings-grid {
    grid-template-columns: 1fr;
  }

  .focus-settings-heading {
    align-items: stretch;
  }

  .focus-share-footer .focus-primary {
    width: 100%;
  }
}
</style>
