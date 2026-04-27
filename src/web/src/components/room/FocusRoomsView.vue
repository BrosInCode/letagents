<template>
  <div class="focus-rooms-panel">
    <section class="focus-hero">
      <div class="focus-hero-copy">
        <p class="focus-eyebrow">Rooms</p>
        <h2>Give bigger work a quieter room.</h2>
        <p>Keep the main room clear while agents go deep on one task.</p>
      </div>
    </section>

    <section v-if="isFocusRoom" class="focus-context-container">
      <div class="focus-context-header" :data-concluded="isConcluded">
        <div class="focus-context-header-top">
          <div class="focus-context-title">
            <p class="focus-eyebrow">Current Focus Room</p>
            <h4>{{ sourceTaskId || 'Ad-hoc room' }}</h4>
            <p>{{ focusContextCopy }}</p>
          </div>
          <div class="focus-context-actions">
            <button class="focus-secondary" type="button" @click="emit('openParentRoom')">
              Back to parent room
            </button>
          </div>
        </div>
        <div class="focus-metadata-bar">
          <span class="focus-metadata-item">
            <strong>Parent</strong> {{ roomAddress }}
          </span>
          <span class="focus-metadata-item">
            <strong>Source task</strong> {{ sourceTaskId || 'Not linked yet' }}
          </span>
          <span class="focus-metadata-item">
            <strong>Status</strong> {{ focusStatusLabel }}
          </span>
          <span class="focus-metadata-item">
            <strong>Parent room</strong> {{ parentVisibilityLabel(settingsDraft.parent_visibility) }}
          </span>
        </div>
      </div>

      <div class="focus-context-panels">
        <form v-if="settingsTarget" class="focus-settings-form" @submit.prevent="submitFocusSettings">
          <div class="focus-panel-header">
            <div>
              <p class="focus-eyebrow">Sharing</p>
              <h4>Choose what the parent room can see.</h4>
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
              <span>Parent room</span>
              <AppSelect v-model="settingsDraft.parent_visibility" :disabled="isUpdatingFocusSettings">
                <option
                  v-for="option in parentVisibilityOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
              <small>{{ parentVisibilityDescription }}</small>
            </label>
            <label>
              <span>What counts</span>
              <AppSelect v-model="settingsDraft.activity_scope" :disabled="isUpdatingFocusSettings">
                <option
                  v-for="option in activityScopeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
              <small>{{ activityScopeDescription }}</small>
            </label>
            <label>
              <span>Code updates</span>
              <AppSelect v-model="settingsDraft.github_event_routing" :disabled="isUpdatingFocusSettings">
                <option
                  v-for="option in githubEventRoutingOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
              <small>{{ githubEventRoutingDescription }}</small>
            </label>
          </div>
        </form>
        <form class="focus-share-form" @submit.prevent="submitShareResults">
          <div class="focus-panel-header">
            <div>
              <p class="focus-eyebrow">Result summary</p>
              <h4 v-if="isConcluded">Focus room concluded.</h4>
              <h4 v-else>Share task outcome.</h4>
            </div>
          </div>
          <textarea
            id="focus-result-summary"
            v-model="resultSummary"
            aria-label="Result summary"
            :disabled="isConcluded || isSharingFocusResult"
            :placeholder="sharePlaceholder"
            rows="3"
            class="focus-result-textarea"
          />
          <div v-if="requiresCloseoutDetails || conclusionDetails" class="focus-closeout-grid">
            <label>
              <span>Artifact or decision</span>
              <input
                v-model="closeoutDetails.artifact"
                :disabled="isConcluded || isSharingFocusResult"
                placeholder="PR #316, commit, doc, decision, or investigation result"
              />
            </label>
            <label>
              <span>Review state</span>
              <AppSelect v-model="closeoutDetails.review_state" :disabled="isConcluded || isSharingFocusResult">
                <option
                  v-for="option in reviewStateOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
            </label>
            <label>
              <span>Blockers</span>
              <AppSelect v-model="closeoutDetails.blocker_state" :disabled="isConcluded || isSharingFocusResult">
                <option
                  v-for="option in blockerStateOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
            </label>
            <label>
              <span>Parent task next</span>
              <AppSelect v-model="closeoutDetails.parent_task_next" :disabled="isConcluded || isSharingFocusResult">
                <option
                  v-for="option in parentTaskNextOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </option>
              </AppSelect>
            </label>
            <label>
              <span>Next owner</span>
              <input
                v-model="closeoutDetails.next_owner"
                :disabled="isConcluded || isSharingFocusResult"
                placeholder="Agent, human, or reviewer responsible next"
              />
            </label>
          </div>
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
      </div>
    </section>

    <div class="focus-layout">
      <section class="focus-list">
        <div v-if="!isFocusRoom" class="focus-section-card adhoc-card">
          <form class="focus-adhoc" @submit.prevent="submitAdHocFocusRoom">
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
        </div>

        <div v-if="!isFocusRoom" class="focus-section-card category-card">
          <div class="focus-section-header">
            <div>
              <h3>Open Focus Rooms</h3>
              <p>Select a room to inspect its live work record.</p>
            </div>
            <span class="focus-badge">{{ openFocusRooms.length }}</span>
          </div>

          <div class="focus-card-list">
            <div v-if="openFocusRooms.length === 0" class="focus-empty compact">
              <h4>No open Focus Rooms</h4>
              <p>Open one from a task when the work needs a dedicated room.</p>
            </div>

            <button
              v-for="focusRoom in openFocusRooms"
              :key="focusRoom.room_id"
              class="focus-task focus-room-link"
              :data-selected="selectedFocusRoom?.room_id === focusRoom.room_id"
              :aria-pressed="selectedFocusRoom?.room_id === focusRoom.room_id"
              :aria-label="`Inspect ${focusRoom.display_name} room audit details`"
              aria-controls="focus-room-detail-panel"
              type="button"
              @click="selectFocusRoom(focusRoom)"
            >
              <div>
                <strong>{{ focusRoom.display_name }}</strong>
                <span>{{ focusRoom.source_task_id || 'No linked task yet' }}</span>
              </div>
              <small>{{ focusRoom.focus_status || 'active' }}</small>
            </button>
          </div>
        </div>

        <div v-if="!isFocusRoom && concludedFocusRooms.length > 0" class="focus-section-card category-card">
          <div class="focus-section-header">
            <div>
              <h3>Shared results</h3>
              <p>Concluded rooms kept as parent-room audit evidence.</p>
            </div>
            <span class="focus-badge">{{ concludedFocusRooms.length }}</span>
          </div>

          <div class="focus-card-list">
            <button
              v-for="focusRoom in concludedFocusRooms"
              :key="focusRoom.room_id"
              class="focus-task focus-room-link"
              data-concluded="true"
              :data-selected="selectedFocusRoom?.room_id === focusRoom.room_id"
              :aria-pressed="selectedFocusRoom?.room_id === focusRoom.room_id"
              :aria-label="`Inspect ${focusRoom.display_name} shared result details`"
              aria-controls="focus-room-detail-panel"
              type="button"
              @click="selectFocusRoom(focusRoom)"
            >
              <div>
                <strong>{{ focusRoom.display_name }}</strong>
                <span>{{ focusRoom.conclusion_summary || focusRoom.source_task_id || focusRoom.room_id }}</span>
              </div>
              <small>concluded</small>
            </button>
          </div>
        </div>

        <div class="focus-section-card category-card">
          <div class="focus-section-header">
            <div>
              <h3>Focus candidates</h3>
              <p>Large, noisy, or multi-agent work belongs here.</p>
            </div>
            <span class="focus-badge">{{ candidateTasks.length }}</span>
          </div>

          <div class="focus-card-list">
            <div v-if="candidateTasks.length === 0" class="focus-empty">
              <h4>No open tasks yet</h4>
              <p>Add a task or branch a room from an idea.</p>
            </div>

            <button
              v-for="task in candidateTasks"
              :key="task.id"
              class="focus-task"
              :data-selected="!selectedFocusRoom && task.id === currentTask?.id"
              :aria-pressed="!selectedFocusRoom && task.id === currentTask?.id"
              aria-controls="focus-room-detail-panel"
              type="button"
              @click="selectTask(task.id)"
            >
              <div>
                <strong>{{ task.title }}</strong>
                <span>{{ task.description || task.id }}</span>
              </div>
              <small>{{ taskStatusLabel(task.status) }}</small>
            </button>
          </div>
        </div>
      </section>

      <aside
        id="focus-room-detail-panel"
        class="focus-detail"
        role="region"
        :aria-label="selectedFocusRoom ? 'Focus room audit details' : 'Focus task details'"
      >
        <Transition name="focus-detail-swap" mode="out-in">
          <div v-if="selectedFocusRoom" :key="selectedFocusRoom.room_id" class="focus-detail-inner">
            <div class="focus-detail-header">
              <p class="focus-eyebrow">Room audit</p>
              <span class="focus-room-state" :data-state="selectedFocusRoom.focus_status || 'active'">
                {{ selectedFocusRoom.focus_status || 'active' }}
              </span>
            </div>
            <h4>{{ selectedFocusRoom.display_name }}</h4>
            <p class="focus-detail-copy">
              {{ selectedFocusRoomDetailCopy }}
            </p>

            <dl class="focus-facts">
              <div>
                <dt>Source task</dt>
                <dd>{{ selectedFocusRoom.source_task_id || 'Ad-hoc room' }}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{{ formatAuditTime(selectedFocusRoom.created_at) }}</dd>
              </div>
              <div>
                <dt>Concluded</dt>
                <dd>{{ selectedFocusRoom.concluded_at ? formatAuditTime(selectedFocusRoom.concluded_at) : 'Not concluded yet' }}</dd>
              </div>
              <div>
                <dt>Focus key</dt>
                <dd>{{ selectedFocusRoom.focus_key || 'Not assigned' }}</dd>
              </div>
              <div>
                <dt>Room id</dt>
                <dd>{{ selectedFocusRoom.room_id }}</dd>
              </div>
              <div>
                <dt>Parent visibility</dt>
                <dd>{{ parentVisibilityLabel(selectedFocusRoomSettings.parent_visibility) }}</dd>
              </div>
              <div>
                <dt>Activity scope</dt>
                <dd>{{ activityScopeLabel(selectedFocusRoomSettings.activity_scope) }}</dd>
              </div>
              <div>
                <dt>Code routing</dt>
                <dd>{{ githubRoutingLabel(selectedFocusRoomSettings.github_event_routing) }}</dd>
              </div>
            </dl>

            <section class="focus-audit-card">
              <p class="focus-eyebrow">Outcome</p>
              <p>{{ selectedFocusRoom.conclusion_summary || 'No result summary has been shared back yet.' }}</p>
            </section>

            <section v-if="selectedFocusRoom.conclusion_details" class="focus-audit-card">
              <p class="focus-eyebrow">Closeout record</p>
              <dl class="focus-closeout-facts">
                <div>
                  <dt>Artifact</dt>
                  <dd>{{ selectedFocusRoom.conclusion_details.artifact }}</dd>
                </div>
                <div>
                  <dt>Review</dt>
                  <dd>{{ reviewStateLabel(selectedFocusRoom.conclusion_details.review_state) }}</dd>
                </div>
                <div>
                  <dt>Blockers</dt>
                  <dd>{{ blockerStateLabel(selectedFocusRoom.conclusion_details.blocker_state) }}</dd>
                </div>
                <div>
                  <dt>Parent next</dt>
                  <dd>{{ parentTaskNextLabel(selectedFocusRoom.conclusion_details.parent_task_next) }}</dd>
                </div>
                <div>
                  <dt>Next owner</dt>
                  <dd>{{ selectedFocusRoom.conclusion_details.next_owner }}</dd>
                </div>
              </dl>
            </section>

            <section class="focus-audit-card">
              <p class="focus-eyebrow">Audit trail</p>
              <ul class="focus-audit-list">
                <li>{{ selectedFocusRoom.source_task_id ? 'Linked to a parent task.' : 'Created from an ad-hoc intent.' }}</li>
                <li>{{ selectedFocusRoom.focus_status === 'concluded' ? 'Outcome has been shared or saved.' : 'Still open for work.' }}</li>
                <li>{{ parentVisibilityLabel(selectedFocusRoomSettings.parent_visibility) }} controls parent-room updates.</li>
              </ul>
            </section>

            <button
              class="focus-primary"
              type="button"
              @click="openSelectedFocusRoom"
            >
              Open Focus Room
            </button>
            <p class="focus-note">
              Room cards select details first. Use this explicit action when you want to enter the room.
            </p>
          </div>

          <div v-else-if="currentTask" :key="currentTask.id" class="focus-detail-inner">
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
                <dt>Parent room</dt>
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
                  <p class="focus-eyebrow">Sharing</p>
                  <h4>What the parent room sees</h4>
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
                  <span>Parent room</span>
                  <AppSelect v-model="settingsDraft.parent_visibility" :disabled="isUpdatingFocusSettings">
                    <option
                      v-for="option in parentVisibilityOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </AppSelect>
                  <small>{{ parentVisibilityDescription }}</small>
                </label>
                <label>
                  <span>What counts</span>
                  <AppSelect v-model="settingsDraft.activity_scope" :disabled="isUpdatingFocusSettings">
                    <option
                      v-for="option in activityScopeOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </AppSelect>
                  <small>{{ activityScopeDescription }}</small>
                </label>
                <label>
                  <span>Code updates</span>
                  <AppSelect v-model="settingsDraft.github_event_routing" :disabled="isUpdatingFocusSettings">
                    <option
                      v-for="option in githubEventRoutingOptions"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </AppSelect>
                  <small>{{ githubEventRoutingDescription }}</small>
                </label>
              </div>
            </form>

            <button
              class="focus-primary"
              type="button"
              :disabled="isFocusRoom || isCreatingFocusRoom"
              @click="currentFocusRoom ? emit('openFocusRoom', focusRoomOpenKey(currentFocusRoom) || currentTask.id) : emit('createFocusRoom', currentTask.id)"
            >
              {{ actionLabel }}
            </button>
            <p class="focus-note">
              {{ actionNote }}
            </p>
          </div>

          <div v-else key="empty" class="focus-detail-inner">
            <p class="focus-eyebrow">No task selected</p>
            <h4>Choose a task to focus.</h4>
            <p class="focus-detail-copy">
              Start from the board or pick a candidate here.
            </p>
          </div>
        </Transition>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AppSelect } from '@/components/ui'
