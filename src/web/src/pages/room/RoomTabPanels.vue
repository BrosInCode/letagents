<template>
  <div class="room-view-viewport">
    <Transition :name="tabTransitionName">
      <MessageList
        v-if="activeTab === 'chat'"
        key="chat"
        ref="messageListRef"
        class="room-tab-panel"
        :messages="messages"
        :roomIdentifier="room?.identifier || ''"
        :reasoningSessions="reasoningSessions"
        :hasOlderMessages="messagesHasOlder"
        :isLoadingOlderMessages="isLoadingOlderMessages"
        :searchQuery="searchQuery"
        :stalePromptTaskStates="stalePromptTaskStates"
        :taskReferenceIds="taskReferenceIds"
        @loadOlder="emit('loadOlder')"
        @reply="emit('reply', $event)"
        @openImageViewer="emit('openImageViewer', $event)"
        @toggleStalePromptMute="emit('toggleStalePromptMute', $event)"
        @openTask="emit('openTask', $event)"
      />

      <GitHubEventFeed
        v-else-if="githubEventsSupported && activeTab === 'events'"
        key="events"
        class="room-tab-panel"
        :events="githubEvents"
        :repository="githubEventsRepository"
        :isAvailable="githubEventsAvailable"
        :hasMore="githubEventsHasMore"
        :errorMessage="githubEventsError?.message || null"
        :isLoading="githubEventsLoading"
      />

      <TaskBoard
        v-else-if="activeTab === 'board'"
        key="board"
        class="room-tab-panel"
        :tasks="tasks"
        :presence="boardHandoffPresence"
        :canManageLeases="room?.role === 'admin'"
        :taskGithubStatus="taskGithubStatus"
        :selectedTaskId="selectedBoardTaskId"
        :roomIdentifier="room?.identifier || null"
        @addTask="emit('addTask', $event)"
        @updateTask="emit('updateTask', $event)"
        @leaseAction="emit('leaseAction', $event)"
        @reviewLeaseAction="emit('reviewLeaseAction', $event)"
        @focusTask="emit('focusTask', $event)"
      />

      <ActivityView
        v-else-if="activeTab === 'activity'"
        key="activity"
        class="room-tab-panel"
        :roomIdentifier="room?.identifier || ''"
        :currentRoom="room"
        :focusRooms="focusRooms"
        :messages="messages"
        :participants="participants"
        :liveClearedCount="participantHiddenCount"
        :presence="presence"
        :reasoningSessions="reasoningSessions"
        :tasks="tasks"
        :activityHistory="activityHistory"
        :activityHistoryLoading="activityHistoryLoading"
        :activityHistoryError="activityHistoryError"
        :roomArtifacts="roomArtifacts"
        :canManageParticipants="room?.role === 'admin'"
        :loadActivityHistory="loadActivityHistory"
        :clearDisconnectedParticipants="clearDisconnectedParticipants"
        :taskGithubStatus="taskGithubStatus"
        :isLoading="activityLoading"
      />

      <FocusRoomsView
        v-else
        key="rooms"
        class="room-tab-panel"
        :tasks="tasks"
        :focusRooms="focusRooms"
        :selectedTaskId="focusDraftTaskId"
        :roomLabel="roomTitle"
        :roomAddress="focusParentAddress"
        :isFocusRoom="room?.kind === 'focus'"
        :gitRoom="room?.gitRoom || null"
        :sourceTaskId="room?.sourceTaskId || null"
        :focusKey="room?.focusKey || null"
        :focusStatus="room?.focusStatus || null"
        :focusSettings="focusSettings"
        :conclusionSummary="room?.conclusionSummary || null"
        :conclusionDetails="room?.conclusionDetails || null"
        :isCreatingFocusRoom="creatingFocusRoomTaskId !== null"
        :isCreatingAdHocFocusRoom="creatingAdHocFocusRoom"
        :isSharingFocusResult="sharingFocusResult"
        :isUpdatingFocusSettings="updatingFocusSettings"
        @selectTask="emit('selectFocusTask', $event)"
        @createFocusRoom="emit('focusTask', $event)"
        @createAdHocFocusRoom="emit('createAdHocFocusRoom', $event)"
        @openFocusRoom="emit('openFocusRoom', $event)"
        @openParentRoom="emit('openParentRoom')"
        @shareResults="emitShareResults"
        @updateFocusSettings="emitUpdateFocusSettings"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import ActivityView from '@/components/room/ActivityView.vue'
