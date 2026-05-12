import { ref, readonly, onUnmounted, computed } from 'vue'
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
  getReplyPreviewText,
  getSenderColor,
  hasInlinePromptInjection,
  isHumanSender,
  isPromptOnlyRoomMessage,
  normalizeAgentPromptKind,
  parseAgentIdentity,
} from './room/identity'
import {
  fetchReasoningSessions,
  mergeReasoningSession,
  sortReasoningSessions,
} from './room/reasoning'
import {
  clearPersistedSession,
  loadPersistedSession,
  persistRoomSession,
} from './room/session'
import { playNotificationSound, soundEnabled, toggleSound } from './room/sound'
import {
  HANDOFF_PRESENCE_PAGE_SIZE,
  PRESENCE_REFRESH_INTERVAL_MS,
} from './room/constants'
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

/** ── State ── */
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

let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1200
let githubEventsRefreshTimer: ReturnType<typeof setTimeout> | null = null
let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null
let presenceRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
let participantRefreshTimer: ReturnType<typeof setInterval> | null = null
let participantRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
let lastActivityHistoryRequest: {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
} = {}
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

async function refreshPresence(roomIdentifier: string) {
  const nextPresence = await fetchPresence(roomIdentifier)
  presence.value = nextPresence
  boardHandoffPresence.value = nextPresence
}

async function refreshParticipants(roomIdentifier: string) {
  const next = await fetchParticipants(roomIdentifier)
  participants.value = next.participants
  participantHiddenCount.value = next.hidden_count
}

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

async function refreshRoomPresence(): Promise<boolean> {
  if (!room.value) return false
  await refreshPresence(room.value.identifier)
  return true
}

