<template>
  <section class="focus-context-container">
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
          <strong>Parent room</strong> {{ parentVisibilityLabel(settings.parent_visibility) }}
        </span>
      </div>
    </div>

    <div class="focus-context-panels">
      <FocusSettingsForm
        v-if="showSettings"
        v-model:settings="settings"
        title="Choose what the parent room can see."
        :submit-label="settingsButtonLabel"
        :can-submit="canSaveSettings"
        :disabled="isUpdatingFocusSettings"
        :parent-visibility-description="parentVisibilityDescription"
        :activity-scope-description="activityScopeDescription"
        :github-event-routing-description="githubEventRoutingDescription"
        @submit="emit('submitSettings')"
      />

      <FocusShareForm
        v-model:summary="summary"
        v-model:details="details"
        :is-concluded="isConcluded"
        :is-sharing="isSharingFocusResult"
        :placeholder="sharePlaceholder"
        :show-closeout-details="showCloseoutDetails"
        :help-text="shareHelpText"
        :submit-label="shareButtonLabel"
        :can-submit="canShareResults"
        @submit="emit('shareResults')"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import type {
  FocusRoomConclusionDetails,
  FocusRoomSettings,
} from '@/composables/useRoom'
import { parentVisibilityLabel } from './options'
import FocusSettingsForm from './FocusSettingsForm.vue'
import FocusShareForm from './FocusShareForm.vue'

defineProps<{
  sourceTaskId: string | null
  roomAddress: string
  isConcluded: boolean
  focusContextCopy: string
  focusStatusLabel: string
  showSettings: boolean
  canSaveSettings: boolean
  settingsButtonLabel: string
  isUpdatingFocusSettings: boolean
  parentVisibilityDescription: string
  activityScopeDescription: string
  githubEventRoutingDescription: string
  isSharingFocusResult: boolean
  sharePlaceholder: string
  showCloseoutDetails: boolean
  shareHelpText: string
  shareButtonLabel: string
  canShareResults: boolean
}>()

const emit = defineEmits<{
  openParentRoom: []
  submitSettings: []
  shareResults: []
}>()

const settings = defineModel<FocusRoomSettings>('settings', { required: true })
const summary = defineModel<string>('summary', { required: true })
const details = defineModel<FocusRoomConclusionDetails>('details', { required: true })
</script>
