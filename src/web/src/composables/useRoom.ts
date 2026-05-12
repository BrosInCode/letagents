import { ref, readonly, computed } from 'vue'
import {
  isRepoBackedRoomId,
  type RoomGitHubEventsError,
} from './roomGitHubEvents'
import {
  discardAttachmentUpload,
  prepareMessageAttachments,
  stageAttachmentUpload,
} from './room/attachments'
import { apiFetch, roomPath } from './room/api'
import {
  fetchActivityHistory,
  fetchFocusRooms,
  fetchGitHubEvents,
  fetchMessages,
  fetchParticipants,
  fetchPresence,
  fetchTaskGithubStatus,
  fetchTasks,
  getGitHubEventsIdentifier,
  getGitHubSupportIdentifier,
  mergeMessages,
} from './room/data'
import {
  applyFocusRoomConclusion,
  applyFocusRoomSettings,
  concludeFocusRoom,
  createStandaloneFocusRoom,
  createTaskFocusRoom,
  patchFocusRoomSettings,
  upsertFocusRoomList,
} from './room/focusRooms'
import {
  getReplyPreviewText,
  getSenderColor,
  hasInlinePromptInjection,
  isHumanSender,
  isPromptOnlyRoomMessage,
  normalizeAgentPromptKind,
  parseAgentIdentity,
} from './room/identity'
import { joinRoomSession, loadRoomBootstrap } from './room/join'
import {
  fetchReasoningSessions,
  mergeReasoningSession,
  sortReasoningSessions,
} from './room/reasoning'
import { createPresenceController } from './room/presence'
import {
  clearPersistedSession,
  loadPersistedSession,
  persistRoomSession,
} from './room/session'
import { soundEnabled, toggleSound } from './room/sound'
import { createRoomStream } from './room/stream'
import { HANDOFF_PRESENCE_PAGE_SIZE } from './room/constants'
import {
  createRoomTask,
  fetchTasksAndPresence,
  patchRoomTask,
  postTaskLeaseAction,
  postTaskReviewLeaseAction,
  setRoomTaskStalePromptMute,
} from './room/taskActions'
import type {
  FocusRoomConclusionDetails,
  FocusRoomInfo,
  FocusRoomSettingsPatch,
  OutgoingMessageAttachment,
  RoomActivityHistoryKind,
  RoomActivityHistoryPage,
  RoomAgentPresence,
  RoomGitHubEvent,
  RoomInfo,
  RoomJoinError,
  RoomMessage,
  RoomParticipant,
  RoomReasoningSession,
  RoomReasoningUpdate,
  RoomTask,
  TaskGitHubArtifactStatus,
  TaskLeaseActionInput,
  TaskReviewLeaseActionInput,
} from './room/types'

export type * from './room/types'
export {
  DEFAULT_FOCUS_ROOM_SETTINGS,
  focusRoomSettingsFrom,
} from './room/types'
export type { ParsedIdentity } from './room/identity'
export {
  getReplyPreviewText,
  getSenderColor,
  hasInlinePromptInjection,
  isHumanSender,
  isPromptOnlyRoomMessage,
  normalizeAgentPromptKind,
  parseAgentIdentity,
} from './room/identity'

const messages = ref<RoomMessage[]>([])
const messagesHasOlder = ref(false)
const isLoadingOlderMessages = ref(false)
const presence = ref<RoomAgentPresence[]>([])
const boardHandoffPresence = ref<RoomAgentPresence[]>([])
const participants = ref<RoomParticipant[]>([])
const participantHiddenCount = ref(0)
const activityHistory = ref<RoomActivityHistoryPage | null>(null)
const activityHistoryLoading = ref(false)
const activityHistoryError = ref('')
const reasoningSessions = ref<RoomReasoningSession[]>([])
const taskGithubStatus = ref<Record<string, TaskGitHubArtifactStatus>>({})
const tasks = ref<RoomTask[]>([])
const focusRooms = ref<FocusRoomInfo[]>([])
const githubEvents = ref<RoomGitHubEvent[]>([])
const githubEventsAvailable = ref(false)
const githubEventsHasMore = ref(false)
const githubEventsError = ref<RoomGitHubEventsError | null>(null)
const githubEventsLoading = ref(false)
const boardLoading = ref(false)
const activityLoading = ref(false)
const focusRoomsLoading = ref(false)
const room = ref<RoomInfo | null>(null)
const lastSendError = ref('')
const isConnected = ref(false)
const isStreaming = ref(false)
const connectionState = ref<'idle' | 'connecting' | 'live' | 'error'>('idle')
const joinError = ref<RoomJoinError | null>(null)

