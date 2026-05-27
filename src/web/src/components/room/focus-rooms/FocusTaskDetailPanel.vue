<template>
  <div class="focus-detail-inner">
    <p class="focus-eyebrow">Selected task</p>
    <h4>{{ task.title }}</h4>
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
        <dd>{{ taskStatusLabel(task.status) }}</dd>
      </div>
      <div>
        <dt>Share back</dt>
        <dd>{{ shareBackLabel }}</dd>
      </div>
      <div v-if="currentFocusRoom">
        <dt>Parent room</dt>
        <dd>{{ parentVisibilityLabel(settings.parent_visibility) }}</dd>
      </div>
    </dl>

    <FocusSettingsForm
      v-if="showSettings"
      v-model:settings="settings"
      compact
      title="What the parent room sees"
      :submit-label="settingsButtonLabel"
      :can-submit="canSaveSettings"
      :disabled="isUpdatingFocusSettings"
      :parent-visibility-description="parentVisibilityDescription"
      :activity-scope-description="activityScopeDescription"
      :github-event-routing-description="githubEventRoutingDescription"
      @submit="emit('submitSettings')"
    />

    <button
      class="focus-primary"
      type="button"
      :disabled="isFocusRoom || isCreatingFocusRoom"
      @click="emit('primaryAction')"
    >
      {{ actionLabel }}
    </button>
    <p class="focus-note">
      {{ actionNote }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type {
  FocusRoomInfo,
  FocusRoomSettings,
  RoomTask,
} from '@/composables/useRoom'
import {
  parentVisibilityLabel,
  taskStatusLabel,
} from './options'
import FocusSettingsForm from './FocusSettingsForm.vue'

defineProps<{
  task: RoomTask
  roomLabel: string
  shareBackLabel: string
  currentFocusRoom: FocusRoomInfo | null
  showSettings: boolean
  canSaveSettings: boolean
  settingsButtonLabel: string
  isUpdatingFocusSettings: boolean
  parentVisibilityDescription: string
  activityScopeDescription: string
  githubEventRoutingDescription: string
  isFocusRoom: boolean
  isCreatingFocusRoom: boolean
  actionLabel: string
  actionNote: string
}>()

const emit = defineEmits<{
  submitSettings: []
  primaryAction: []
}>()

const settings = defineModel<FocusRoomSettings>('settings', { required: true })
</script>