import {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
  type FocusActivityScope,
  type FocusRoomBlockerState,
  type FocusRoomConclusionDetails,
  type FocusGitHubEventRouting,
  type FocusRoomParentTaskNextAction,
  type FocusRoomReviewState,
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
  conclusionDetails: FocusRoomConclusionDetails | null
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
  shareResults: [summary: string, details: FocusRoomConclusionDetails | null]
  updateFocusSettings: [focusKey: string, settings: FocusRoomSettings]
}>()

const resultSummary = ref('')
const shareAttempted = ref(false)
const settingsDraft = ref<FocusRoomSettings>({ ...DEFAULT_FOCUS_ROOM_SETTINGS })
const closeoutDetails = ref<FocusRoomConclusionDetails>(createEmptyCloseoutDetails())
const adHocTitle = ref('')
const adHocAttempted = ref(false)
const selectedFocusRoomId = ref<string | null>(null)

const parentVisibilityOptions: Array<{ value: FocusParentVisibility; label: string }> = [
  { value: 'summary_only', label: 'Only the final note' },
  { value: 'major_activity', label: 'Important updates' },
  { value: 'all_activity', label: 'Every update' },
  { value: 'silent', label: 'Nothing automatic' },
]
const activityScopeOptions: Array<{ value: FocusActivityScope; label: string }> = [
  { value: 'task_and_branch', label: 'Task and linked code' },
  { value: 'task_only', label: 'This task only' },
  { value: 'room', label: 'Everything in this room' },
]
const githubEventRoutingOptions: Array<{ value: FocusGitHubEventRouting; label: string }> = [
  { value: 'task_and_branch', label: 'Related code activity' },
  { value: 'focus_owned_only', label: 'Keep related code here' },
  { value: 'task_only', label: 'Only task mentions' },
  { value: 'all_parent_repo', label: 'All repo activity' },
  { value: 'off', label: 'No code activity' },
]
const reviewStateOptions: Array<{ value: FocusRoomReviewState; label: string }> = [
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'not_required', label: 'Review not required' },
]
const blockerStateOptions: Array<{ value: FocusRoomBlockerState; label: string }> = [
  { value: 'none', label: 'No blockers' },
  { value: 'resolved', label: 'Blockers resolved' },
  { value: 'blocked', label: 'Still blocked' },
]
const parentTaskNextOptions: Array<{ value: FocusRoomParentTaskNextAction; label: string }> = [
  { value: 'keep_open', label: 'Keep open' },
  { value: 'move_to_review', label: 'Move to review' },
  { value: 'mark_blocked', label: 'Mark blocked' },
  { value: 'mark_done', label: 'Mark done' },
  { value: 'follow_up', label: 'Create follow-up' },
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

const selectedFocusRoom = computed(() =>
  selectedFocusRoomId.value
    ? props.focusRooms.find(room => room.room_id === selectedFocusRoomId.value) ?? null
    : null
)

const selectedFocusRoomSettings = computed(() =>
  selectedFocusRoom.value
    ? focusRoomSettingsFrom(selectedFocusRoom.value)
    : DEFAULT_FOCUS_ROOM_SETTINGS
)

const selectedFocusRoomDetailCopy = computed(() => {
  const room = selectedFocusRoom.value
  if (!room) return ''
  if (room.focus_status === 'concluded') {
    return 'This Focus Room is closed; review the outcome before relying on the parent-room summary.'
  }
  return 'This Focus Room is still active; inspect the record first, then enter the room when you need the live thread.'
})

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
const conclusionDetails = computed(() => props.conclusionDetails)
const requiresCloseoutDetails = computed(() => props.isFocusRoom && Boolean(props.sourceTaskId))
const closeoutDetailsComplete = computed(() =>
  closeoutDetails.value.artifact.trim().length > 0 &&
  closeoutDetails.value.next_owner.trim().length > 0
)
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
  !isConcluded.value &&
  !props.isSharingFocusResult &&
  resultSummary.value.trim().length > 0 &&
  (!requiresCloseoutDetails.value || closeoutDetailsComplete.value)
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
  if (shareAttempted.value && requiresCloseoutDetails.value && !closeoutDetailsComplete.value) {
    return 'Add the artifact and next owner before concluding this task room.'
  }
  if (settingsDraft.value.parent_visibility === 'silent') {
    return 'Conclude this Focus Room without posting the summary into the parent room.'
  }
  return requiresCloseoutDetails.value
    ? 'Close the loop with artifact, review state, blocker state, parent task next step, and next owner.'
    : 'Send a concise outcome to the parent room.'
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
      return 'Keep the parent quiet unless you share an outcome yourself.'
    case 'all_activity':
      return 'Let every update appear in the parent room.'
    case 'major_activity':
      return 'Share only task, pull request, and completion milestones.'
    case 'summary_only':
    default:
      return 'Share only the outcome you write when the room is done.'
  }
})
const activityScopeDescription = computed(() => {
  switch (settingsDraft.value.activity_scope) {
    case 'room':
      return 'Use the whole room conversation to decide what belongs here.'
    case 'task_only':
      return 'Use only the source task to decide what belongs here.'
    case 'task_and_branch':
    default:
      return 'Use the task plus linked branches, PRs, reviews, and checks.'
  }
})
const githubEventRoutingDescription = computed(() => {
  switch (settingsDraft.value.github_event_routing) {
    case 'off':
      return 'Hide code activity from this Focus Room.'
    case 'focus_owned_only':
      return 'Keep matching PRs, reviews, and checks here without echoing them to the parent.'
    case 'all_parent_repo':
      return 'Show every code update from the parent repository here.'
    case 'task_only':
      return 'Show only code updates that name this task.'
    case 'task_and_branch':
    default:
      return 'Show code updates for this task and its linked code.'
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
  () => props.conclusionDetails,
  (details) => {
    closeoutDetails.value = details ? { ...details } : createEmptyCloseoutDetails()
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

watch(
  () => props.focusRooms,
  (rooms) => {
    if (selectedFocusRoomId.value && !rooms.some(room => room.room_id === selectedFocusRoomId.value)) {
      selectedFocusRoomId.value = null
    }
  }
)

function submitShareResults() {
  shareAttempted.value = true
  const trimmedSummary = resultSummary.value.trim()
  if (
    !trimmedSummary ||
    isConcluded.value ||
    props.isSharingFocusResult ||
    (requiresCloseoutDetails.value && !closeoutDetailsComplete.value)
  ) return
  const details = requiresCloseoutDetails.value
    ? {
        ...closeoutDetails.value,
        artifact: closeoutDetails.value.artifact.trim(),
        next_owner: closeoutDetails.value.next_owner.trim(),
      }
    : null
  emit('shareResults', trimmedSummary, details)
}

function createEmptyCloseoutDetails(): FocusRoomConclusionDetails {
  return {
    artifact: '',
    review_state: 'needs_review',
    blocker_state: 'none',
    parent_task_next: 'keep_open',
    next_owner: '',
  }
}

function submitFocusSettings() {
  const target = settingsTarget.value
  if (!target?.focusKey || !canSaveSettings.value) return
  emit('updateFocusSettings', target.focusKey, { ...settingsDraft.value })
}

function parentVisibilityLabel(value: FocusParentVisibility): string {
  return parentVisibilityOptions.find(option => option.value === value)?.label || 'Only the final note'
}

function submitAdHocFocusRoom() {
  adHocAttempted.value = true
  const trimmedTitle = adHocTitle.value.trim()
  if (!trimmedTitle || props.isCreatingAdHocFocusRoom) return
  emit('createAdHocFocusRoom', trimmedTitle)
}

function selectFocusRoom(focusRoom: FocusRoomInfo) {
  selectedFocusRoomId.value = focusRoom.room_id
}

function selectTask(taskId: string) {
  selectedFocusRoomId.value = null
  emit('selectTask', taskId)
}

function focusRoomOpenKey(focusRoom: FocusRoomInfo): string {
  return focusRoom.focus_key || focusRoom.source_task_id || focusRoom.room_id
}

function openSelectedFocusRoom() {
  if (!selectedFocusRoom.value) return
  emit('openFocusRoom', focusRoomOpenKey(selectedFocusRoom.value))
}

function activityScopeLabel(value: FocusActivityScope): string {
  return activityScopeOptions.find(option => option.value === value)?.label || 'Task and linked code'
}

function githubRoutingLabel(value: FocusGitHubEventRouting): string {
  return githubEventRoutingOptions.find(option => option.value === value)?.label || 'Related code activity'
}

function reviewStateLabel(value: FocusRoomReviewState): string {
  return reviewStateOptions.find(option => option.value === value)?.label || value
}

function blockerStateLabel(value: FocusRoomBlockerState): string {
  return blockerStateOptions.find(option => option.value === value)?.label || value
}

function parentTaskNextLabel(value: FocusRoomParentTaskNextAction): string {
  return parentTaskNextOptions.find(option => option.value === value)?.label || value
}

function taskStatusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

function formatAuditTime(value: string | null | undefined): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
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
  margin-bottom: 14px;
}

.focus-hero-copy,
.focus-section-card,
.focus-detail {
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: var(--bg-card, #131316);
  border-radius: 8px;
  letter-spacing: 0;
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

.focus-context-header h4,
.focus-panel-header h4,
.focus-adhoc h4,
.focus-detail h4,
.focus-empty h4 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-weight: 700;
}

.focus-hero p,
.focus-context-header p,
.focus-panel-header p,
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

.focus-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.focus-section-card,
.focus-detail {
  padding: 14px;
}

.adhoc-card {
  padding: 16px 20px;
}

.category-card {
  display: flex;
  flex-direction: column;
  padding: 20px;
}

.focus-adhoc {
  display: grid;
  gap: 10px;
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

.focus-context-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin-bottom: 20px;
}

.focus-context-header {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: var(--bg-card, #131316);
  letter-spacing: 0;
}

.focus-context-header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
}

.focus-context-title h4 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-weight: 700;
}

.focus-metadata-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

.focus-metadata-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.78rem;
  color: var(--text-tertiary, #a1a1aa);
  background: var(--bg-0, #09090b);
  border: 1px solid var(--line, #27272a);
  padding: 5px 12px;
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.focus-metadata-item strong {
  color: var(--text-secondary, #d4d4d8);
  font-weight: 700;
  font-size: 0.72rem;
  text-transform: uppercase;
  flex-shrink: 0;
}

.focus-context-header[data-concluded="true"] {
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.02);
}

.focus-context-actions {
  display: flex;
  flex-shrink: 0;
}

.focus-context-panels {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
}

.focus-settings-form,
.focus-share-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  background: var(--bg-card, #131316);
  letter-spacing: 0;
}

.focus-settings-form.compact {
  padding: 14px;
  margin: 0 0 14px;
  background: rgba(255, 255, 255, 0.02);
}

.focus-panel-header,
.focus-settings-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.focus-panel-header h4,
.focus-settings-heading h4 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 0.92rem;
}

.focus-panel-header .focus-eyebrow,
.focus-settings-heading .focus-eyebrow {
  margin-bottom: 4px;
}

.focus-panel-header .focus-secondary,
.focus-settings-heading .focus-secondary {
  flex-shrink: 0;
}

.focus-settings-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
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

.focus-settings-grid :deep(.app-select__control) {
  --app-select-border: var(--line, #27272a);
  --app-select-bg: var(--bg-0, #09090b);
  --app-select-text: var(--text, #fafafa);
  --app-select-focus: rgba(96, 165, 250, 0.28);
  --app-select-radius: 8px;
}

.focus-settings-grid small {
  color: var(--muted, #71717a);
  font-size: 0.68rem;
  line-height: 1.42;
}

.focus-share-label {
  display: none;
}

.focus-result-textarea {
  flex-grow: 1;
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

.focus-result-textarea:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.focus-closeout-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(96, 165, 250, 0.05), transparent 42%),
    var(--bg-0, #09090b);
}

.focus-closeout-grid label {
  display: grid;
  gap: 6px;
}

.focus-closeout-grid label:first-child,
.focus-closeout-grid label:last-child {
  grid-column: 1 / -1;
}

.focus-closeout-grid span {
  color: var(--text, #fafafa);
  font-size: 0.72rem;
  font-weight: 800;
}

.focus-closeout-grid input {
  width: 100%;
  min-height: 38px;
  padding: 9px 10px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.82rem;
}

.focus-closeout-grid :deep(.app-select__control) {
  --app-select-border: var(--line, #27272a);
  --app-select-bg: rgba(255, 255, 255, 0.02);
  --app-select-text: var(--text, #fafafa);
  --app-select-focus: rgba(96, 165, 250, 0.28);
  --app-select-radius: 8px;
}

.focus-share-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: auto;
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
  margin-bottom: 16px;
}

.focus-section-header h3 {
  margin: 0;
  color: var(--text-primary, #ffffff);
  font-size: 1.15rem;
  font-weight: 700;
  letter-spacing: 0;
}

.focus-badge {
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
  letter-spacing: 0;
}

.focus-card-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.focus-task {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid rgba(255, 255, 255, 0.04);
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  color: var(--text-secondary, #d4d4d8);
  cursor: pointer;
  text-align: left;
  transition:
    border-color 220ms ease,
    background 220ms ease,
    box-shadow 220ms ease,
    color 180ms ease,
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
  letter-spacing: 0;
  animation: focus-card-rise 360ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

.focus-task:hover,
.focus-task[data-selected="true"] {
  border-color: rgba(96, 165, 250, 0.45);
  background: rgba(96, 165, 250, 0.06);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.focus-task[data-selected="true"] {
  background:
    linear-gradient(135deg, rgba(96, 165, 250, 0.14), rgba(96, 165, 250, 0.04)),
    rgba(255, 255, 255, 0.02);
  box-shadow:
    0 12px 24px rgba(0, 0, 0, 0.22),
    inset 3px 0 0 rgba(96, 165, 250, 0.8);
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
  letter-spacing: 0;
}

.focus-detail {
  position: sticky;
  top: 0;
  align-self: start;
  overflow: hidden;
}

.focus-detail-inner {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.focus-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.focus-room-state {
  flex-shrink: 0;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.12);
  color: #93c5fd;
  font-size: 0.65rem;
  font-weight: 900;
  letter-spacing: 0;
  text-transform: uppercase;
}

.focus-room-state[data-state="concluded"] {
  background: rgba(34, 197, 94, 0.14);
  color: #86efac;
}

.focus-facts {
  display: grid;
  gap: 8px;
  margin: 14px 0;
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

.focus-audit-card {
  display: grid;
  gap: 8px;
  margin: 0 0 14px;
  padding: 12px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background:
    radial-gradient(circle at top right, rgba(96, 165, 250, 0.08), transparent 44%),
    var(--bg-0, #09090b);
}

.focus-audit-card p {
  margin: 0;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.8rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.focus-audit-card .focus-eyebrow {
  margin: 0;
}

.focus-audit-list {
  display: grid;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.focus-audit-list li {
  position: relative;
  padding-left: 14px;
  color: var(--text-tertiary, #a1a1aa);
  font-size: 0.78rem;
  line-height: 1.45;
}

.focus-audit-list li::before {
  content: "";
  position: absolute;
  top: 0.65em;
  left: 0;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: #60a5fa;
  transform: translateY(-50%);
}

.focus-closeout-facts {
  display: grid;
  gap: 8px;
  margin: 0;
}

.focus-closeout-facts div {
  display: grid;
  gap: 4px;
}

.focus-closeout-facts dt {
  color: var(--muted, #71717a);
  font-size: 0.66rem;
  font-weight: 800;
  text-transform: uppercase;
}

.focus-closeout-facts dd {
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
  transition:
    opacity 160ms ease,
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
    box-shadow 180ms ease;
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
  transform: translateY(-1px);
  box-shadow: 0 10px 22px rgba(96, 165, 250, 0.14);
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
  border: 1px dashed var(--line, #27272a);
  border-radius: 8px;
}

.focus-detail-swap-enter-active,
.focus-detail-swap-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}

.focus-detail-swap-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.99);
}

.focus-detail-swap-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.99);
}

@keyframes focus-card-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .focus-task,
  .focus-primary,
  .focus-detail-swap-enter-active,
  .focus-detail-swap-leave-active {
    animation: none;
    transition: none;
  }

  .focus-task:hover,
  .focus-task[data-selected="true"],
  .focus-primary:hover {
    transform: none;
  }
}

@media (max-width: 860px) {
  .focus-context-header,
  .focus-layout {
    grid-template-columns: 1fr;
  }

  .focus-context-panels {
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
  .focus-section-card,
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
  .focus-panel-header,
  .focus-closeout-grid,
  .focus-settings-grid {
    grid-template-columns: 1fr;
  }

  .focus-closeout-grid label:first-child,
  .focus-closeout-grid label:last-child {
    grid-column: auto;
  }

  .focus-settings-heading,
  .focus-panel-header {
    align-items: stretch;
    flex-direction: column;
  }

  .focus-share-footer .focus-primary {
    width: 100%;
  }
}
</style>