let githubEventsRefreshTimer: ReturnType<typeof setTimeout> | null = null
type ActivityHistoryRequest = {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
}
let lastActivityHistoryRequest: ActivityHistoryRequest = {}
let activityHistoryRequestSequence = 0

const githubEventsSupported = computed(() =>
  isRepoBackedRoomId(getGitHubSupportIdentifier(room.value)),
)

function upsertReasoningSession(
  session: RoomReasoningSession | null | undefined,
  appendedUpdate?: RoomReasoningUpdate | null,
) {
  if (!session?.id) return
  const idx = reasoningSessions.value.findIndex(
    (item) => item.id === session.id,
  )
  if (idx >= 0) {
    const updated = [...reasoningSessions.value]
    updated[idx] = mergeReasoningSession(updated[idx], session, appendedUpdate)
    reasoningSessions.value = sortReasoningSessions(updated)
    return
  }
  const nextSession = appendedUpdate?.id
    ? mergeReasoningSession(session, session, appendedUpdate)
    : session
  reasoningSessions.value = sortReasoningSessions([
    ...reasoningSessions.value,
    nextSession,
  ])
}

function removeReasoningSession(sessionId: string) {
  reasoningSessions.value = reasoningSessions.value.filter(
    (session) => session.id !== sessionId,
  )
}

function upsertTask(task: RoomTask) {
  const idx = tasks.value.findIndex((item) => item.id === task.id)
  if (idx >= 0) {
    const updated = [...tasks.value]
    updated[idx] = task
    tasks.value = updated
    return
  }
  tasks.value = [...tasks.value, task]
}

async function refreshTasksAndPresence(roomIdentifier: string) {
  const next = await fetchTasksAndPresence(roomIdentifier)
  tasks.value = next.tasks
  presence.value = next.presence
  boardHandoffPresence.value = next.presence
}

function resetRoomState(options: {
  activityHistoryLoading: boolean
  githubEventsLoading: boolean
  connectionState: 'idle' | 'connecting'
  activityHistoryRequest?: ActivityHistoryRequest
}) {
  activityHistoryRequestSequence += 1
  room.value = null
  messages.value = []
  messagesHasOlder.value = false
  isLoadingOlderMessages.value = false
  tasks.value = []
  focusRooms.value = []
  presence.value = []
  boardHandoffPresence.value = []
  participants.value = []
  participantHiddenCount.value = 0
  activityHistory.value = null
  activityHistoryLoading.value = options.activityHistoryLoading
  activityHistoryError.value = ''
  lastActivityHistoryRequest = options.activityHistoryRequest || {}
  reasoningSessions.value = []
  githubEvents.value = []
  githubEventsAvailable.value = false
  githubEventsHasMore.value = false
  githubEventsError.value = null
  githubEventsLoading.value = options.githubEventsLoading
  isConnected.value = false
  connectionState.value = options.connectionState
  joinError.value = null
}

const {
  refreshPresence,
  refreshParticipants,
  refreshRoomPresence,
  refreshRoomReachability,
  schedulePresenceRefresh,
  scheduleParticipantRefresh,
  startPresenceRefreshLoop,
  startParticipantRefreshLoop,
  stop: stopPresenceControllers,
} = createPresenceController({
  getRoomIdentifier: () => room.value?.identifier || null,
  isCurrentRoom: (roomIdentifier) => room.value?.identifier === roomIdentifier,
  setPresence: (nextPresence) => {
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
  },
  setParticipants: (nextParticipants, hiddenCount) => {
    participants.value = nextParticipants
    participantHiddenCount.value = hiddenCount
  },
})

