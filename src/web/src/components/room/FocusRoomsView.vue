<template>
  <div class="focus-rooms-panel">
    <FocusCurrentRoomPanel
      v-if="isFocusRoom"
      v-model:settings="settingsDraft"
      v-model:summary="resultSummary"
      v-model:details="closeoutDetails"
      :source-task-id="sourceTaskId"
      :room-label="roomLabel"
      :git-room="gitRoom"
      :room-address="roomAddress"
      :is-concluded="isConcluded"
      :focus-context-copy="focusContextCopy"
      :focus-status-label="focusStatusLabel"
      :show-settings="Boolean(settingsTarget)"
      :can-save-settings="canSaveSettings"
      :settings-button-label="settingsButtonLabel"
      :is-updating-focus-settings="isUpdatingFocusSettings"
      :parent-visibility-description="parentVisibilityDescription"
      :activity-scope-description="activityScopeDescription"
      :github-event-routing-description="githubEventRoutingDescription"
      :is-sharing-focus-result="isSharingFocusResult"
      :share-placeholder="sharePlaceholder"
      :show-closeout-details="showCloseoutDetails"
      :share-help-text="shareHelpText"
      :share-button-label="shareButtonLabel"
      :can-share-results="canShareResults"
      @open-parent-room="emit('openParentRoom')"
      @submit-settings="submitFocusSettings"
      @share-results="submitShareResults"
    />

    <RoomsDirectory
      v-else
      :key="roomAddress"
      :rooms="directoryRooms"
      :tasks="directoryTasks"
      :parent-label="roomLabel"
      :initial-task-id="selectedTaskId"
      :busy="isCreatingFocusRoom || isCreatingAdHocFocusRoom"
      :error="creationError"
      :created-room="createdRoom"
      @retry-open="emit('retryCreatedRoom')"
      @open="openDirectoryRoom"
      @select="selectedFocusRoomId = $event"
      @create-topic="emit('createAdHocFocusRoom', $event)"
      @create-task="emit('createFocusRoom', $event)"
    >
      <template #details>
        <template v-if="selectedFocusRoom">
          <div class="rooms-detail-meta">
            <span
              >Created {{ formatAuditTime(selectedFocusRoom.created_at) }}</span
            >
            <span v-if="selectedFocusRoom.concluded_at"
              >Closed
              {{ formatAuditTime(selectedFocusRoom.concluded_at) }}</span
            >
            <span v-if="selectedFocusRoom.git_room"
              >{{ selectedFocusRoom.git_room.repository.full_name }} ·
              {{ gitRoomRefLabel(selectedFocusRoom.git_room) }}</span
            >
          </div>
          <section
            v-if="
              selectedFocusRoom.focus_status === 'concluded' ||
              selectedFocusRoom.conclusion_summary
            "
            class="rooms-detail-outcome"
          >
            <h3>Outcome</h3>
            <p>
              {{
                selectedFocusRoom.conclusion_summary ||
                'No outcome was recorded. You can still open the conversation.'
              }}
            </p>
            <p v-if="selectedFocusRoom.conclusion_details">
              <strong>Result:</strong>
              {{ selectedFocusRoom.conclusion_details.artifact }}<br /><strong
                >Next owner:</strong
              >
              {{ selectedFocusRoom.conclusion_details.next_owner }}
            </p>
          </section>
          <div class="rooms-detail-actions">
            <button
              class="rooms-button rooms-button-primary"
              type="button"
              @click="openDirectoryRoom(selectedFocusRoom.room_id)"
            >
              Open room <span aria-hidden="true">↗</span></button
            ><span
              v-if="selectedFocusRoom.focus_status !== 'concluded'"
              class="rooms-hint"
              >Finish the work and close this room from inside the
              conversation.</span
            >
          </div>
          <details
            v-if="settingsTarget?.focusKey"
            class="rooms-settings web-room-settings"
          >
            <summary>
              Room settings<span v-if="hasSettingsChanges">
                · Unsaved changes</span
              >
            </summary>
            <FocusSettingsForm
              v-model:settings="settingsDraft"
              title="Updates shared with the main room"
              :submit-label="settingsButtonLabel"
              :can-submit="canSaveSettings"
              :disabled="isUpdatingFocusSettings"
              :parent-visibility-description="parentVisibilityDescription"
              :activity-scope-description="activityScopeDescription"
              :github-event-routing-description="githubEventRoutingDescription"
              @submit="submitFocusSettings"
            />
          </details>
        </template>
      </template>
    </RoomsDirectory>
  </div>
</template>

<script setup lang="ts">
import RoomsDirectory from '../../../../../shared/rooms/RoomsDirectory.vue'
import FocusCurrentRoomPanel from './focus-rooms/FocusCurrentRoomPanel.vue'
import FocusSettingsForm from './focus-rooms/FocusSettingsForm.vue'
import { formatAuditTime, gitRoomRefLabel } from './focus-rooms/options'
import type {
  FocusRoomsViewEmit,
  FocusRoomsViewProps,
} from './focus-rooms/types'
import { useFocusRoomsViewModel } from './focus-rooms/useFocusRoomsViewModel'
const props = defineProps<FocusRoomsViewProps>()
const emit = defineEmits<FocusRoomsViewEmit>()
const {
  resultSummary,
  settingsDraft,
  closeoutDetails,
  selectedFocusRoomId,
  directoryRooms,
  directoryTasks,
  selectedFocusRoom,
  settingsTarget,
  isConcluded,
  showCloseoutDetails,
  focusStatusLabel,
  focusContextCopy,
  sharePlaceholder,
  canShareResults,
  shareButtonLabel,
  shareHelpText,
  hasSettingsChanges,
  canSaveSettings,
  settingsButtonLabel,
  parentVisibilityDescription,
  activityScopeDescription,
  githubEventRoutingDescription,
  submitShareResults,
  submitFocusSettings,
  openDirectoryRoom,
} = useFocusRoomsViewModel(props, emit)
</script>
<style src="./focus-rooms/FocusRoomsView.css"></style>
