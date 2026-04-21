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

    <div v-if="connectionState === 'error' && !isConnected" class="room-error">
      <p class="room-error-title">{{ joinErrorTitle }}</p>
      <p class="room-error-body">{{ joinErrorBody }}</p>
      <div class="room-error-actions">
        <button v-if="showGitHubSignIn" class="retry-btn" @click="handleSignIn">
          Sign in with GitHub
        </button>
        <button class="retry-btn secondary" @click="retryJoin">Retry</button>
      </div>
    </div>

    <div v-if="isConnected" class="room-view-viewport">
      <Transition :name="tabTransitionName">
        <MessageList
          v-if="activeTab === 'chat'"
          key="chat"
          ref="messageListRef"
          class="room-tab-panel"
          :messages="messages"
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
          :taskGithubStatus="taskGithubStatus"
          @addTask="handleAddTask"
          @updateTask="handleUpdateTask"
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
          :presence="presence"
          :tasks="tasks"
          :activityHistory="activityHistory"
          :activityHistoryLoading="activityHistoryLoading"
          :activityHistoryError="activityHistoryError"
          :canManageParticipants="room?.role === 'admin'"
          :loadActivityHistory="loadActivityHistory"
          :archiveDisconnectedParticipants="archiveDisconnectedParticipants"
          :taskGithubStatus="taskGithubStatus"
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

    <!-- Mobile bottom navigation -->
    <nav v-if="isConnected" class="mobile-bottom-nav" role="tablist" aria-label="Room navigation">
      <button
        role="tab"
        :aria-selected="activeTab === 'chat'"
        :class="{ active: activeTab === 'chat' }"
        @click="handleActiveTabChange('chat')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Chat</span>
      </button>
      <button
        v-if="githubEventsSupported"
        role="tab"
        :aria-selected="activeTab === 'events'"
        :class="{ active: activeTab === 'events' }"
        @click="handleActiveTabChange('events')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Events</span>
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'board'"
        :class="{ active: activeTab === 'board' }"
        @click="handleActiveTabChange('board')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span>Board</span>
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'activity'"
        :class="{ active: activeTab === 'activity' }"
        @click="handleActiveTabChange('activity')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>Activity</span>
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'rooms'"
        :class="{ active: activeTab === 'rooms' }"
        @click="handleActiveTabChange('rooms')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="8" y="13" width="8" height="7"/></svg>
        <span>Rooms</span>
      </button>
    </nav>
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
import MessageList from '@/components/room/MessageList.vue'
import GitHubEventFeed from '@/components/room/GitHubEventFeed.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'
import ActivityView from '@/components/room/ActivityView.vue'
import FocusRoomsView from '@/components/room/FocusRoomsView.vue'
import { collectMessageImageAttachments } from '@/components/room/messageAttachments'
import { useToast } from '@/composables/useToast'
import type {
  FocusRoomInfo,
  FocusRoomSettingsPatch,
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
  participants,
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
  setTaskStalePromptMute,
  createFocusRoom,
  createAdHocFocusRoom,
  shareFocusRoomResult,
  updateFocusRoomSettings,
  restoreSession,
  renameRoom,
  loadOlderMessages,
  loadActivityHistory,
  archiveDisconnectedParticipants,
  refreshRoomGitHubEvents,
} = useRoom()
const auth = useAuth()
const toast = useToast()

type RoomTab = 'chat' | 'events' | 'board' | 'activity' | 'rooms'
const VALID_TABS: RoomTab[] = ['chat', 'events', 'board', 'activity', 'rooms']
const TAB_ORDER: RoomTab[] = ['chat', 'events', 'board', 'activity', 'rooms']
const activeTab = ref<RoomTab>('chat')
const drawerOpen = ref(false)
const rulesBoardOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchQuery = ref('')
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const selectedReply = ref<RoomMessage | null>(null)
const activeImageId = ref<string | null>(null)
const focusDraftTaskId = ref<string | null>(null)
const creatingFocusRoomTaskId = ref<string | null>(null)
const creatingAdHocFocusRoom = ref(false)
const sharingFocusResult = ref(false)
const updatingFocusSettings = ref(false)
const tabTransitionDirection = ref<'forward' | 'back'>('forward')

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
const roomImages = computed(() => collectMessageImageAttachments(messages.value))
const activeImageIndex = computed(() =>
  activeImageId.value
    ? roomImages.value.findIndex((image) => image.id === activeImageId.value)
    : -1
)

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
const visibleTabOrder = computed(() => TAB_ORDER.filter(tab => tab !== 'events' || githubEventsSupported.value))
const tabTransitionName = computed(() =>
  tabTransitionDirection.value === 'forward' ? 'tab-slide-forward' : 'tab-slide-back'
)
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

function openImageViewer(imageId: string) {
  if (!roomImages.value.some((image) => image.id === imageId)) return
  activeImageId.value = imageId
}

function closeImageViewer() {
  activeImageId.value = null
}