import FocusRoomsView from '@/components/room/FocusRoomsView.vue'
import GitHubEventFeed from '@/components/room/GitHubEventFeed.vue'
import MessageList from '@/components/room/MessageList.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'
import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettings,
  RoomActivityHistoryPage,
  RoomAgentPresence,
  RoomGitHubEvent,
  RoomInfo,
  RoomMessage,
  RoomParticipant,
  RoomReasoningSession,
  RoomSharedArtifact,
  RoomTask,
  StalePromptTaskState,
  TaskGitHubArtifactStatus,
} from '@/composables/useRoom'
import type { RoomGitHubEventsError } from '@/composables/roomGitHubEvents'
import type {
  RoomTab,
  TaskLeaseActionPayload,
  TaskReviewLeaseActionPayload,
  TaskStatusUpdatePayload,
} from './types'

const props = defineProps<{
  activeTab: RoomTab
  tabTransitionName: string
  messages: readonly RoomMessage[]
  messagesHasOlder: boolean
  isLoadingOlderMessages: boolean
  tasks: readonly RoomTask[]
  focusRooms: readonly FocusRoomInfo[]
  presence: readonly RoomAgentPresence[]
  boardHandoffPresence: readonly RoomAgentPresence[]
  participants: readonly RoomParticipant[]
  reasoningSessions: readonly RoomReasoningSession[]
  participantHiddenCount: number
  activityHistory: RoomActivityHistoryPage | null
  activityHistoryLoading: boolean
  activityHistoryError: string
  roomArtifacts: readonly RoomSharedArtifact[]
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  githubEvents: readonly RoomGitHubEvent[]
  githubEventsAvailable: boolean
  githubEventsHasMore: boolean
  githubEventsError: RoomGitHubEventsError | null
  githubEventsSupported: boolean
  githubEventsLoading: boolean
  activityLoading: boolean
  room: RoomInfo | null
  searchQuery: string
  stalePromptTaskStates: Readonly<Record<string, StalePromptTaskState>>
  githubEventsRepository: string | null
  focusDraftTaskId: string | null
  roomTitle: string
  focusParentAddress: string
  focusSettings: FocusRoomSettings
  creatingFocusRoomTaskId: string | null
  creatingAdHocFocusRoom: boolean
  sharingFocusResult: boolean
  updatingFocusSettings: boolean
  selectedBoardTaskId: string | null
  loadActivityHistory?: (options?: {
    query?: string
    page?: number
    pageSize?: number
    kind?: 'all' | 'agent' | 'human'
    roomId?: string
  }) => Promise<boolean>
  clearDisconnectedParticipants?: () => Promise<number>
}>()

const emit = defineEmits<{
  loadOlder: []
  reply: [message: RoomMessage]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  addTask: [title: string]
  updateTask: [payload: TaskStatusUpdatePayload]
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
  selectFocusTask: [taskId: string]
  createAdHocFocusRoom: [title: string]
  openFocusRoom: [focusKey: string]
  openParentRoom: []
  shareResults: [summary: string, details: FocusRoomConclusionDetails | null]
  updateFocusSettings: [focusKey: string, settings: FocusRoomSettings]
  openTask: [taskId: string]
}>()

const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const matchCount = computed(() => messageListRef.value?.matchCount ?? 0)
const taskReferenceIds = computed<ReadonlySet<string>>(() =>
  new Set(props.tasks.map(task => task.id))
)

function emitShareResults(summary: string, details: FocusRoomConclusionDetails | null) {
  emit('shareResults', summary, details)
}

function emitUpdateFocusSettings(focusKey: string, settings: FocusRoomSettings) {
  emit('updateFocusSettings', focusKey, settings)
}

defineExpose({ matchCount })
</script>

<style scoped>
.room-view-viewport {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.room-tab-panel {
  height: 100%;
  min-height: 0;
}

.tab-slide-forward-enter-active,
.tab-slide-forward-leave-active,
.tab-slide-back-enter-active,
.tab-slide-back-leave-active {
  transition: transform 240ms var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)), opacity 200ms ease;
}

.tab-slide-forward-leave-active,
.tab-slide-back-leave-active {
  position: absolute;
  inset: 0;
  width: 100%;
}

.tab-slide-forward-enter-from,
.tab-slide-back-leave-to {
  opacity: 0;
  transform: translateX(28px);
}

.tab-slide-forward-leave-to,
.tab-slide-back-enter-from {
  opacity: 0;
  transform: translateX(-28px);
}
</style>
