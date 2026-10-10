<template>
  <div class="room-view-viewport">
    <div v-if="activeTab === 'chat' && historySearch.state.value.status !== 'idle'" class="room-history-search">
      <MessageSearchResults
        :status="historySearch.state.value.status"
        :hits="historySearch.hits.value"
        :terms="historySearch.state.value.terms"
        :has-more="historySearch.state.value.hasMore"
        :loading-more="historySearch.state.value.loadingMore"
        :error="historySearch.state.value.error"
        :loaded-match-count="matchCount"
        :format-time="formatMessageTime"
        @show="openMessageInChat"
        @more="historySearch.loadMore()"
      />
    </div>
    <PinnedMessages v-if="activeTab === 'chat' && messagePins" :key="room?.identifier" :pins="messagePins.state.value.pins"
      :loading="messagePins.state.value.loading" :error="messagePins.state.value.error"
      @refresh="messagePins.refresh" @reveal="openMessageInChat" />
    <Transition :name="tabTransitionName">
      <MessageList
        v-if="activeTab === 'chat'"
        key="chat"
        ref="messageListRef"
        class="room-tab-panel"
        :messages="messages"
        :roomIdentifier="room?.identifier || ''"
        :unreadRoomId="room?.projectId || ''"
        :reasoningSessions="reasoningSessions"
        :presence="presence"
        :hasOlderMessages="messagesHasOlder"
        :messagesLoaded="messagesLoaded"
        :isLoadingOlderMessages="isLoadingOlderMessages"
        :searchQuery="searchQuery"
        :stalePromptTaskStates="stalePromptTaskStates"
        :taskReferenceIds="taskReferenceIds"
        :revealMessageId="revealMessageId"
        :agentNames="agentNames"
        @loadOlder="emit('loadOlder')"
        @reply="emit('reply', $event)"
        @thread-messages="emit('threadMessages', $event)"
        @openImageViewer="emit('openImageViewer', $event)"
        @toggleStalePromptMute="emit('toggleStalePromptMute', $event)"
        @openTask="emit('openTask', $event)"
        @revealed="handleMessageRevealed"
        @revealUnavailable="handleMessageRevealUnavailable"
      >
        <template #thread-composer="context"><slot name="thread-composer" v-bind="context" /></template>
      </MessageList>

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
        @closeTask="emit('closeTask')"
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
        @openMessage="openMessageInChat"
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
        :creation-error="creationError"
        :created-room="createdRoom"
        :isCreatingFocusRoom="creatingFocusRoomTaskId !== null"
        :isCreatingAdHocFocusRoom="creatingAdHocFocusRoom"
        :isSharingFocusResult="sharingFocusResult"
        :isUpdatingFocusSettings="updatingFocusSettings"
        @selectTask="emit('selectFocusTask', $event)"
        @createFocusRoom="emit('focusTask', $event)"
        @createAdHocFocusRoom="emit('createAdHocFocusRoom', $event)"
        @openFocusRoom="emit('openFocusRoom', $event)"
        @openParentRoom="emit('openParentRoom')"
        @retryCreatedRoom="emit('retryCreatedRoom')"
        @shareResults="emitShareResults"
        @updateFocusSettings="emitUpdateFocusSettings"
      />
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { onScopeDispose } from "vue";
import { useRoomUnread } from "@/composables/roomUnread";
import PinnedMessages from '../../../../../shared/ui/PinnedMessages.vue'
import { injectRoomMessagePins } from '@/composables/roomMessagePins'
import { computed, nextTick, ref, watch } from 'vue'

import ActivityView from '@/components/room/ActivityView.vue'
import FocusRoomsView from '@/components/room/FocusRoomsView.vue'
import GitHubEventFeed from '@/components/room/GitHubEventFeed.vue'
import MessageList from '@/components/room/MessageList.vue'
import { attentionResponseAgentNames, formatMessageTime } from '@/components/room/chat-message/formatting'
import MessageSearchResults from '../../../../../shared/ui/MessageSearchResults.vue'
import { useRoomHistorySearch } from '@/composables/roomHistorySearch'
import { useToast } from '@/composables/useToast'
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
  TaskUpdatePayload,
} from './types'

