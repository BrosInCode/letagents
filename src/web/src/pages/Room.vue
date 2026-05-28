<template>
  <div class="room-shell" :data-theme="theme">
    <!-- Drawer -->
    <RoomDrawer
      :open="drawerOpen"
      :room="room"
      :messages="messages"
      :senderName="senderName"
      :showRulesButton="rulesBoardAvailable"
      @close="drawerOpen = false"
      @themeChange="theme = $event"
      @openRules="openRulesFromDrawer"
    />

    <RoomHeader
      :title="roomTitle"
      :subtitle="roomSubtitle"
      :activeTab="activeTab"
      :connectionState="connectionState"
      :searchQuery="searchQuery"
      :matchCount="matchCount"
      :canRename="room?.role === 'admin'"
      :showEventsTab="githubEventsSupported"
      @toggleDrawer="drawerOpen = !drawerOpen"
      @update:activeTab="handleActiveTabChange"
      @update:searchQuery="searchQuery = $event"
      @rename="handleRename"
    />

    <RoomRulesBoard
      v-if="rulesBoardAvailable"
      :open="rulesBoardOpen"
      :tasks="tasks"
      @close="rulesBoardOpen = false"
    />

    <RoomConnectionError
      v-if="connectionState === 'error' && !isConnected"
      :title="joinErrorTitle"
      :body="joinErrorBody"
      :showGitHubSignIn="showGitHubSignIn"
      @signIn="handleSignIn"
      @retry="retryJoin"
    />

    <div v-if="isConnected" class="room-view-viewport">
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
          @loadOlder="loadOlderMessages"
          @reply="selectedReply = $event"
          @openImageViewer="openImageViewer"
          @toggleStalePromptMute="handleToggleStalePromptMute"
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
          @addTask="handleAddTask"
          @updateTask="handleUpdateTask"
          @leaseAction="handleTaskLeaseAction"
          @reviewLeaseAction="handleTaskReviewLeaseAction"
          @focusTask="handleFocusTask"
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
          :sourceTaskId="room?.sourceTaskId || null"
          :focusKey="room?.focusKey || null"
          :focusStatus="room?.focusStatus || null"
          :focusSettings="{
            parent_visibility: room?.focusParentVisibility || 'summary_only',
            activity_scope: room?.focusActivityScope || 'task_and_branch',
            github_event_routing: room?.focusGitHubEventRouting || 'task_and_branch',
          }"
          :conclusionSummary="room?.conclusionSummary || null"
          :conclusionDetails="room?.conclusionDetails || null"
          :isCreatingFocusRoom="creatingFocusRoomTaskId !== null"
          :isCreatingAdHocFocusRoom="creatingAdHocFocusRoom"
          :isSharingFocusResult="sharingFocusResult"
          :isUpdatingFocusSettings="updatingFocusSettings"
          @selectTask="focusDraftTaskId = $event"
          @createFocusRoom="handleFocusTask"
          @createAdHocFocusRoom="handleCreateAdHocFocusRoom"
          @openFocusRoom="handleOpenFocusRoom"
          @openParentRoom="handleOpenParentRoom"
          @shareResults="handleShareFocusResults"
          @updateFocusSettings="handleUpdateFocusSettings"
        />
      </Transition>
    </div>

    <Composer
      v-if="activeTab === 'chat' && isConnected"
      :senderName="senderName"
      :roomIdentifier="room?.identifier || ''"
      :attachmentsEnabled="room?.attachmentsEnabled !== false"
      :submitMessage="handleSend"
      :stageAttachmentDraft="stageAttachmentUpload"
      :discardAttachmentDraft="discardAttachmentUpload"
      :replyTo="selectedReply"
      :messages="messages"
      :presence="presence"
      :participants="participants"
      :refreshReachability="refreshRoomReachability"
      :isSignedIn="auth.isSignedIn.value"
      @clearReply="selectedReply = null"
      @signIn="handleSignIn"
    />

    <ImageViewerModal
      v-if="activeImageId && roomImages.length"
      :images="roomImages"
      :activeImageId="activeImageId"
      @close="closeImageViewer"
      @next="showNextImage"
      @previous="showPreviousImage"
    />

    <RoomMobileNav
      v-if="isConnected"
      :activeTab="activeTab"
      :showEventsTab="githubEventsSupported"
      @update:activeTab="handleActiveTabChange"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import RoomHeader from '@/components/room/RoomHeader.vue'