function shiftImage(direction: 1 | -1) {
  if (!roomImages.value.length) return
  const currentIndex = activeImageIndex.value >= 0 ? activeImageIndex.value : 0
  const nextIndex = (currentIndex + direction + roomImages.value.length) % roomImages.value.length
  activeImageId.value = roomImages.value[nextIndex]?.id || null
}

function showNextImage() {
  if (roomImages.value.length < 2) return
  shiftImage(1)
}

function showPreviousImage() {
  if (roomImages.value.length < 2) return
  shiftImage(-1)
}

async function handleAddTask(title: string) {
  await addTask(title)
}

async function handleUpdateTask(taskId: string, updates: { status: string }) {
  await updateTask(taskId, updates as any)
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

function roomRoutePath(identifier: string): string {
  return identifier
    .split('/')
    .filter(Boolean)
    .map(part => encodeURIComponent(part))
    .join('/')
}

function buildFocusRoomPath(focusKey: string): string {
  const parent = focusParentAddress.value
  if (!parent || !focusKey) return ''
  return `/in/${roomRoutePath(parent)}/focus/${encodeURIComponent(focusKey)}`
}

function buildDirectRoomPath(roomId: string | null | undefined): string {
  return roomId ? `/in/${roomRoutePath(roomId)}` : ''
}

function buildFocusRoomInfoPath(focusRoom: FocusRoomInfo): string {
  const focusKey = focusRoom.focus_key || focusRoom.source_task_id
  const parent = focusRoom.parent_room_id || focusParentAddress.value
  if (parent && focusKey) {
    return `/in/${roomRoutePath(parent)}/focus/${encodeURIComponent(focusKey)}`
  }
  return buildDirectRoomPath(focusRoom.room_id)
}

function openBlankFocusRoomTab(): Window | null {
  try {
    const target = window.open('about:blank', '_blank')
    if (target) {
      target.opener = null
    }
    return target
  } catch {
    return null
  }
}

function closeFocusTargetWindow(targetWindow?: Window | null) {
  if (targetWindow && !targetWindow.closed) {
    targetWindow.close()
  }
}

async function openFocusRoomPath(path: string, targetWindow?: Window | null): Promise<boolean> {
  if (!path) return false
  const absoluteUrl = new URL(path, window.location.origin).toString()

  if (targetWindow && !targetWindow.closed) {
    try {
      targetWindow.location.replace(absoluteUrl)
      targetWindow.focus()
      return true
    } catch {
      closeFocusTargetWindow(targetWindow)
    }
  } else {
    const openedWindow = openBlankFocusRoomTab()
    if (openedWindow && !openedWindow.closed) {
      try {
        openedWindow.location.replace(absoluteUrl)
        openedWindow.focus()
        return true
      } catch {
        closeFocusTargetWindow(openedWindow)
      }
    }
  }

  try {
    await router.push(path)
    return true
  } catch {
    return false
  }
}

async function handleOpenFocusRoom(focusKey: string, targetWindow?: Window | null): Promise<boolean> {
  const path = focusKey.startsWith('focus_')
    ? buildDirectRoomPath(focusKey)
    : buildFocusRoomPath(focusKey)
  if (!path) {
    closeFocusTargetWindow(targetWindow)
    return false
  }
  return openFocusRoomPath(path, targetWindow)
}

async function handleOpenParentRoom() {
  const parent = focusParentAddress.value
  if (!parent) return
  await router.push(`/in/${roomRoutePath(parent)}`)
}

async function handleFocusTask(taskId: string) {
  focusDraftTaskId.value = taskId
  if (room.value?.kind === 'focus') {
    toast.info('Open new Focus Rooms from the parent room.')
    return
  }

  const focusWindow = openBlankFocusRoomTab()
  creatingFocusRoomTaskId.value = taskId
  try {
    const focusRoom = await createFocusRoom(taskId)
    if (!focusRoom) {
      closeFocusTargetWindow(focusWindow)
      setActiveTab('rooms')
      syncViewQuery('rooms', 'push')
      toast.error('Focus Room could not be opened.')
      return
    }

    const path = buildFocusRoomInfoPath(focusRoom) || buildFocusRoomPath(taskId)
    const opened = await openFocusRoomPath(path, focusWindow)
    if (!opened) {
      toast.error('Focus Room could not be opened.')
    }
  } finally {
    creatingFocusRoomTaskId.value = null
  }
}

async function handleCreateAdHocFocusRoom(title: string) {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    toast.error('Name the Focus Room first.')
    return
  }
  if (room.value?.kind === 'focus') {
    toast.info('Open new Focus Rooms from the parent room.')
    return
  }

  const focusWindow = openBlankFocusRoomTab()
  creatingAdHocFocusRoom.value = true
  try {
    const focusRoom = await createAdHocFocusRoom(trimmedTitle)
    if (!focusRoom) {
      closeFocusTargetWindow(focusWindow)
      setActiveTab('rooms')
      syncViewQuery('rooms', 'push')
      toast.error('Focus Room could not be opened.')
      return
    }

    const opened = await openFocusRoomPath(buildFocusRoomInfoPath(focusRoom), focusWindow)
    if (!opened) {
      toast.error('Focus Room could not be opened.')
    }
  } finally {
    creatingAdHocFocusRoom.value = false
  }
}

