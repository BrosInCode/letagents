<template>
  <RoomAuthGate
    v-if="roomAccessState !== 'authorized'"
    :checking="roomAccessState === 'checking'"
    :loading="auth.isSigningIn.value"
    @signIn="handleSignIn"
  />

  <div v-else class="room-shell" :data-theme="theme" :data-compact-viewport="compactViewport" :style="roomViewportStyle">
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
      ref="roomHeader"
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
      :messagesLoaded="messagesLoaded"
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
      :creation-error="creationError"
      :created-room="createdRoom"
      :creatingFocusRoomTaskId="creatingFocusRoomTaskId"
      :creatingAdHocFocusRoom="creatingAdHocFocusRoom"
      :sharingFocusResult="sharingFocusResult"
      :updatingFocusSettings="updatingFocusSettings"
      :selectedBoardTaskId="selectedBoardTaskId"
      :loadActivityHistory="loadActivityHistory"
      :clearDisconnectedParticipants="clearDisconnectedParticipants"
      @loadOlder="loadOlderMessages"
      @reply="selectedReply = $event"
      @thread-messages="threadImageMessages = $event"
      @openImageViewer="openImageViewer"
      @toggleStalePromptMute="handleToggleStalePromptMute"
      @addTask="handleAddTask"
      @updateTask="handleUpdateTask"
      @closeTask="clearBoardTask"
      @leaseAction="handleTaskLeaseAction"
      @reviewLeaseAction="handleTaskReviewLeaseAction"
      @focusTask="handleFocusTask"
      @openTask="openBoardTask"
      @selectFocusTask="focusDraftTaskId = $event"
      @createAdHocFocusRoom="handleCreateAdHocFocusRoom"
      @openFocusRoom="handleOpenFocusRoom"
      @openParentRoom="handleOpenParentRoom"
      @retryCreatedRoom="retryCreatedRoom"
      @shareResults="handleShareFocusResults"
      @updateFocusSettings="handleUpdateFocusSettings"
      @openChat="handleActiveTabChange('chat')"
    >
      <template #thread-composer="{ parent, quote, clearQuote, sent }">
        <Composer v-if="isConnected" :inline-thread="true" :thread-root-id="parent.id" :sender-name="senderName"
          :room-identifier="room?.identifier || ''" :attachments-enabled="room?.attachmentsEnabled !== false"
          :submit-message="(text, kind, reply, files) => handleThreadSend(parent.id, text, kind, reply, files, sent)"
          :stage-attachment-draft="stageAttachmentUpload" :discard-attachment-draft="discardAttachmentUpload"
          :reply-to="quote" :messages="messages" :presence="presence" :participants="participants"
          :refresh-reachability="refreshRoomReachability" :is-signed-in="auth.isSignedIn.value"
          @clear-reply="clearQuote" @sign-in="handleSignIn" />
      </template>
    </RoomTabPanels>

    <Composer
      v-if="activeTab === 'chat' && isConnected"
      :senderName="senderName"
      :roomIdentifier="room?.identifier || ''"
      :attachmentsEnabled="room?.attachmentsEnabled !== false"
      :submitMessage="handleSend"
      :createTask="addTask"
      :openSearch="openComposerSearch"
      :stageAttachmentDraft="stageAttachmentUpload"
      :discardAttachmentDraft="discardAttachmentUpload"
      :replyTo="selectedReply"
      :messages="messages"
      :presence="presence"
      :presenceReady="presenceLoaded"
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
import { provideRoomMessageMotion } from "../../../../shared/ui/useRoomMessageMotion";
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import { getGitHubSupportIdentifier } from '@/composables/room/data'
import { provideRoomMessageLinkPreviews, useRoomMessageLinkPreviews } from '@/composables/roomMessageLinkPreviews'
import { provideRoomMessagePins, useRoomMessagePins } from '@/composables/roomMessagePins'
import { provideRoomMessageReactions, useRoomMessageReactions } from '@/composables/roomMessageReactions'
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
import { isValidMessageId } from '@/domain/roomRoutes'
import { apiFetch, roomPath } from '@/composables/room/api'
import { isVisibleRoomMessage } from '@/composables/room/identity'
import type {
  OutgoingMessageAttachment,
  RoomMessage,
} from '@/composables/useRoom'