const props = defineProps<{
  activeTab: RoomTab
  tabTransitionName: string
  messages: readonly RoomMessage[]
  messagesHasOlder: boolean
  messagesLoaded?: boolean
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
  creationError: string | null
  createdRoom: { id: string; title: string } | null
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
  threadMessages: [messages: RoomMessage[]]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  addTask: [title: string]
  updateTask: [payload: TaskUpdatePayload]
  closeTask: []
  leaseAction: [payload: TaskLeaseActionPayload]
  reviewLeaseAction: [payload: TaskReviewLeaseActionPayload]
  focusTask: [taskId: string]
  selectFocusTask: [taskId: string]
  createAdHocFocusRoom: [title: string]
  openFocusRoom: [focusKey: string]
  openParentRoom: []
  retryCreatedRoom: []
  shareResults: [summary: string, details: FocusRoomConclusionDetails | null]
  updateFocusSettings: [focusKey: string, settings: FocusRoomSettings]
  openTask: [taskId: string]
  openChat: []
}>()

const messagePins = injectRoomMessagePins()
const roomUnread = useRoomUnread();
watch(() => props.room?.projectId, roomUnread.enter, { immediate: true, flush: "sync" });
onScopeDispose(() => roomUnread.enter(null));

const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const matchCount = computed(() => messageListRef.value?.matchCount ?? 0)
const taskReferenceIds = computed<ReadonlySet<string>>(() =>
  new Set(props.tasks.map(task => task.id))
)
// Messages name agents by room display name, never by their routing handle.
const agentNames = computed(() => attentionResponseAgentNames([...props.participants, ...props.presence]))

// A message another tab asked to show; the chat reveals it once it is open.
const revealMessageId = ref<string | null>(null)

function openMessageInChat(messageId: string) {
  if (revealMessageId.value === messageId) {
    revealMessageId.value = null
    void nextTick(() => {
      revealMessageId.value = messageId
      emit('openChat')
    })
    return
  }
  revealMessageId.value = messageId
  emit('openChat')
}

function handleMessageRevealed(messageId: string) {
  if (revealMessageId.value === messageId) revealMessageId.value = null
}

// Every match in the room's history, while the header search has a query.
const historySearch = useRoomHistorySearch(
  computed(() => props.room?.identifier || ''),
  computed(() => props.searchQuery),
)
const toast = useToast()
function handleMessageRevealUnavailable(_messageId: string, reason?: 'too_far_back' | 'unavailable') {
  if (props.searchQuery) {
    toast.info('That message is too far back to open here. Expand the search result to read it.', 5000)
    return
  }
  if (reason === 'unavailable' || !props.messagesHasOlder) {
    toast.info('That earlier message is not available in the loaded room history.')
  } else {
    toast.info('That message is too far back to open here yet.')
  }
}

watch(() => props.activeTab, (tab) => {
  if (tab !== 'chat') revealMessageId.value = null
})
watch(() => props.room?.identifier, () => {
  revealMessageId.value = null
})

function emitShareResults(summary: string, details: FocusRoomConclusionDetails | null) {
  emit('shareResults', summary, details)
}

function emitUpdateFocusSettings(focusKey: string, settings: FocusRoomSettings) {
  emit('updateFocusSettings', focusKey, settings)
}

defineExpose({ matchCount, openMessageInChat })
</script>

<style scoped>
.room-view-viewport {
  display: flex;
  flex-direction: column;
  position: relative;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

/* Drops down from the header search, over the top of the message list. */
.room-history-search {
  position: absolute;
  top: 8px;
  left: 12px;
  right: 12px;
  z-index: 5;
  display: flex;
  max-width: 720px;
  max-height: min(46%, 380px);
  margin: 0 auto;
  padding: 10px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
}

.room-history-search > .history-search {
  flex: 1;
}

.room-tab-panel {
  flex: 1;
  min-width: 0;
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