import RoomDrawer from '@/components/room/RoomDrawer.vue'
import RoomRulesBoard from '@/components/room/RoomRulesBoard.vue'
import ImageViewerModal from '@/components/room/ImageViewerModal.vue'
import RoomConnectionError from './room/RoomConnectionError.vue'
import RoomMobileNav from './room/RoomMobileNav.vue'
import MessageList from '@/components/room/MessageList.vue'
import GitHubEventFeed from '@/components/room/GitHubEventFeed.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'
import ActivityView from '@/components/room/ActivityView.vue'
import FocusRoomsView from '@/components/room/FocusRoomsView.vue'
import { useFocusRoomNavigation } from './room/useFocusRoomNavigation'
import { useRoomImages } from './room/useRoomImages'
import { useRoomTabs } from './room/useRoomTabs'
import { useToast } from '@/composables/useToast'
import type {
  OutgoingMessageAttachment,
  RoomMessage,
  StalePromptTaskState,
} from '@/composables/useRoom'

const route = useRoute()
const router = useRouter()
const {
  messages,
  messagesHasOlder,
  isLoadingOlderMessages,
  tasks,
  focusRooms,
  presence,
  boardHandoffPresence,
  participants,
  reasoningSessions,
  participantHiddenCount,
  activityHistory,
  activityHistoryLoading,
  activityHistoryError,
  taskGithubStatus,
  githubEvents,
  githubEventsAvailable,
  githubEventsHasMore,
  githubEventsError,
  githubEventsSupported,
  githubEventsLoading,
  activityLoading,
  room,
  lastSendError,
  isConnected,
  connectionState,
  joinError,
  joinRoom,
  sendMessage,
  stageAttachmentUpload,
  discardAttachmentUpload,
  addTask,
  updateTask,
  updateTaskLease,
  updateTaskReviewLease,
  setTaskStalePromptMute,
  createFocusRoom,
  createAdHocFocusRoom,
  shareFocusRoomResult,
  updateFocusRoomSettings,
  restoreSession,
  renameRoom,
  loadOlderMessages,
  loadActivityHistory,
  clearDisconnectedParticipants,
  refreshRoomMessages,
  refreshRoomActivity,
  refreshRoomReachability,
  refreshRoomBoard,
  refreshRoomFocusRooms,
  refreshRoomGitHubEvents,
} = useRoom()
const auth = useAuth()
const toast = useToast()

const drawerOpen = ref(false)
const rulesBoardOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchQuery = ref('')
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const selectedReply = ref<RoomMessage | null>(null)
const {
  activeTab,
  tabTransitionName,
  applyRouteTab,
  handleActiveTabChange,
  setActiveTab,
  syncViewQuery,
} = useRoomTabs({
  route,
  router,
  githubEventsSupported,
  isConnected,
})
const {
  activeImageId,
  roomImages,
  openImageViewer,
  closeImageViewer,
  showNextImage,
  showPreviousImage,
} = useRoomImages(messages)

const matchCount = computed(() => messageListRef.value?.matchCount ?? 0)
const senderName = computed(() => auth.user.value?.login || 'anonymous')
const roomTitle = computed(() => room.value?.displayName || 'Connecting...')
const rulesBoardAvailable = computed(() => {
  const identifiers = [
    room.value?.projectId,
    room.value?.name,
    room.value?.parentRoomId,
  ]
  return identifiers.some(value => value?.startsWith('github.com/'))
})
const roomSubtitle = computed(() =>
  room.value?.kind === 'focus'
    ? `Focus Room: ${room.value.parentRoomId || 'parent'}${room.value.sourceTaskId ? ` / ${room.value.sourceTaskId}` : ''}`
    : room.value
    ? `Room: ${room.value.name}`
    : connectionState.value === 'connecting' ? 'Joining room...' : 'Create a new room or join one.'
)
const focusParentAddress = computed(() =>
  room.value?.kind === 'focus' && room.value.parentRoomId
    ? room.value.parentRoomId
    : room.value?.identifier || room.value?.name || ''
)
const {
  focusDraftTaskId,
  creatingFocusRoomTaskId,
  creatingAdHocFocusRoom,
  sharingFocusResult,
  updatingFocusSettings,
  handleFocusTask,
  handleCreateAdHocFocusRoom,
  handleOpenFocusRoom,
  handleOpenParentRoom,
  handleShareFocusResults,
  handleUpdateFocusSettings,
} = useFocusRoomNavigation({
  router,
  room,
  focusParentAddress,
  toast,
  createFocusRoom,
  createAdHocFocusRoom,
  shareFocusRoomResult,
  updateFocusRoomSettings,
  showRoomsTab() {
    setActiveTab('rooms')
    syncViewQuery('rooms', 'push')
  },
})