const route = useRoute()
const router = useRouter()
const {
  messages,
  messagesHasOlder,
  messagesLoaded,
  isLoadingOlderMessages,
  tasks,
  focusRooms,
  presence,
  presenceLoaded,
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
provideRoomMessagePins(useRoomMessagePins(computed(() => room.value?.identifier || ''), (message) => toast.error(message)))
provideRoomMessageReactions(useRoomMessageReactions(
  computed(() => room.value?.identifier || ''),
  (message) => toast.error(message),
))
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
const roomViewportStyle = ref<Record<string, string>>({})
const compactViewport = ref(false)

function syncRoomViewport() {
  const viewport = window.visualViewport
  // The software keyboard can resize only the visual viewport. Keep the
  // composer above it without reflowing the room during pinch-to-zoom.
  if (!viewport || viewport.scale !== 1) return
  compactViewport.value = viewport.height < 360
  roomViewportStyle.value = {
    '--room-viewport-height': `${viewport.height}px`,
    '--room-viewport-top': `${viewport.offsetTop}px`,
  }
}

onMounted(() => {
  syncRoomViewport()
  window.visualViewport?.addEventListener('resize', syncRoomViewport)
  window.visualViewport?.addEventListener('scroll', syncRoomViewport)
})

onUnmounted(() => {
  messagePermalinkRequestId += 1
  window.visualViewport?.removeEventListener('resize', syncRoomViewport)
  window.visualViewport?.removeEventListener('scroll', syncRoomViewport)
})

const searchQuery = ref('')
const roomHeader = ref<InstanceType<typeof RoomHeader> | null>(null)
function openComposerSearch(query: string): boolean {
  if (!roomHeader.value?.openSearch()) return false
  searchQuery.value = query
  return true
}
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
const threadImageMessages = ref<RoomMessage[]>([])
watch(() => room.value?.identifier, () => { threadImageMessages.value = [] })
const imageMessages = computed(() => [...new Map([...threadImageMessages.value, ...messages.value].map(message => [message.id, message])).values()])
const {
  activeImageId,
  roomImages,
  openImageViewer,
  closeImageViewer,
  showNextImage,
  showPreviousImage,
} = useRoomImages(imageMessages)

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

function clearBoardTask() {
  if (route.query.task) void router.replace({ query: { ...route.query, task: undefined } })
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
provideRoomMessageLinkPreviews(useRoomMessageLinkPreviews(computed(() => room.value?.identifier || ''), computed(() => getGitHubSupportIdentifier(room.value))))
const {
  focusDraftTaskId,
  creatingFocusRoomTaskId,
  creationError,
  createdRoom,
  retryCreatedRoom,
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

const messageMotion = provideRoomMessageMotion(() => room.value?.identifier)

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
  const sent = await sendMessage(text, senderName.value, agentPromptKind, replyTo, attachments, threadRootId, messageMotion.confirmation(text))
  if (sent) {
    selectedReply.value = null
    return true
  }
  toast.error(lastSendError.value || 'Message could not be sent.')
  return false
}

async function handleThreadSend(rootId: string, text: string, kind: string | null,
  replyTo: string | null, attachments: OutgoingMessageAttachment[] = [], complete: (quoteId: string | null) => void): Promise<boolean> {
  const sendingRoom = room.value
  const sent = await sendMessage(text, senderName.value, kind, replyTo || rootId, attachments, rootId)
  if (room.value !== sendingRoom) return sent
  if (sent) complete(replyTo)
  else toast.error(lastSendError.value || 'Reply could not be sent.')
  return sent
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

let messagePermalinkRequestId = 0

async function handleMessagePermalink(messageId: string) {
  if (!isValidMessageId(messageId)) return
  const currentRoomId = room.value?.identifier
  const routeRoomId = route.params.roomId
  if (!currentRoomId || (room.value?.requestedIdentifier ?? currentRoomId) !== routeRoomId
    || route.query.message !== messageId) return
  const requestId = ++messagePermalinkRequestId

  let preflightNotFound = false
  try {
    const response = await apiFetch(`${roomPath(currentRoomId)}/messages/${encodeURIComponent(messageId)}`)
    const targetMessage = (response?.message ?? response) as RoomMessage | null
    if (!targetMessage || !isVisibleRoomMessage(targetMessage)) {
      preflightNotFound = true
    }
  } catch (error: any) {
    if (error?.status === 404) {
      preflightNotFound = true
    }
  }

  if (requestId !== messagePermalinkRequestId
    || room.value?.identifier !== currentRoomId
    || route.params.roomId !== routeRoomId
    || route.query.message !== messageId) return

  if (preflightNotFound) {
    toast.info('That message is not available.')
    void router.replace({ query: { ...route.query, message: undefined } })
    return
  }

  setActiveTab('chat')
  roomTabPanelsRef.value?.openMessageInChat(messageId)
  void router.replace({ query: { ...route.query, message: undefined } })
}

watch(
  [() => route.query.message, isConnected, messagesLoaded, () => route.params.roomId],
  ([messageQuery, connected, loaded]) => {
    messagePermalinkRequestId += 1
    if (!connected || !loaded || typeof messageQuery !== 'string' || !isValidMessageId(messageQuery)) return
    void handleMessagePermalink(messageQuery)
  },
  { immediate: true, flush: 'sync' },
)
</script>

<style scoped>
.room-shell {
  position: fixed;
  top: var(--room-viewport-top, 0px);
  inset-inline: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  height: 100vh;
  height: var(--room-viewport-height, 100dvh);
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
}

.room-shell[data-compact-viewport="true"] :deep(.chat-header) { min-height: 44px; padding-block: 0; }
.room-shell[data-compact-viewport="true"] :deep(.chat-title p) { display: none; }
.room-shell[data-compact-viewport="true"] :deep(.mobile-bottom-nav) { height: calc(48px + env(safe-area-inset-bottom, 0px)); }

</style>