const roomStream = createRoomStream({
  setConnectionState: (state) => {
    connectionState.value = state
  },
  setStreaming: (streaming) => {
    isStreaming.value = streaming
  },
  appendMessage: (message) => {
    if (messages.value.some((item) => item.id === message.id)) return false
    messages.value = [...messages.value, message]
    return true
  },
  onGitHubMessage: () => {
    if (room.value && githubEventsSupported.value) {
      scheduleGitHubEventsRefresh(
        getGitHubEventsIdentifier(room.value),
        githubEventsSupported.value,
      )
    }
    if (room.value) {
      void refreshTaskGithubStatus()
    }
  },
  onTaskLifecycleMessage: () => {
    if (!room.value) return
    fetchTasks(room.value.identifier).then((nextTasks) => {
      tasks.value = nextTasks
    })
  },
  onAgentActivityMessage: () => {
    if (room.value) {
      schedulePresenceRefresh(room.value.identifier)
    }
  },
  onParticipantActivityMessage: () => {
    if (room.value) {
      scheduleParticipantRefresh(room.value.identifier)
    }
  },
  upsertTask,
  upsertReasoningSession,
  removeReasoningSession,
})

async function loadActivityHistory(options?: {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
}): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const nextRequest = {
    query: options?.query ?? lastActivityHistoryRequest.query,
    page: options?.page ?? lastActivityHistoryRequest.page ?? 1,
    pageSize: options?.pageSize ?? lastActivityHistoryRequest.pageSize ?? 20,
    kind: options?.kind ?? lastActivityHistoryRequest.kind ?? 'all',
    roomId:
      options?.roomId ?? lastActivityHistoryRequest.roomId ?? roomIdentifier,
  }
  lastActivityHistoryRequest = nextRequest
  const requestId = ++activityHistoryRequestSequence

  activityHistoryLoading.value = true
  activityHistoryError.value = ''
  try {
    const next = await fetchActivityHistory(roomIdentifier, nextRequest)
    if (
      requestId !== activityHistoryRequestSequence ||
      room.value?.identifier !== roomIdentifier
    ) {
      return false
    }
    if (!next) {
      activityHistoryError.value = 'Could not load room activity history.'
      return false
    }
    activityHistory.value = next
    return true
  } finally {
    if (requestId === activityHistoryRequestSequence) {
      activityHistoryLoading.value = false
    }
  }
}

async function clearDisconnectedParticipants(): Promise<number> {
  if (!room.value) return 0

  try {
    const response = await apiFetch(
      `${roomPath(room.value.identifier)}/participants/clear-disconnected`,
      {
        method: 'POST',
      },
    )
    await Promise.all([
      refreshParticipants(room.value.identifier),
      refreshPresence(room.value.identifier),
    ])
    if (
      (activityHistory.value?.selected_room_id ||
        lastActivityHistoryRequest.roomId ||
        room.value.identifier) === room.value.identifier
    ) {
      await loadActivityHistory({
        ...lastActivityHistoryRequest,
        roomId: room.value.identifier,
      })
    }
    return Number(
      response.cleared_count ||
        response.suppressed_count ||
        response.participant_hidden_count ||
        0,
    )
  } catch {
    return 0
  }
}

async function refreshRoomMessages(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const page = await fetchMessages(roomIdentifier)
  if (room.value?.identifier !== roomIdentifier) return false
  messages.value = mergeMessages(messages.value, page.messages)
  messagesHasOlder.value = page.hasOlder || messagesHasOlder.value
  return true
}

async function refreshGitHubEvents(
  roomIdentifier: string,
  supported = isRepoBackedRoomId(roomIdentifier),
) {
  if (!supported) {
    githubEvents.value = []
    githubEventsAvailable.value = false
    githubEventsHasMore.value = false
    githubEventsError.value = null
    githubEventsLoading.value = false
    return
  }

  githubEventsLoading.value = true
  try {
    const next = await fetchGitHubEvents(roomIdentifier)
    githubEvents.value = next.events
    githubEventsAvailable.value = next.available
    githubEventsHasMore.value = next.hasMore
    githubEventsError.value = next.error
  } finally {
    githubEventsLoading.value = false
  }
}