async function handleShareFocusResults(summary: string) {
  const trimmedSummary = summary.trim()
  if (!trimmedSummary) {
    toast.error('Write a result summary first.')
    return
  }

  sharingFocusResult.value = true
  try {
    const result = await shareFocusRoomResult(trimmedSummary)
    if (!result) {
      toast.error('Result could not be shared.')
      return
    }
    toast.success(result.parentMessagePosted ? 'Result shared with the parent room.' : 'Focus Room result saved.')
  } finally {
    sharingFocusResult.value = false
  }
}

async function handleUpdateFocusSettings(focusKey: string, settings: FocusRoomSettingsPatch) {
  if (!focusKey) {
    toast.error('Focus Room settings could not be saved.')
    return
  }

  updatingFocusSettings.value = true
  try {
    const focusRoom = await updateFocusRoomSettings(focusKey, settings)
    if (!focusRoom) {
      toast.error('Focus Room settings could not be saved.')
      return
    }
    toast.success('Focus Room settings saved.')
  } finally {
    updatingFocusSettings.value = false
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
  const roomId = route.params.roomId as string
  await auth.signIn(roomId ? `/in/${roomId}` : '/')
}

function normalizeRoomTab(rawValue: unknown): RoomTab {
  const requested = typeof rawValue === 'string' ? rawValue : ''
  if (!VALID_TABS.includes(requested as RoomTab)) {
    return 'chat'
  }

  if (requested === 'events' && !githubEventsSupported.value) {
    return 'chat'
  }

  return requested as RoomTab
}

function syncViewQuery(tab: RoomTab, mode: 'push' | 'replace' = 'replace') {
  const current = typeof route.query.view === 'string' ? route.query.view : ''
  if (current === tab) {
    return
  }

  const navigate = mode === 'push' ? router.push : router.replace
  void navigate({
    query: {
      ...route.query,
      view: tab,
    },
  })
}

function applyRouteTab(rawValue: unknown) {
  const nextTab = normalizeRoomTab(rawValue)
  setActiveTab(nextTab)
  syncViewQuery(nextTab, 'replace')
}

function handleActiveTabChange(rawValue: RoomTab) {
  const nextTab = normalizeRoomTab(rawValue)
  setActiveTab(nextTab)
  syncViewQuery(nextTab, 'push')
}

function setActiveTab(nextTab: RoomTab) {
  if (activeTab.value === nextTab) return

  const order = visibleTabOrder.value
  const currentIndex = order.indexOf(activeTab.value)
  const nextIndex = order.indexOf(nextTab)
  if (currentIndex >= 0 && nextIndex >= 0) {
    tabTransitionDirection.value = nextIndex > currentIndex ? 'forward' : 'back'
  }
  activeTab.value = nextTab
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

watch(() => route.query.view, (newView) => {
  applyRouteTab(newView)
})

watch(activeTab, async (tab) => {
  if (tab !== 'chat') {
    closeImageViewer()
  }
  if (tab === 'events' && isConnected.value && githubEventsSupported.value) {
    await refreshRoomGitHubEvents()
  }
})

watch(roomImages, (images) => {
  if (!activeImageId.value) return
  if (!images.some((image) => image.id === activeImageId.value)) {
    closeImageViewer()
  }
})

watch(githubEventsSupported, (supported) => {
  // Only reset away from events after we've connected and confirmed no support
  if (!supported && activeTab.value === 'events' && isConnected.value) {
    activeTab.value = 'chat'
    syncViewQuery('chat', 'replace')
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

.room-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--muted, #71717a);
}

.room-error-title {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  font-weight: 700;
}

.room-error-body {
  margin: 0;
  max-width: 420px;
  text-align: center;
  line-height: 1.6;
}

.room-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.retry-btn {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid var(--border, #27272a);
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s;
}
.retry-btn:hover {
  background: var(--border, #27272a);
}

.retry-btn.secondary {
  background: transparent;
  color: var(--muted, #a1a1aa);
}

/* ── Mobile bottom navigation ── */
.mobile-bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  .room-shell { height: 100dvh; }
  .room-error { padding: 24px 16px; }
  .room-error-body { font-size: 0.85rem; }

  .mobile-bottom-nav {
    display: flex;
    align-items: center;
    justify-content: space-around;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding: 0 4px env(safe-area-inset-bottom, 0px);
    background: var(--bg-0, #09090b);
    border-top: 1px solid var(--line, #27272a);
    position: sticky;
    bottom: 0;
    z-index: 50;
  }

  .mobile-bottom-nav button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    flex: 1;
    padding: 6px 0;
    border: none;
    background: none;
    color: var(--muted, #71717a);
    cursor: pointer;
    transition: color 150ms;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-bottom-nav button svg {
    width: 19px;
    height: 19px;
  }

  .mobile-bottom-nav button span {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .mobile-bottom-nav button.active,
  .mobile-bottom-nav button[aria-selected="true"] {
    color: var(--accent, #6366f1);
  }

  .mobile-bottom-nav button:hover:not(.active) {
    color: var(--text, #fafafa);
  }
}
</style>