function openRulesFromDrawer() {
  drawerOpen.value = false
  rulesBoardOpen.value = true
}
const githubEventsRepository = computed(() =>
  room.value?.kind === 'focus' && room.value.parentRoomId
    ? room.value.parentRoomId
    : room.value?.name || room.value?.identifier || null
)
const showGitHubSignIn = computed(() => joinError.value?.code === 'NOT_AUTHENTICATED')
const joinErrorTitle = computed(() => {
  if (joinError.value?.code === 'NOT_AUTHENTICATED') {
    return 'GitHub sign-in required'
  }
  if (joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
    return 'No repo access'
  }
  return 'Could not connect to room.'
})
const joinErrorBody = computed(() => {
  if (joinError.value?.code === 'NOT_AUTHENTICATED') {
    return 'This repo-backed room requires GitHub sign-in before you can join.'
  }
  if (joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
    const login = auth.user.value?.login
    return login
      ? `Signed in as ${login}, but that account does not have access to this private repo room.`
      : 'Your current account does not have access to this private repo room.'
  }
  return joinError.value?.message || 'Could not connect to room.'
})
const stalePromptTaskStates = computed<Record<string, StalePromptTaskState>>(() =>
  Object.fromEntries(
    tasks.value.map(task => [task.id, {
      isStale: Boolean(task.stale_prompt_state?.is_stale),
      muted: Boolean(task.stale_prompt_state?.muted),
      taskUpdatedAt: task.updated_at,
    }])
  )
)

async function handleSend(
  text: string,
  agentPromptKind: string | null,
  replyTo: string | null,
  attachments: OutgoingMessageAttachment[] = [],
): Promise<boolean> {
  const sent = await sendMessage(text, senderName.value, agentPromptKind, replyTo, attachments)
  if (sent) {
    selectedReply.value = null
    return true
  }
  toast.error(lastSendError.value || 'Message could not be sent.')
  return false
}

async function handleAddTask(title: string) {
  await addTask(title)
}

async function handleUpdateTask(taskId: string, updates: { status: string }) {
  const updated = await updateTask(taskId, updates as any)
  if (!updated) {
    toast.error('Task status could not be updated.')
  }
}

async function handleTaskLeaseAction(payload: {
  taskId: string
  action: 'release' | 'handoff'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}) {
  try {
    const updated = await updateTaskLease(payload.taskId, {
      action: payload.action,
      lease_id: payload.lease_id ?? null,
      target_actor_key: payload.target_actor_key ?? null,
      target_actor_instance_id: payload.target_actor_instance_id ?? null,
      target_agent_session_id: payload.target_agent_session_id ?? null,
      reason: payload.reason ?? null,
    })
    if (!updated) {
      toast.error('Task lease could not be updated.')
    }
  } catch {
    toast.error('Task lease could not be updated.')
  } finally {
    payload.onSettled?.()
  }
}

async function handleTaskReviewLeaseAction(payload: {
  taskId: string
  action: 'assign' | 'release'
  lease_id?: string | null
  target_actor_key?: string | null
  target_actor_instance_id?: string | null
  target_agent_session_id?: string | null
  reason?: string | null
  onSettled?: () => void
}) {
  try {
    const updated = await updateTaskReviewLease(payload.taskId, {
      action: payload.action,
      lease_id: payload.lease_id ?? null,
      target_actor_key: payload.target_actor_key ?? null,
      target_actor_instance_id: payload.target_actor_instance_id ?? null,
      target_agent_session_id: payload.target_agent_session_id ?? null,
      reason: payload.reason ?? null,
    })
    if (!updated) {
      toast.error('Task review authority could not be updated.')
    }
  } catch {
    toast.error('Task review authority could not be updated.')
  } finally {
    payload.onSettled?.()
  }
}

async function handleToggleStalePromptMute(payload: {
  taskId: string
  muted: boolean
  promptTimestamp: string
}) {
  const updated = await setTaskStalePromptMute(payload.taskId, payload.muted, {
    promptTimestamp: payload.promptTimestamp,
  })
  if (!updated) {
    toast.error('Stale task reminder preference could not be updated.')
  }
}

async function handleRename() {
  const newName = prompt('Rename room:', room.value?.displayName || '')
  if (newName && newName.trim()) {
    await renameRoom(newName.trim())
  }
}

async function retryJoin() {
  const roomId = route.params.roomId as string
  if (roomId) await joinRoom(roomId)
}

async function handleSignIn() {
  await auth.signIn(route.fullPath || '/')
}

onMounted(async () => {
  await auth.checkSession()
  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  } else {
    await restoreSession()
  }

  applyRouteTab(route.query.view)
})

watch(() => route.params.roomId, async (newId) => {
  selectedReply.value = null
  if (newId) {
    await joinRoom(newId as string)
  }

  applyRouteTab(route.query.view)
})

watch(activeTab, async (tab) => {
  if (tab !== 'chat') {
    closeImageViewer()
  }

  if (!isConnected.value) return

  if (tab === 'chat') {
    await refreshRoomMessages()
    return
  }

  if (tab === 'events' && githubEventsSupported.value) {
    await refreshRoomGitHubEvents()
    return
  }

  if (tab === 'board') {
    await refreshRoomBoard()
    return
  }

  if (tab === 'activity') {
    await refreshRoomActivity()
    return
  }

  if (tab === 'rooms') {
    await refreshRoomFocusRooms()
  }
})

</script>

<style scoped>
.room-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
}

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

@media (max-width: 768px) {
  .room-shell { height: 100dvh; }
}
</style>
