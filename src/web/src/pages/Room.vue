<template>
  <RoomAuthGate
    v-if="roomAccessState !== 'authorized'"
    :checking="roomAccessState === 'checking'"
    :loading="auth.isSigningIn.value"
    @signIn="handleSignIn"
  />

  <div v-else class="room-shell" :data-theme="theme">
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
      :gitRoom="room?.gitRoom || null"
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

    <RoomTabPanels
      v-if="isConnected"
      ref="roomTabPanelsRef"
      :activeTab="activeTab"
      :tabTransitionName="tabTransitionName"
      :messages="messages"
      :messagesHasOlder="messagesHasOlder"
      :isLoadingOlderMessages="isLoadingOlderMessages"
      :tasks="tasks"
      :focusRooms="focusRooms"
      :presence="presence"
      :boardHandoffPresence="boardHandoffPresence"
      :participants="participants"
      :reasoningSessions="reasoningSessions"
      :participantHiddenCount="participantHiddenCount"
      :activityHistory="activityHistory"
      :activityHistoryLoading="activityHistoryLoading"
      :activityHistoryError="activityHistoryError"
      :roomArtifacts="roomArtifacts"
      :taskGithubStatus="taskGithubStatus"
      :githubEvents="githubEvents"
      :githubEventsAvailable="githubEventsAvailable"
      :githubEventsHasMore="githubEventsHasMore"
      :githubEventsError="githubEventsError"
      :githubEventsSupported="githubEventsSupported"
      :githubEventsLoading="githubEventsLoading"
      :activityLoading="activityLoading"
      :room="room"
      :searchQuery="searchQuery"
      :stalePromptTaskStates="stalePromptTaskStates"
      :githubEventsRepository="githubEventsRepository"
      :focusDraftTaskId="focusDraftTaskId"
      :roomTitle="roomTitle"
      :focusParentAddress="focusParentAddress"
      :focusSettings="focusSettings"
      :creatingFocusRoomTaskId="creatingFocusRoomTaskId"
      :creatingAdHocFocusRoom="creatingAdHocFocusRoom"
      :sharingFocusResult="sharingFocusResult"
      :updatingFocusSettings="updatingFocusSettings"
      :selectedBoardTaskId="selectedBoardTaskId"
      :loadActivityHistory="loadActivityHistory"
      :clearDisconnectedParticipants="clearDisconnectedParticipants"
      @loadOlder="loadOlderMessages"
      @reply="selectedReply = $event"
      @openImageViewer="openImageViewer"
      @toggleStalePromptMute="handleToggleStalePromptMute"
      @addTask="handleAddTask"
      @updateTask="handleUpdateTask"
      @leaseAction="handleTaskLeaseAction"
      @reviewLeaseAction="handleTaskReviewLeaseAction"
      @focusTask="handleFocusTask"
      @openTask="openBoardTask"
      @selectFocusTask="focusDraftTaskId = $event"
      @createAdHocFocusRoom="handleCreateAdHocFocusRoom"
      @openFocusRoom="handleOpenFocusRoom"
      @openParentRoom="handleOpenParentRoom"
      @shareResults="handleShareFocusResults"
      @updateFocusSettings="handleUpdateFocusSettings"
    />

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
import { messageThreadParentId } from '@/components/room/messageThreading'
import RoomConnectionError from './room/RoomConnectionError.vue'
import RoomAuthGate from './room/RoomAuthGate.vue'
import RoomMobileNav from './room/RoomMobileNav.vue'
import RoomTabPanels from './room/RoomTabPanels.vue'
import { resolveRoomAccessState } from './room/roomAuth'
import Composer from '@/components/room/Composer.vue'
import { useFocusRoomNavigation } from './room/useFocusRoomNavigation'
import { useRoomImages } from './room/useRoomImages'
import { useRoomPresentation } from './room/useRoomPresentation'
import { useRoomTabs } from './room/useRoomTabs'
import { useRoomTaskHandlers } from './room/useRoomTaskHandlers'
import { useToast } from '@/composables/useToast'
import type {
  OutgoingMessageAttachment,
  RoomMessage,
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
  roomArtifacts,
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
  leaveRoom,
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
const roomSessionValidated = ref(false)
const roomAuthLifecycleReady = ref(false)

const roomAccessState = computed(() => resolveRoomAccessState({
  hasCheckedSession: roomSessionValidated.value && auth.hasCheckedSession.value,
  isCheckingSession: auth.isCheckingSession.value,
  isSignedIn: auth.isSignedIn.value,
}))

const drawerOpen = ref(false)
const rulesBoardOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchQuery = ref('')
const roomTabPanelsRef = ref<InstanceType<typeof RoomTabPanels> | null>(null)
const selectedReply = ref<RoomMessage | null>(null)
const selectedBoardTaskId = computed(() => {
  const taskId = typeof route.query.task === 'string' ? route.query.task : ''
  return tasks.value.some(task => task.id === taskId) ? taskId : null
})
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

const matchCount = computed(() => roomTabPanelsRef.value?.matchCount ?? 0)

function openBoardTask(taskId: string) {
  setActiveTab('board')
  void router.push({
    query: {
      ...route.query,
      view: 'board',
      task: taskId,
    },
  })
}
const {
  senderName,
  roomTitle,
  rulesBoardAvailable,
  roomSubtitle,
  focusParentAddress,
  githubEventsRepository,
  focusSettings,
  showGitHubSignIn,
  joinErrorTitle,
  joinErrorBody,
  stalePromptTaskStates,
} = useRoomPresentation({
  room,
  tasks,
  joinError,
  connectionState,
  authUser: auth.user,
})
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
const {
  handleAddTask,
  handleTaskLeaseAction,
  handleTaskReviewLeaseAction,
  handleToggleStalePromptMute,
  handleUpdateTask,
} = useRoomTaskHandlers({
  addTask,
  updateTask,
  updateTaskLease,
  updateTaskReviewLease,
  setTaskStalePromptMute,
  toast,
})

function openRulesFromDrawer() {
  drawerOpen.value = false
  rulesBoardOpen.value = true
}

async function handleSend(
  text: string,
  agentPromptKind: string | null,
  replyTo: string | null,
  attachments: OutgoingMessageAttachment[] = [],
): Promise<boolean> {
  // Replying to a message that lives inside a thread keeps the reply in that
  // thread; replying to a top-level message stays a quote-reply by design.
  const replyTarget = replyTo && selectedReply.value?.id === replyTo ? selectedReply.value : null
  const threadRootId = replyTarget ? messageThreadParentId(replyTarget) : null
  const sent = await sendMessage(text, senderName.value, agentPromptKind, replyTo, attachments, threadRootId)
  if (sent) {
    selectedReply.value = null
    return true
  }
  toast.error(lastSendError.value || 'Message could not be sent.')
  return false
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
  roomSessionValidated.value = true

  if (!auth.isSignedIn.value) {
    leaveRoom()
    roomAuthLifecycleReady.value = true
    return
  }

  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  } else {
    await restoreSession()
  }

  if (auth.isSignedIn.value) {
    applyRouteTab(route.query.view)
  } else {
    leaveRoom()
  }
  roomAuthLifecycleReady.value = true
})

watch(() => route.params.roomId, async (newId) => {
  selectedReply.value = null
  if (!auth.isSignedIn.value) return

  if (newId) {
    await joinRoom(newId as string)
  }

  applyRouteTab(route.query.view)
})

watch(() => auth.isSignedIn.value, async (signedIn, wasSignedIn) => {
  if (!roomAuthLifecycleReady.value || !auth.hasCheckedSession.value || signedIn === wasSignedIn) return

  if (!signedIn) {
    drawerOpen.value = false
    rulesBoardOpen.value = false
    selectedReply.value = null
    leaveRoom()
    return
  }

  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  } else {
    await restoreSession()
  }
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

@media (max-width: 768px) {
  .room-shell { height: 100dvh; }
}
</style>
