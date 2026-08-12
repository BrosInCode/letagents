import { isRepoBackedRoomId } from '../roomGitHubEvents'
import { apiFetch, roomPath } from './api'
import { HANDOFF_PRESENCE_PAGE_SIZE } from './constants'
import {
  fetchActivityHistory,
  fetchFocusRooms,
  fetchGitHubEvents,
  fetchMessages,
  fetchMessagesAfter,
  fetchParticipants,
  fetchPresence,
  fetchRoomArtifacts,
  fetchTaskGithubStatus,
  fetchTasks,
  getGitHubEventsIdentifier,
  mergeMessages,
} from './data'
import { fetchReasoningSessions } from './reasoning'
import {
  activityHistory,
  activityHistoryError,
  activityHistoryLoading,
  activityLoading,
  boardHandoffPresence,
  boardLoading,
  focusRooms,
  focusRoomsLoading,
  getLastActivityHistoryRequest,
  githubEvents,
  githubEventsAvailable,
  githubEventsError,
  githubEventsHasMore,
  githubEventsLoading,
  githubEventsSupported,
  isCurrentActivityHistoryRequest,
  messages,
  messagesHasOlder,
  nextActivityHistoryRequestSequence,
  participantHiddenCount,
  participants,
  presence,
  reasoningSessions,
  replaceRoomMessages,
  room,
  roomArtifacts,
  setLastActivityHistoryRequest,
  taskGithubStatus,
  tasks,
  type ActivityHistoryRequest,
} from './state'
import { fetchTasksAndPresence } from './taskActions'

const MAX_MESSAGE_REPAIR_PAGES_PER_PASS = 4
const MAX_MESSAGE_REPAIR_MESSAGES_PER_PASS = 400
const MAX_MESSAGE_REPAIR_BYTES_PER_PASS = 2 * 1024 * 1024
const MAX_MESSAGE_REPAIR_WORK_MS_PER_PASS = 100

interface RoomRefreshControllerDeps {
  refreshParticipants: (roomIdentifier: string) => Promise<void>
  refreshPresence: (roomIdentifier: string) => Promise<void>
}

