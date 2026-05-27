<template>
  <div class="focus-rooms-panel">
    <section class="focus-hero">
      <div class="focus-hero-copy">
        <p class="focus-eyebrow">Rooms</p>
        <h2>Give bigger work a quieter room.</h2>
        <p>Keep the main room clear while agents go deep on one task.</p>
      </div>
    </section>

    <FocusCurrentRoomPanel
      v-if="isFocusRoom"
      v-model:settings="settingsDraft"
      v-model:summary="resultSummary"
      v-model:details="closeoutDetails"
      :source-task-id="sourceTaskId"
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

    <div class="focus-layout">
      <section class="focus-list">
        <FocusAdHocForm
          v-if="!isFocusRoom"
          v-model:title="adHocTitle"
          :attempted="adHocAttempted"
          :is-creating="isCreatingAdHocFocusRoom"
          :can-submit="canCreateAdHocFocusRoom"
          :submit-label="adHocButtonLabel"
          @submit="submitAdHocFocusRoom"
        />

        <FocusRoomListSection
          v-if="!isFocusRoom"
          title="Open Focus Rooms"
          description="Select a room to inspect its live work record."
          empty-title="No open Focus Rooms"
          empty-description="Open one from a task when the work needs a dedicated room."
          show-when-empty
          :rooms="openFocusRooms"
          :selected-room-id="selectedFocusRoomId"
          @select="selectFocusRoomById"
        />

        <FocusRoomListSection
          v-if="!isFocusRoom"
          title="Shared results"
          description="Concluded rooms kept as parent-room audit evidence."
          empty-title=""
          empty-description=""
          concluded
          :rooms="concludedFocusRooms"
          :selected-room-id="selectedFocusRoomId"
          @select="selectFocusRoomById"
        />

        <FocusTaskListSection
          :tasks="candidateTasks"
          :selected-task-id="currentTask?.id ?? null"
          :has-selected-focus-room="Boolean(selectedFocusRoom)"
          @select="selectTask"
        />
      </section>

      <aside
        id="focus-room-detail-panel"
        class="focus-detail"
        role="region"
        :aria-label="selectedFocusRoom ? 'Focus room audit details' : 'Focus task details'"
      >
        <Transition name="focus-detail-swap" mode="out-in">
          <FocusRoomDetailPanel
            v-if="selectedFocusRoom"
            :key="selectedFocusRoom.room_id"
            :room="selectedFocusRoom"
            :settings="selectedFocusRoomSettings"
            :detail-copy="selectedFocusRoomDetailCopy"
            @open-focus-room="openSelectedFocusRoom"
          />

          <FocusTaskDetailPanel
            v-else-if="currentTask"
            :key="currentTask.id"
            v-model:settings="settingsDraft"
            :task="currentTask"
            :room-label="roomLabel"
            :share-back-label="shareBackLabel"
            :current-focus-room="currentFocusRoom"
            :show-settings="Boolean(settingsTarget)"
            :can-save-settings="canSaveSettings"
            :settings-button-label="settingsButtonLabel"
            :is-updating-focus-settings="isUpdatingFocusSettings"
            :parent-visibility-description="parentVisibilityDescription"
            :activity-scope-description="activityScopeDescription"
            :github-event-routing-description="githubEventRoutingDescription"
            :is-focus-room="isFocusRoom"
            :is-creating-focus-room="isCreatingFocusRoom"
            :action-label="actionLabel"
            :action-note="actionNote"
            @submit-settings="submitFocusSettings"
            @primary-action="openCurrentTaskFocusRoom"
          />

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
import FocusAdHocForm from './focus-rooms/FocusAdHocForm.vue'
import FocusCurrentRoomPanel from './focus-rooms/FocusCurrentRoomPanel.vue'
import FocusRoomDetailPanel from './focus-rooms/FocusRoomDetailPanel.vue'
import FocusRoomListSection from './focus-rooms/FocusRoomListSection.vue'
import FocusTaskDetailPanel from './focus-rooms/FocusTaskDetailPanel.vue'
import FocusTaskListSection from './focus-rooms/FocusTaskListSection.vue'
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
  adHocTitle,
  adHocAttempted,
  selectedFocusRoomId,
  candidateTasks,
  openFocusRooms,
  concludedFocusRooms,
  selectedFocusRoom,
  selectedFocusRoomSettings,
  selectedFocusRoomDetailCopy,
  currentTask,
  currentFocusRoom,
  settingsTarget,
  isConcluded,
  showCloseoutDetails,
  focusStatusLabel,
  focusContextCopy,
  sharePlaceholder,
  canShareResults,
  shareButtonLabel,
  shareHelpText,
  canCreateAdHocFocusRoom,
  adHocButtonLabel,
  shareBackLabel,
  actionLabel,
  actionNote,
  canSaveSettings,
  settingsButtonLabel,
  parentVisibilityDescription,
  activityScopeDescription,
  githubEventRoutingDescription,
  submitShareResults,
  submitFocusSettings,
  submitAdHocFocusRoom,
  selectFocusRoomById,
  selectTask,
  openSelectedFocusRoom,
  openCurrentTaskFocusRoom,
} = useFocusRoomsViewModel(props, emit)
</script>

<style src="./focus-rooms/FocusRoomsView.css"></style>
