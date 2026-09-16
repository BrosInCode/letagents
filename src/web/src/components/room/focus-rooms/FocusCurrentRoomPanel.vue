<template>
  <section class="focus-context-container">
    <div class="focus-context-header" :data-concluded="isConcluded">
      <div class="focus-context-header-top">
        <div class="focus-context-title">
          <p class="focus-eyebrow">Room details</p>
          <h4>{{ roomDisplayTitle(roomLabel) }}</h4>
          <p>{{ focusContextCopy }}</p>
        </div>
        <div class="focus-context-actions">
          <button
            class="focus-secondary"
            type="button"
            @click="emit('openParentRoom')"
          >
            ← Back to main room
          </button>
        </div>
      </div>
      <div class="focus-metadata-bar">
        <span>{{ focusStatusLabel }}</span
        ><span v-if="gitRoom"
          >{{ gitRoom.repository.full_name }} ·
          {{ gitRoomRefLabel(gitRoom) }}</span
        ><span v-else>{{
          sourceTaskId
            ? 'Linked to a task in the main room'
            : 'Connected to the main room'
        }}</span>
      </div>
    </div>

    <div class="focus-context-panels">
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
      <details v-if="showSettings" class="rooms-settings web-room-settings">
        <summary>Room settings</summary>
        <FocusSettingsForm
          v-if="showSettings"
          v-model:settings="settings"
          title="Updates shared with the main room"
          :submit-label="settingsButtonLabel"
          :can-submit="canSaveSettings"
          :disabled="isUpdatingFocusSettings"
          :parent-visibility-description="parentVisibilityDescription"
          :activity-scope-description="activityScopeDescription"
          :github-event-routing-description="githubEventRoutingDescription"
          @submit="emit('submitSettings')"
        />
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import type {
  FocusRoomConclusionDetails,
  FocusRoomSettings,
  GitRoomInfo,
} from '@/composables/useRoom'
import { gitRoomRefLabel } from './options'
import FocusSettingsForm from './FocusSettingsForm.vue'
import FocusShareForm from './FocusShareForm.vue'
import { roomDisplayTitle } from '../../../../../../shared/rooms/directory'

defineProps<{
  gitRoom: GitRoomInfo | null
  sourceTaskId: string | null
  roomAddress: string
  roomLabel: string
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
const details = defineModel<FocusRoomConclusionDetails>('details', {
  required: true,
})
</script>
