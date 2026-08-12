import { computed, ref } from 'vue'
import {
  isRepoBackedRoomId,
  type RoomGitHubEventsError,
} from '../roomGitHubEvents'
import { getGitHubSupportIdentifier } from './data'
import { upsertFocusRoomList } from './focusRooms'
import {
  mergeReasoningSession,
  sortReasoningSessions,
} from './reasoning'
import type {
  FocusRoomInfo,
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
  RoomSharedArtifact,
  RoomTask,
  TaskGitHubArtifactStatus,
} from './types'

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'error'

export type ActivityHistoryRequest = {
  query?: string
  page?: number
  pageSize?: number
  kind?: RoomActivityHistoryKind
  roomId?: string
}

export const messages = ref<RoomMessage[]>([])
let indexedMessages = messages.value
const messageIds = new Set<string>()

function ensureMessageIndex() {
  // Tests and legacy call sites may replace the exported ref directly. Rebuild
  // only on that snapshot boundary; steady-state live appends stay O(1).
  if (indexedMessages === messages.value) return
  indexedMessages = messages.value
  messageIds.clear()
  for (const message of indexedMessages) messageIds.add(message.id)
}

export function replaceRoomMessages(next: RoomMessage[]) {
  messages.value = next
  indexedMessages = next
  messageIds.clear()
  for (const message of next) messageIds.add(message.id)
}

export function appendRoomMessage(message: RoomMessage): boolean {
  ensureMessageIndex()
  if (messageIds.has(message.id)) return false
  // Vue tracks mutations on the reactive array. Avoid copying and rescanning
  // the complete transcript for every live event.
  messages.value.push(message)
  messageIds.add(message.id)
  return true
}
export const messagesHasOlder = ref(false)
export const isLoadingOlderMessages = ref(false)
export const presence = ref<RoomAgentPresence[]>([])
export const boardHandoffPresence = ref<RoomAgentPresence[]>([])
export const participants = ref<RoomParticipant[]>([])
export const participantHiddenCount = ref(0)
export const activityHistory = ref<RoomActivityHistoryPage | null>(null)
export const activityHistoryLoading = ref(false)
export const activityHistoryError = ref('')
export const reasoningSessions = ref<RoomReasoningSession[]>([])
export const taskGithubStatus =
  ref<Record<string, TaskGitHubArtifactStatus>>({})
export const roomArtifacts = ref<RoomSharedArtifact[]>([])
export const tasks = ref<RoomTask[]>([])
export const focusRooms = ref<FocusRoomInfo[]>([])
export const githubEvents = ref<RoomGitHubEvent[]>([])
export const githubEventsAvailable = ref(false)
export const githubEventsHasMore = ref(false)
export const githubEventsError = ref<RoomGitHubEventsError | null>(null)
export const githubEventsLoading = ref(false)
export const boardLoading = ref(false)
export const activityLoading = ref(false)
export const focusRoomsLoading = ref(false)
export const room = ref<RoomInfo | null>(null)
export const lastSendError = ref('')
export const isConnected = ref(false)
export const isStreaming = ref(false)
export const connectionState = ref<ConnectionState>('idle')
export const joinError = ref<RoomJoinError | null>(null)

let lastActivityHistoryRequest: ActivityHistoryRequest = {}
let activityHistoryRequestSequence = 0

export const githubEventsSupported = computed(() =>
  isRepoBackedRoomId(getGitHubSupportIdentifier(room.value)),
)

export function getLastActivityHistoryRequest(): ActivityHistoryRequest {
  return lastActivityHistoryRequest
}

export function setLastActivityHistoryRequest(
  request: ActivityHistoryRequest,
) {
  lastActivityHistoryRequest = request
}

export function getActivityHistoryRequestSequence(): number {
  return activityHistoryRequestSequence
}

export function nextActivityHistoryRequestSequence(): number {
  activityHistoryRequestSequence += 1
  return activityHistoryRequestSequence
}

export function isCurrentActivityHistoryRequest(requestId: number): boolean {
  return requestId === activityHistoryRequestSequence
}

export function resetRoomState(options: {
  activityHistoryLoading: boolean
  githubEventsLoading: boolean
  connectionState: 'idle' | 'connecting'
  activityHistoryRequest?: ActivityHistoryRequest
}) {
  nextActivityHistoryRequestSequence()
  room.value = null
  replaceRoomMessages([])
  messagesHasOlder.value = false
  isLoadingOlderMessages.value = false
  tasks.value = []
  roomArtifacts.value = []
  focusRooms.value = []
  presence.value = []
  boardHandoffPresence.value = []
  participants.value = []
  participantHiddenCount.value = 0
  activityHistory.value = null
  activityLoading.value = false
  activityHistoryLoading.value = options.activityHistoryLoading
  activityHistoryError.value = ''
  setLastActivityHistoryRequest(options.activityHistoryRequest || {})
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

export function upsertReasoningSession(
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

export function removeReasoningSession(sessionId: string) {
  reasoningSessions.value = reasoningSessions.value.filter(
    (session) => session.id !== sessionId,
  )
}

export function upsertTask(task: RoomTask) {
  const idx = tasks.value.findIndex((item) => item.id === task.id)
  if (idx >= 0) {
    const updated = [...tasks.value]
    updated[idx] = task
    tasks.value = updated
    return
  }
  tasks.value = [...tasks.value, task]
}

export function upsertFocusRoom(focusRoom: FocusRoomInfo) {
  focusRooms.value = upsertFocusRoomList(focusRooms.value, focusRoom)
}
