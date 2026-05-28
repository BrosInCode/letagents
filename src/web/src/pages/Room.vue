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
import RoomConnectionError from './room/RoomConnectionError.vue'
import RoomMobileNav from './room/RoomMobileNav.vue'
import RoomTabPanels from './room/RoomTabPanels.vue'
import Composer from '@/components/room/Composer.vue'
import { useFocusRoomNavigation } from './room/useFocusRoomNavigation'
import { useRoomImages } from './room/useRoomImages'
import { useRoomPresentation } from './room/useRoomPresentation'
import { useRoomTabs } from './room/useRoomTabs'
import { useToast } from '@/composables/useToast'
import type {
  TaskLeaseActionPayload,
  TaskReviewLeaseActionPayload,
} from './room/types'
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
const roomTabPanelsRef = ref<InstanceType<typeof RoomTabPanels> | null>(null)
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

const matchCount = computed(() => roomTabPanelsRef.value?.matchCount ?? 0)
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

async function handleTaskLeaseAction(payload: TaskLeaseActionPayload) {
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

async function handleTaskReviewLeaseAction(payload: TaskReviewLeaseActionPayload) {
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

@media (max-width: 768px) {
  .room-shell { height: 100dvh; }
}
</style>