async function refreshRoomReachability(): Promise<boolean> {
  if (!room.value) return false
  const roomIdentifier = room.value.identifier
  const [nextPresence, nextParticipantsPage] = await Promise.all([
    fetchPresence(roomIdentifier),
    fetchParticipants(roomIdentifier),
  ])
  if (room.value?.identifier !== roomIdentifier) return false
  presence.value = nextPresence
  boardHandoffPresence.value = nextPresence
  participants.value = nextParticipantsPage.participants
  participantHiddenCount.value = nextParticipantsPage.hidden_count
  return true
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

function schedulePresenceRefresh(roomIdentifier: string) {
  if (presenceRefreshDebounceTimer) return
  presenceRefreshDebounceTimer = setTimeout(() => {
    presenceRefreshDebounceTimer = null
    void refreshPresence(roomIdentifier)
  }, 350)
}

function scheduleParticipantRefresh(roomIdentifier: string) {
  if (participantRefreshDebounceTimer) return
  participantRefreshDebounceTimer = setTimeout(() => {
    participantRefreshDebounceTimer = null
    void refreshParticipants(roomIdentifier)
  }, 350)
}

function startPresenceRefreshLoop(roomIdentifier: string) {
  stopPresenceRefreshLoop()
  presenceRefreshTimer = setInterval(() => {
    void refreshPresence(roomIdentifier)
  }, PRESENCE_REFRESH_INTERVAL_MS)
}

function startParticipantRefreshLoop(roomIdentifier: string) {
  stopParticipantRefreshLoop()
  participantRefreshTimer = setInterval(() => {
    void refreshParticipants(roomIdentifier)
  }, PRESENCE_REFRESH_INTERVAL_MS)
}

function stopPresenceRefreshLoop() {
  if (presenceRefreshTimer) {
    clearInterval(presenceRefreshTimer)
    presenceRefreshTimer = null
  }
  if (presenceRefreshDebounceTimer) {
    clearTimeout(presenceRefreshDebounceTimer)
    presenceRefreshDebounceTimer = null
  }
}

function stopParticipantRefreshLoop() {
  if (participantRefreshTimer) {
    clearInterval(participantRefreshTimer)
    participantRefreshTimer = null
  }
  if (participantRefreshDebounceTimer) {
    clearTimeout(participantRefreshDebounceTimer)
    participantRefreshDebounceTimer = null
  }
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
  const idx = focusRooms.value.findIndex(
    (item) => item.room_id === focusRoom.room_id,
  )
  if (idx >= 0) {
    const updated = [...focusRooms.value]
    updated[idx] = focusRoom
    focusRooms.value = updated
  } else {
    focusRooms.value = [...focusRooms.value, focusRoom]
  }
}

/** ── SSE Streaming ── */
function startStreaming(roomIdentifier: string) {
  stopStreaming()
  connectionState.value = 'connecting'

  const url = `${roomPath(roomIdentifier)}/messages/stream`
  eventSource = new EventSource(url)

  eventSource.onopen = () => {
    connectionState.value = 'live'
    isStreaming.value = true
    reconnectDelay = 1200
  }

  eventSource.addEventListener('message', (e) => {
    try {
      const msg: RoomMessage = JSON.parse(e.data)
      if (isPromptOnlyRoomMessage(msg)) {
        return
      }
      const exists = messages.value.some((m) => m.id === msg.id)
      if (!exists) {
        messages.value = [...messages.value, msg]
        playNotificationSound()

        if (
          (msg.source || '').toLowerCase() === 'github' ||
          (msg.sender || '').toLowerCase() === 'github'
        ) {
          if (room.value && githubEventsSupported.value) {
            scheduleGitHubEventsRefresh(
              getGitHubEventsIdentifier(room.value),
              githubEventsSupported.value,
            )
          }
          // Also refresh task github status when new github events arrive
          if (room.value) {
            void refreshTaskGithubStatus()
          }
        }

        // Auto-refresh board when task lifecycle messages arrive
        if (msg.sender === 'letagents' && msg.text?.includes('task_')) {
          if (room.value) {
            fetchTasks(room.value.identifier).then((t) => {
              tasks.value = t
            })
          }
        }

        if (
          room.value &&
          ((msg.source || '').toLowerCase() === 'agent' ||
            msg.sender === 'letagents')
        ) {
          schedulePresenceRefresh(room.value.identifier)
        }

        if (
          room.value &&
          ((msg.source || '').toLowerCase() === 'agent' ||
            (msg.source || '').toLowerCase() === 'browser')
        ) {
          scheduleParticipantRefresh(room.value.identifier)
        }
      }
    } catch {
      /* ignore parse errors */
    }
  })

  eventSource.addEventListener('task_update', (e) => {
    try {
      const task: RoomTask = JSON.parse(e.data)
      const idx = tasks.value.findIndex((t) => t.id === task.id)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = task
        tasks.value = updated
      } else {
        tasks.value = [...tasks.value, task]
      }
    } catch {
      /* ignore */
    }
  })

  eventSource.addEventListener('reasoning_update', (e) => {
    try {
      const payload = JSON.parse(e.data)
      const session = payload?.session || payload
      const update =
        payload?.update && typeof payload.update.id === 'string'
          ? (payload.update as RoomReasoningUpdate)
          : null
      if (session?.id) {
        upsertReasoningSession(session, update)
      }
    } catch {
      /* ignore */
    }
  })

  eventSource.addEventListener('reasoning_remove', (e) => {
    try {
      const payload = JSON.parse(e.data)
      const sessionId =
        typeof payload?.session_id === 'string'
          ? payload.session_id
          : typeof payload?.id === 'string'
            ? payload.id
            : ''
      if (sessionId) {
        removeReasoningSession(sessionId)
      }
    } catch {
      /* ignore */
    }
  })

  eventSource.onerror = () => {
    connectionState.value = 'error'
    isStreaming.value = false
    eventSource?.close()
    eventSource = null

    reconnectTimer = setTimeout(() => {
      startStreaming(roomIdentifier)
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000)
  }
}

function stopStreaming() {
  eventSource?.close()
  eventSource = null
  isStreaming.value = false
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (githubEventsRefreshTimer) {
    clearTimeout(githubEventsRefreshTimer)
    githubEventsRefreshTimer = null
  }
  stopPresenceRefreshLoop()
  stopParticipantRefreshLoop()
}

/** ── Actions ── */
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
    // Optimistic add if SSE hasn't delivered it yet — skip prompt-only auto messages
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
    const data = await apiFetch(`${roomPath(room.value.identifier)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ title, created_by: 'human' }),
    })
    if (data.task) tasks.value = [...tasks.value, data.task]
    return true
  } catch {
    return false
  }
}

async function createFocusRoom(taskId: string): Promise<FocusRoomInfo | null> {
  if (!room.value) return null
  try {
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/focus-room`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    )
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
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
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/focus-rooms`,
      {
        method: 'POST',
        body: JSON.stringify({ title: trimmedTitle }),
      },
    )
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
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
    const data = await apiFetch(
      `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/conclude`,
      {
        method: 'POST',
        body: JSON.stringify({
          summary: trimmedSummary,
          conclusion_details: conclusionDetails,
        }),
      },
    )
    const focusRoom = (data.focus_room || data.room) as
      | FocusRoomInfo
      | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    room.value = {
      ...room.value,
      displayName: focusRoom.display_name || room.value.displayName,
      attachmentsEnabled:
        focusRoom.attachments_enabled ?? room.value.attachmentsEnabled,
      focusStatus: focusRoom.focus_status || room.value.focusStatus,
      focusParentVisibility:
        focusRoom.focus_parent_visibility || room.value.focusParentVisibility,
      focusActivityScope:
        focusRoom.focus_activity_scope || room.value.focusActivityScope,
      focusGitHubEventRouting:
        focusRoom.focus_github_event_routing ||
        room.value.focusGitHubEventRouting,
      concludedAt: focusRoom.concluded_at || room.value.concludedAt,
      conclusionSummary: focusRoom.conclusion_summary || trimmedSummary,
      conclusionDetails: focusRoom.conclusion_details || conclusionDetails,
    }

    return {
      focusRoom,
      parentMessagePosted: Boolean(data.message),
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
    const data = await apiFetch(
      `${roomPath(parentRoomId)}/focus/${encodeURIComponent(focusKey)}/settings`,
      {
        method: 'PATCH',
        body: JSON.stringify(settings),
      },
    )
    const focusRoom = data.focus_room as FocusRoomInfo | undefined
    if (!focusRoom?.room_id) return null

    upsertFocusRoom(focusRoom)
    if (
      room.value.kind === 'focus' &&
      room.value.projectId === focusRoom.room_id
    ) {
      room.value = {
        ...room.value,
        attachmentsEnabled:
          focusRoom.attachments_enabled ?? room.value.attachmentsEnabled,
        focusParentVisibility: focusRoom.focus_parent_visibility,
        focusActivityScope: focusRoom.focus_activity_scope,
        focusGitHubEventRouting: focusRoom.focus_github_event_routing,
      }
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
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(updates),
      },
    )
    // Server returns the updated task at top level (not nested under .task)
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    // Re-fetch to stay in sync (like legacy refreshBoard)
    const [nextTasks, nextPresence] = await Promise.all([
      fetchTasks(room.value.identifier),
      fetchPresence(room.value.identifier),
    ])
    tasks.value = nextTasks
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
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
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/lease-action`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    const [nextTasks, nextPresence] = await Promise.all([
      fetchTasks(room.value.identifier),
      fetchPresence(room.value.identifier),
    ])
    tasks.value = nextTasks
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
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
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/review-lease-action`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    )
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
    const [nextTasks, nextPresence] = await Promise.all([
      fetchTasks(room.value.identifier),
      fetchPresence(room.value.identifier),
    ])
    tasks.value = nextTasks
    presence.value = nextPresence
    boardHandoffPresence.value = nextPresence
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
    const data = await apiFetch(
      `${roomPath(room.value.identifier)}/tasks/${encodeURIComponent(taskId)}/stale-prompt-mute`,
      {
        method: muted ? 'POST' : 'DELETE',
        body: JSON.stringify({
          prompt_timestamp: options?.promptTimestamp ?? null,
        }),
      },
    )
    const updatedTask = data.task || (data.id ? data : null)
    if (updatedTask) {
      const idx = tasks.value.findIndex((t) => t.id === taskId)
      if (idx >= 0) {
        const updated = [...tasks.value]
        updated[idx] = updatedTask
        tasks.value = updated
      }
    }
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

/** ── Room Rename ── */
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

/** ── Join Room ── */
async function joinRoom(roomIdentifier: string) {
  // Clear active room state before attempting new join to prevent
  // failed transitions from leaving stale room data that misdirects sends
  stopStreaming()
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
  activityHistoryLoading.value = true
  activityHistoryError.value = ''
  lastActivityHistoryRequest = {
    page: 1,
    pageSize: 20,
    kind: 'all',
    roomId: roomIdentifier,
  }
  reasoningSessions.value = []
  githubEvents.value = []
  githubEventsAvailable.value = false
  githubEventsHasMore.value = false
  githubEventsError.value = null
  githubEventsLoading.value = true
  isConnected.value = false
  connectionState.value = 'connecting'
  joinError.value = null

  try {
    // Join via POST /rooms/:identifier/join
    const project = await apiFetch(`${roomPath(roomIdentifier)}/join`, {
      method: 'POST',
    })

    const joinedRoom: RoomInfo = {
      projectId: project.room_id || roomIdentifier,
      identifier: roomIdentifier,
      code: project.code || '',
      name: project.name || roomIdentifier,
      displayName: project.display_name || project.name || roomIdentifier,
      role: project.role || 'participant',
      authenticated: !!project.authenticated,
      kind: project.kind || 'main',
      attachmentsEnabled: project.attachments_enabled !== false,
      parentRoomId: project.parent_room_id || null,
      focusKey: project.focus_key || null,
      sourceTaskId: project.source_task_id || null,
      focusStatus: project.focus_status || null,
      focusParentVisibility:
        project.focus_parent_visibility ||
        project.focus_settings?.parent_visibility ||
        null,
      focusActivityScope:
        project.focus_activity_scope ||
        project.focus_settings?.activity_scope ||
        null,
      focusGitHubEventRouting:
        project.focus_github_event_routing ||
        project.focus_settings?.github_event_routing ||
        null,
      concludedAt: project.concluded_at || null,
      conclusionSummary: project.conclusion_summary || null,
      conclusionDetails: project.conclusion_details || null,
    }
    room.value = joinedRoom
    isConnected.value = true
    persistRoomSession(room.value)
    const bootstrapActivityHistoryRequestId = activityHistoryRequestSequence

    // Load existing room state in parallel
    const githubEventsIdentifier = getGitHubEventsIdentifier(joinedRoom)
    const supportsGitHubEvents = isRepoBackedRoomId(
      getGitHubSupportIdentifier(joinedRoom),
    )
    const [
      messagePage,
      tsks,
      focused,
      prs,
      roomParticipantsPage,
      history,
      reasoning,
      gh,
      ghStatus,
    ] = await Promise.all([
      fetchMessages(roomIdentifier),
      fetchTasks(roomIdentifier),
      fetchFocusRooms(roomIdentifier),
      fetchPresence(roomIdentifier),
      fetchParticipants(roomIdentifier),
      fetchActivityHistory(roomIdentifier, lastActivityHistoryRequest),
      fetchReasoningSessions(roomIdentifier),
      supportsGitHubEvents
        ? fetchGitHubEvents(githubEventsIdentifier)
        : Promise.resolve({
            events: [],
            available: false,
            hasMore: false,
            error: null,
          }),
      fetchTaskGithubStatus(roomIdentifier),
    ])
    messages.value = mergeMessages([], messagePage.messages)
    messagesHasOlder.value = messagePage.hasOlder
    tasks.value = tsks
    focusRooms.value = focused
    presence.value = prs
    boardHandoffPresence.value = prs
    participants.value = roomParticipantsPage.participants
    participantHiddenCount.value = roomParticipantsPage.hidden_count
    reasoningSessions.value = reasoning
    if (
      bootstrapActivityHistoryRequestId === activityHistoryRequestSequence &&
      room.value?.identifier === roomIdentifier
    ) {
      activityHistory.value = history
      activityHistoryLoading.value = false
      activityHistoryError.value = history
        ? ''
        : 'Could not load room activity history.'
    }
    taskGithubStatus.value = ghStatus
    githubEvents.value = gh.events
    githubEventsAvailable.value = gh.available
    githubEventsHasMore.value = gh.hasMore
    githubEventsError.value = gh.error
    githubEventsLoading.value = false

    // Start real-time streaming
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

/** ── Restore Session ── */
async function restoreSession(): Promise<boolean> {
  const saved = loadPersistedSession()
  if (!saved) return false
  return joinRoom(saved.identifier)
}

function leaveRoom() {
  stopStreaming()
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
  activityHistoryLoading.value = false
  activityHistoryError.value = ''
  lastActivityHistoryRequest = {}
  reasoningSessions.value = []
  githubEvents.value = []
  githubEventsAvailable.value = false
  githubEventsHasMore.value = false
  githubEventsError.value = null
  githubEventsLoading.value = false
  isConnected.value = false
  connectionState.value = 'idle'
  joinError.value = null
  clearPersistedSession()
}

/** ── Cleanup ── */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    stopStreaming()
  })
}

/** ── Composable ── */
export function useRoom() {
  onUnmounted(() => {
    // Don't stop streaming on unmount — other components may need it
    // Only stopStreaming when explicitly leaving
  })

  return {
    // State
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

    // Actions
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

    // Utilities
    getSenderColor,
    parseAgentIdentity,
    isHumanSender,
  }
}