export function createRoomRefreshController(
  deps: RoomRefreshControllerDeps,
) {
  let activityRefreshGeneration = 0
  let githubEventsRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let roomArtifactsRefreshTimer: ReturnType<typeof setTimeout> | null = null
  const windowedGapMessageRepairs = new Set<string>()

  async function refreshTasksAndPresence(roomIdentifier: string) {
    const [next, nextArtifacts] = await Promise.all([
      fetchTasksAndPresence(roomIdentifier),
      fetchRoomArtifacts(roomIdentifier),
    ])
    if (room.value?.identifier !== roomIdentifier) return
    tasks.value = next.tasks
    presence.value = next.presence
    boardHandoffPresence.value = next.presence
    roomArtifacts.value = nextArtifacts
  }

  async function loadActivityHistory(
    options?: ActivityHistoryRequest,
  ): Promise<boolean> {
    if (!room.value) return false
    const roomIdentifier = room.value.identifier
    const previousRequest = getLastActivityHistoryRequest()
    const nextRequest = {
      query: options?.query ?? previousRequest.query,
      page: options?.page ?? previousRequest.page ?? 1,
      pageSize: options?.pageSize ?? previousRequest.pageSize ?? 20,
      kind: options?.kind ?? previousRequest.kind ?? 'all',
      roomId: options?.roomId ?? previousRequest.roomId ?? roomIdentifier,
    }
    setLastActivityHistoryRequest(nextRequest)
    const requestId = nextActivityHistoryRequestSequence()

    activityHistoryLoading.value = true
    activityHistoryError.value = ''
    try {
      const next = await fetchActivityHistory(roomIdentifier, nextRequest)
      if (
        !isCurrentActivityHistoryRequest(requestId) ||
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
      if (isCurrentActivityHistoryRequest(requestId)) {
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
        deps.refreshParticipants(room.value.identifier),
        deps.refreshPresence(room.value.identifier),
      ])
      const previousRequest = getLastActivityHistoryRequest()
      if (
        (activityHistory.value?.selected_room_id ||
          previousRequest.roomId ||
          room.value.identifier) === room.value.identifier
      ) {
        await loadActivityHistory({
          ...previousRequest,
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

  async function refreshRoomMessages(
    after: string | null = null,
    authoritativeGap = false,
    isCurrent: () => boolean = () => true,
  ): Promise<{ success: boolean; cursor: string | null; complete?: boolean }> {
    if (!room.value) return { success: false, cursor: after }
    const roomIdentifier = room.value.identifier
    const canCommit = () => isCurrent() && room.value?.identifier === roomIdentifier
    if (!after) {
      try {
        const page = await fetchMessages(roomIdentifier)
        if (!canCommit()) return { success: false, cursor: after }
        replaceRoomMessages(mergeMessages(messages.value, page.messages))
        messagesHasOlder.value = page.hasOlder || messagesHasOlder.value
        return {
          success: true,
          cursor: page.messages[page.messages.length - 1]?.id ?? null,
        }
      } catch {
        return { success: false, cursor: after }
      }
    }

    try {
      let cursor = after
      let hasMore = false
      let pages = 0
      let repairedMessages = 0
      let repairedBytes = 0
      const startedAt = Date.now()
      const batch = [] as typeof messages.value
      if (!authoritativeGap && canCommit()) windowedGapMessageRepairs.delete(roomIdentifier)
      if (authoritativeGap && canCommit()) windowedGapMessageRepairs.add(roomIdentifier)
      do {
        const page = await fetchMessagesAfter(roomIdentifier, cursor)
        if (!canCommit()) {
          return { success: false, cursor: after }
        }
        hasMore = page.hasMore
        if (page.messages.length === 0) {
          return { success: !hasMore, cursor, ...(hasMore ? { complete: false } : {}) }
        }
        pages += 1
        repairedMessages += page.messages.length
        try {
          repairedBytes += new TextEncoder().encode(JSON.stringify(page.messages)).byteLength
        } catch {
          repairedBytes = MAX_MESSAGE_REPAIR_BYTES_PER_PASS + 1
        }
        if (!windowedGapMessageRepairs.has(roomIdentifier)) batch.push(...page.messages)
        const nextCursor = page.messages[page.messages.length - 1]?.id
        if (!nextCursor || nextCursor === cursor) {
          return { success: false, cursor: after }
        }
        cursor = nextCursor
      } while (
        hasMore
        && pages < MAX_MESSAGE_REPAIR_PAGES_PER_PASS
        && repairedMessages < MAX_MESSAGE_REPAIR_MESSAGES_PER_PASS
        && repairedBytes < MAX_MESSAGE_REPAIR_BYTES_PER_PASS
        && Date.now() - startedAt < MAX_MESSAGE_REPAIR_WORK_MS_PER_PASS
      )
      if (!canCommit()) return { success: false, cursor: after }
      if (batch.length > 0) replaceRoomMessages(mergeMessages(messages.value, batch))
      if (hasMore) {
        return { success: true, cursor, complete: false }
      }
      if (windowedGapMessageRepairs.has(roomIdentifier)) {
        const latest = await fetchMessages(roomIdentifier)
        if (!canCommit()) {
          return { success: false, cursor: after }
        }
        replaceRoomMessages(latest.messages)
        messagesHasOlder.value = latest.hasOlder
        windowedGapMessageRepairs.delete(roomIdentifier)
      }
      return { success: true, cursor }
    } catch {
      // The live stream remains connected; its next reconciliation tick will retry.
      return { success: false, cursor: after }
    }
  }

  async function refreshGitHubEvents(
    roomIdentifier: string,
    supported = isRepoBackedRoomId(roomIdentifier),
    isCurrent: () => boolean = () => true,
  ) {
    if (!supported) {
      if (!isCurrent()) return false
      githubEvents.value = []
      githubEventsAvailable.value = false
      githubEventsHasMore.value = false
      githubEventsError.value = null
      githubEventsLoading.value = false
      return true
    }

    githubEventsLoading.value = true
    try {
      const next = await fetchGitHubEvents(roomIdentifier)
      if (!isCurrent()) return false
      githubEvents.value = next.events
      githubEventsAvailable.value = next.available
      githubEventsHasMore.value = next.hasMore
      githubEventsError.value = next.error
      return true
    } finally {
      if (isCurrent()) githubEventsLoading.value = false
    }
  }

  async function refreshRoomGitHubEvents(
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!room.value) return false
    const roomIdentifier = room.value.identifier
    const repaired = await refreshGitHubEvents(
      getGitHubEventsIdentifier(room.value),
      githubEventsSupported.value,
      () => isCurrent() && room.value?.identifier === roomIdentifier,
    )
    return repaired === true
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

  function stopGitHubEventsRefresh() {
    if (githubEventsRefreshTimer) {
      clearTimeout(githubEventsRefreshTimer)
      githubEventsRefreshTimer = null
    }
  }

  async function refreshRoomArtifacts(roomIdentifier: string): Promise<boolean> {
    const nextArtifacts = await fetchRoomArtifacts(roomIdentifier)
    if (room.value?.identifier !== roomIdentifier) return false
    roomArtifacts.value = nextArtifacts
    return true
  }

  function scheduleRoomArtifactsRefresh(roomIdentifier: string) {
    if (roomArtifactsRefreshTimer) return
    roomArtifactsRefreshTimer = setTimeout(() => {
      roomArtifactsRefreshTimer = null
      void refreshRoomArtifacts(roomIdentifier)
    }, 350)
  }

  function stopRoomArtifactsRefresh() {
    if (roomArtifactsRefreshTimer) {
      clearTimeout(roomArtifactsRefreshTimer)
      roomArtifactsRefreshTimer = null
    }
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
      const [
        nextTasks,
        nextGithubStatus,
        nextPresence,
        nextArtifacts,
      ] = await Promise.all([
        fetchTasks(roomIdentifier),
        fetchTaskGithubStatus(roomIdentifier),
        fetchPresence(roomIdentifier, HANDOFF_PRESENCE_PAGE_SIZE),
        fetchRoomArtifacts(roomIdentifier),
      ])
      if (room.value?.identifier !== roomIdentifier) return false
      tasks.value = nextTasks
      taskGithubStatus.value = nextGithubStatus
      boardHandoffPresence.value = nextPresence
      roomArtifacts.value = nextArtifacts
      return true
    } finally {
      boardLoading.value = false
    }
  }

  async function refreshRoomActivity(
    options: { includeMessages?: boolean } = {},
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!room.value) return false
    const requestGeneration = ++activityRefreshGeneration
    const roomIdentifier = room.value.identifier
    const previousRequest = getLastActivityHistoryRequest()
    const historyRequest = {
      ...previousRequest,
      roomId: previousRequest.roomId ?? roomIdentifier,
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
        nextArtifacts,
      ] = await Promise.all([
        options.includeMessages === false ? Promise.resolve(null) : fetchMessages(roomIdentifier),
        fetchPresence(roomIdentifier),
        fetchParticipants(roomIdentifier),
        fetchReasoningSessions(roomIdentifier),
        fetchActivityHistory(roomIdentifier, historyRequest),
        fetchTasks(roomIdentifier),
        fetchTaskGithubStatus(roomIdentifier),
        fetchRoomArtifacts(roomIdentifier),
      ])
      if (!isCurrent() || room.value?.identifier !== roomIdentifier) return false
      if (messagePage) {
        replaceRoomMessages(mergeMessages(messages.value, messagePage.messages))
        messagesHasOlder.value = messagePage.hasOlder || messagesHasOlder.value
      }
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
      roomArtifacts.value = nextArtifacts
      return true
    } finally {
      // Lifecycle reset clears the shared flag immediately. A retired request
      // may relinquish its own flag, but can never clear a newer refresh.
      if (activityRefreshGeneration === requestGeneration) activityLoading.value = false
    }
  }

  async function refreshRoomFocusRooms(): Promise<boolean> {
    if (!room.value) return false
    const roomIdentifier = room.value.identifier
    focusRoomsLoading.value = true
    try {
      const [nextFocusRooms, nextTasks, nextArtifacts] = await Promise.all([
        fetchFocusRooms(roomIdentifier),
        fetchTasks(roomIdentifier),
        fetchRoomArtifacts(roomIdentifier),
      ])
      if (room.value?.identifier !== roomIdentifier) return false
      focusRooms.value = nextFocusRooms
      tasks.value = nextTasks
      roomArtifacts.value = nextArtifacts
      return true
    } finally {
      focusRoomsLoading.value = false
    }
  }

  return {
    clearDisconnectedParticipants,
    loadActivityHistory,
    refreshFocusRooms,
    refreshReasoningSessions,
    refreshRoomActivity,
    refreshRoomBoard,
    refreshRoomFocusRooms,
    refreshRoomGitHubEvents,
    refreshRoomMessages,
    refreshTaskGithubStatus,
    refreshTasksAndPresence,
    scheduleGitHubEventsRefresh,
    scheduleRoomArtifactsRefresh,
    stopGitHubEventsRefresh,
    stopRoomArtifactsRefresh,
  }
}