async function refreshRoomGitHubEvents(): Promise<boolean> {
  if (!room.value) return false
  await refreshGitHubEvents(
    getGitHubEventsIdentifier(room.value),
    githubEventsSupported.value,
  )
  return true
}

function scheduleGitHubEventsRefresh(
  roomIdentifier: string,
  supported = isRepoBackedRoomId(roomIdentifier),
) {
  if (githubEventsRefreshTimer) return
  githubEventsRefreshTimer = setTimeout(() => {
    githubEventsRefreshTimer = null
    void refreshGitHubEvents(roomIdentifier, supported)
  }, 350)
}

async function refreshTaskGithubStatus(): Promise<boolean> {
  if (!room.value) return false
  taskGithubStatus.value = await fetchTaskGithubStatus(room.value.identifier)
  return true
}

async function refreshReasoningSessions(): Promise<boolean> {
  if (!room.value) return false
  reasoningSessions.value = await fetchReasoningSessions(room.value.identifier)
  return true
}

async function refreshFocusRooms(): Promise<boolean> {
  if (!room.value) return false
  focusRooms.value = await fetchFocusRooms(room.value.identifier)
  return true
}

async function refreshRoomBoard(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  boardLoading.value = true
  try {
    const [nextTasks, nextGithubStatus, nextPresence] = await Promise.all([
      fetchTasks(roomIdentifier),
      fetchTaskGithubStatus(roomIdentifier),
      fetchPresence(roomIdentifier, HANDOFF_PRESENCE_PAGE_SIZE),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    tasks.value = nextTasks
    taskGithubStatus.value = nextGithubStatus
    boardHandoffPresence.value = nextPresence
    return true
  } finally {
    boardLoading.value = false
  }
}

async function refreshRoomActivity(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const historyRequest = {
    ...lastActivityHistoryRequest,
    roomId: lastActivityHistoryRequest.roomId ?? roomIdentifier,
  }
  activityLoading.value = true
  try {
    const [
      messagePage,
      nextPresence,
      nextParticipantsPage,
      nextReasoningSessions,
      nextActivityHistory,
      nextTasks,
      nextGithubStatus,
    ] = await Promise.all([
      fetchMessages(roomIdentifier),
      fetchPresence(roomIdentifier),
      fetchParticipants(roomIdentifier),
      fetchReasoningSessions(roomIdentifier),
      fetchActivityHistory(roomIdentifier, historyRequest),
      fetchTasks(roomIdentifier),
      fetchTaskGithubStatus(roomIdentifier),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    messages.value = mergeMessages(messages.value, messagePage.messages)
    messagesHasOlder.value = messagePage.hasOlder || messagesHasOlder.value
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
    participants.value = nextParticipantsPage.participants
    participantHiddenCount.value = nextParticipantsPage.hidden_count
    reasoningSessions.value = nextReasoningSessions
    if (nextActivityHistory) {
      activityHistory.value = nextActivityHistory
      activityHistoryError.value = ''
    }
    tasks.value = nextTasks
    taskGithubStatus.value = nextGithubStatus
    return true
  } finally {
    activityLoading.value = false
  }
}

async function refreshRoomFocusRooms(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  focusRoomsLoading.value = true
  try {
    const [nextFocusRooms, nextTasks] = await Promise.all([
      fetchFocusRooms(roomIdentifier),
      fetchTasks(roomIdentifier),
    ])
    if (room.value?.identifier !== roomIdentifier) return false
    focusRooms.value = nextFocusRooms
    tasks.value = nextTasks
    return true
  } finally {
    focusRoomsLoading.value = false
  }
}

function upsertFocusRoom(focusRoom: FocusRoomInfo) {
  focusRooms.value = upsertFocusRoomList(focusRooms.value, focusRoom)
}

function startStreaming(roomIdentifier: string) {
  roomStream.start(roomIdentifier)
}

function stopStreaming() {
  roomStream.stop()
  if (githubEventsRefreshTimer) {
    clearTimeout(githubEventsRefreshTimer)
    githubEventsRefreshTimer = null
  }
  stopPresenceControllers()
}

async function sendMessage(
  text: string,
  sender?: string,
  agentPromptKind?: string | null,
  replyTo?: string | null,
  attachments: OutgoingMessageAttachment[] = [],
): Promise<boolean> {
  if (!room.value) return false
  lastSendError.value = ''
  try {
    const preparedAttachments = attachments.length
      ? await prepareMessageAttachments(room.value.identifier, attachments)
      : []
    const body: Record<string, unknown> = {
      text,
      sender: sender || 'anonymous',
    }
    if (agentPromptKind) {
      body.agent_prompt_kind = agentPromptKind
    }
    if (replyTo) {
      body.reply_to = replyTo
    }
    if (preparedAttachments.length) {
      body.attachments = preparedAttachments
    }
    const msg = await apiFetch(`${roomPath(room.value.identifier)}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (
      msg?.id &&
      !isPromptOnlyRoomMessage(msg) &&
      !messages.value.some((m) => m.id === msg.id)
    ) {
      messages.value = [...messages.value, msg]
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : ''
    lastSendError.value = /attachment object storage is not configured/i.test(
      message,
    )
      ? 'Attachments are unavailable right now.'
      : message || 'Message could not be sent.'
    return false
  }
}

async function addTask(title: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const task = await createRoomTask(room.value.identifier, title)
    if (task) tasks.value = [...tasks.value, task]
    return true
  } catch {
    return false
  }
}

async function createFocusRoom(taskId: string): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  try {
    const focusRoom = await createTaskFocusRoom(room.value.identifier, taskId)
    if (!focusRoom?.room_id) return null
    upsertFocusRoom(focusRoom)
    return focusRoom
  } catch {
    return null
  }
}

async function createAdHocFocusRoom(
  title: string,
): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  const trimmedTitle = title.trim()
  if (!trimmedTitle) return null

  try {
    const focusRoom = await createStandaloneFocusRoom(
      room.value.identifier,
      trimmedTitle,
    )
    if (!focusRoom?.room_id) return null
    upsertFocusRoom(focusRoom)
    return focusRoom
  } catch {
    return null
  }
}

async function shareFocusRoomResult(
  summary: string,
  conclusionDetails: FocusRoomConclusionDetails | null = null,
): Promise<{ focusRoom: FocusRoomInfo; parentMessagePosted: boolean } | null> {
  if (!room.value || room.value.kind !== 'focus') return null
  const trimmedSummary = summary.trim()
  const parentRoomId = room.value.parentRoomId
  const focusKey = room.value.focusKey || room.value.sourceTaskId
  if (!trimmedSummary || !parentRoomId || !focusKey) return null

  try {
    const result = await concludeFocusRoom(
      parentRoomId,
      focusKey,
      trimmedSummary,
      conclusionDetails,
    )
    const focusRoom = result.focusRoom
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    room.value = applyFocusRoomConclusion(
      room.value,
      focusRoom,
      trimmedSummary,
      conclusionDetails,
    )

    return {
      focusRoom,
      parentMessagePosted: result.parentMessagePosted,
    }
  } catch {
    return null
  }
}

async function updateFocusRoomSettings(
  focusKey: string,
  settings: FocusRoomSettingsPatch,
): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  const parentRoomId =
    room.value.kind === 'focus'
      ? room.value.parentRoomId
      : room.value.identifier
  if (!parentRoomId || !focusKey) return null

  try {
    const focusRoom = await patchFocusRoomSettings(
      parentRoomId,
      focusKey,
      settings,
    )
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    if (
      room.value.kind === 'focus' &&
      room.value.projectId === focusRoom.room_id
    ) {
      room.value = applyFocusRoomSettings(room.value, focusRoom)
    }

    return focusRoom
  } catch {
    return null
  }
}

async function updateTask(
  taskId: string,
  updates: Partial<RoomTask>,
): Promise<boolean> {
  if (!room.value) return false
  try {
    const task = await patchRoomTask(room.value.identifier, taskId, updates)
    if (task) upsertTask(task)
    await refreshTasksAndPresence(room.value.identifier)
    return true
  } catch {
    return false
  }
}

async function updateTaskLease(
  taskId: string,
  input: TaskLeaseActionInput,
): Promise<boolean> {
  if (!room.value) return false
  try {
    const task = await postTaskLeaseAction(
      room.value.identifier,
      taskId,
      input,
    )
    if (task) upsertTask(task)
    await refreshTasksAndPresence(room.value.identifier)
    return true
  } catch {
    return false
  }
}

async function updateTaskReviewLease(
  taskId: string,
  input: TaskReviewLeaseActionInput,
): Promise<boolean> {
  if (!room.value) return false
  try {
    const task = await postTaskReviewLeaseAction(
      room.value.identifier,
      taskId,
      input,
    )
    if (task) upsertTask(task)
    await refreshTasksAndPresence(room.value.identifier)
    return true
  } catch {
    return false
  }
}

async function setTaskStalePromptMute(
  taskId: string,
  muted: boolean,
  options?: { promptTimestamp?: string | null },
): Promise<boolean> {
  if (!room.value) return false
  try {
    const task = await setRoomTaskStalePromptMute(
      room.value.identifier,
      taskId,
      muted,
      options,
    )
    if (task) upsertTask(task)
    tasks.value = await fetchTasks(room.value.identifier)
    return true
  } catch (error) {
    tasks.value = await fetchTasks(room.value.identifier)
    if ((error as { code?: string | null }).code === 'STALE_PROMPT_OUTDATED') {
      return true
    }
    return false
  }
}

async function renameRoom(newName: string): Promise<boolean> {
  if (!room.value) return false
  try {
    const result = await apiFetch(`${roomPath(room.value.identifier)}`, {
      method: 'PATCH',
      body: JSON.stringify({ display_name: newName }),
    })
    if (result.display_name) {
      room.value = { ...room.value, displayName: result.display_name }
      persistRoomSession(room.value)
    }
    return true
  } catch {
    return false
  }
}

async function joinRoom(roomIdentifier: string) {
  stopStreaming()
  resetRoomState({
    activityHistoryLoading: true,
    githubEventsLoading: true,
    connectionState: 'connecting',
    activityHistoryRequest: {
      page: 1,
      pageSize: 20,
      kind: 'all',
      roomId: roomIdentifier,
    },
  })

  try {
    const joinedRoom = await joinRoomSession(roomIdentifier)
    room.value = joinedRoom
    isConnected.value = true
    persistRoomSession(room.value)
    const bootstrapActivityHistoryRequestId = activityHistoryRequestSequence
    const bootstrap = await loadRoomBootstrap(
      joinedRoom,
      lastActivityHistoryRequest,
    )
    messages.value = mergeMessages([], bootstrap.messagePage.messages)
    messagesHasOlder.value = bootstrap.messagePage.hasOlder
    tasks.value = bootstrap.tasks
    focusRooms.value = bootstrap.focusRooms
    presence.value = bootstrap.presence
    boardHandoffPresence.value = bootstrap.presence
    participants.value = bootstrap.participantsPage.participants
    participantHiddenCount.value = bootstrap.participantsPage.hidden_count
    reasoningSessions.value = bootstrap.reasoningSessions
    if (
      bootstrapActivityHistoryRequestId === activityHistoryRequestSequence &&
      room.value?.identifier === roomIdentifier
    ) {
      activityHistory.value = bootstrap.activityHistory
      activityHistoryLoading.value = false
      activityHistoryError.value = bootstrap.activityHistory
        ? ''
        : 'Could not load room activity history.'
    }
    taskGithubStatus.value = bootstrap.taskGithubStatus
    githubEvents.value = bootstrap.githubEvents.events
    githubEventsAvailable.value = bootstrap.githubEvents.available
    githubEventsHasMore.value = bootstrap.githubEvents.hasMore
    githubEventsError.value = bootstrap.githubEvents.error
    githubEventsLoading.value = false

    startPresenceRefreshLoop(roomIdentifier)
    startParticipantRefreshLoop(roomIdentifier)
    startStreaming(roomIdentifier)
    connectionState.value = 'live'
    return true
  } catch (err) {
    connectionState.value = 'error'
    const error = err as Error & {
      status?: number
      code?: string | null
      payload?: {
        room_id?: string
        device_flow_url?: string
        message?: string
      } | null
    }
    joinError.value = {
      status: error.status ?? null,
      code: error.code ?? null,
      message: error.message || 'Could not connect to room.',
      roomId: error.payload?.room_id ?? roomIdentifier,
      deviceFlowUrl: error.payload?.device_flow_url ?? null,
    }
    console.error('[useRoom] joinRoom failed:', err)
    return false
  }
}

async function loadOlderMessages(): Promise<boolean> {
  if (!room.value || isLoadingOlderMessages.value || !messagesHasOlder.value) {
    return false
  }

  const firstMessageId = messages.value[0]?.id
  if (!firstMessageId) {
    return false
  }

  isLoadingOlderMessages.value = true
  try {
    const page = await fetchMessages(room.value.identifier, firstMessageId)
    messages.value = mergeMessages(messages.value, page.messages)
    messagesHasOlder.value = page.hasOlder
    return page.messages.length > 0
  } finally {
    isLoadingOlderMessages.value = false
  }
}

async function restoreSession(): Promise<boolean> {
  const saved = loadPersistedSession()
  if (!saved) return false
  return joinRoom(saved.identifier)
}

function leaveRoom() {
  stopStreaming()
  resetRoomState({
    activityHistoryLoading: false,
    githubEventsLoading: false,
    connectionState: 'idle',
  })
  clearPersistedSession()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopStreaming()
  })
}

export function useRoom() {
  return {
    messages: readonly(messages),
    messagesHasOlder: readonly(messagesHasOlder),
    isLoadingOlderMessages: readonly(isLoadingOlderMessages),
    tasks: readonly(tasks),
    focusRooms: readonly(focusRooms),
    presence: readonly(presence),
    boardHandoffPresence: readonly(boardHandoffPresence),
    participants: readonly(participants),
    participantHiddenCount: readonly(participantHiddenCount),
    activityHistory: readonly(activityHistory),
    activityHistoryLoading: readonly(activityHistoryLoading),
    activityHistoryError: readonly(activityHistoryError),
    reasoningSessions: readonly(reasoningSessions),
    taskGithubStatus: readonly(taskGithubStatus),
    githubEvents: readonly(githubEvents),
    githubEventsAvailable: readonly(githubEventsAvailable),
    githubEventsHasMore: readonly(githubEventsHasMore),
    githubEventsError: readonly(githubEventsError),
    githubEventsSupported,
    githubEventsLoading: readonly(githubEventsLoading),
    boardLoading: readonly(boardLoading),
    activityLoading: readonly(activityLoading),
    focusRoomsLoading: readonly(focusRoomsLoading),
    room: readonly(room),
    lastSendError: readonly(lastSendError),
    isConnected: readonly(isConnected),
    isStreaming: readonly(isStreaming),
    connectionState: readonly(connectionState),
    joinError: readonly(joinError),
    soundEnabled: readonly(soundEnabled),

    joinRoom,
    leaveRoom,
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
    refreshFocusRooms,
    refreshRoomMessages,
    refreshRoomPresence,
    refreshRoomReachability,
    loadActivityHistory,
    clearDisconnectedParticipants,
    refreshReasoningSessions,
    refreshRoomActivity,
    refreshRoomBoard,
    refreshRoomFocusRooms,
    refreshTaskGithubStatus,
    refreshRoomGitHubEvents,
    renameRoom,
    loadOlderMessages,
    restoreSession,
    toggleSound,

    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
