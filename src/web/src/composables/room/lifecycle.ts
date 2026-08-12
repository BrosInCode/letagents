import { apiFetch, roomPath } from './api'
import { mergeMessages } from './data'
import { joinRoomSession, loadRoomBootstrap } from './join'
import {
  clearPersistedSession,
  loadPersistedSession,
  persistRoomSession,
} from './session'
import {
  activityHistory,
  activityHistoryError,
  activityHistoryLoading,
  boardHandoffPresence,
  connectionState,
  focusRooms,
  getActivityHistoryRequestSequence,
  getLastActivityHistoryRequest,
  githubEvents,
  githubEventsAvailable,
  githubEventsError,
  githubEventsHasMore,
  githubEventsLoading,
  isConnected,
  joinError,
  messages,
  messagesHasOlder,
  participantHiddenCount,
  participants,
  presence,
  reasoningSessions,
  replaceRoomMessages,
  resetRoomState,
  room,
  roomArtifacts,
  taskGithubStatus,
  tasks,
} from './state'

interface RoomLifecycleDeps {
  startParticipantRefreshLoop: (roomIdentifier: string) => void
  startPresenceRefreshLoop: (roomIdentifier: string) => void
  startStreaming: (roomIdentifier: string, bootstrap?: boolean) => Promise<void>
  finishStreamingBootstrap: (roomIdentifier: string, snapshotCommitted: boolean) => void
  stopStreaming: () => void
}

export function createRoomLifecycle(deps: RoomLifecycleDeps) {
  async function joinRoom(roomIdentifier: string) {
    let bootstrapStreamStarted = false
    deps.stopStreaming()
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
      bootstrapStreamStarted = true
      await deps.startStreaming(roomIdentifier, true)
      const bootstrapActivityHistoryRequestId =
        getActivityHistoryRequestSequence()
      const bootstrap = await loadRoomBootstrap(
        joinedRoom,
        getLastActivityHistoryRequest(),
      )
      replaceRoomMessages(mergeMessages([], bootstrap.messagePage.messages))
      messagesHasOlder.value = bootstrap.messagePage.hasOlder
      tasks.value = bootstrap.tasks
      focusRooms.value = bootstrap.focusRooms
      presence.value = bootstrap.presence
      boardHandoffPresence.value = bootstrap.presence
      participants.value = bootstrap.participantsPage.participants
      participantHiddenCount.value = bootstrap.participantsPage.hidden_count
      reasoningSessions.value = bootstrap.reasoningSessions
      roomArtifacts.value = bootstrap.roomArtifacts
      if (
        bootstrapActivityHistoryRequestId ===
          getActivityHistoryRequestSequence() &&
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

      deps.finishStreamingBootstrap(roomIdentifier, true)
      bootstrapStreamStarted = false

      deps.startPresenceRefreshLoop(roomIdentifier)
      deps.startParticipantRefreshLoop(roomIdentifier)
      connectionState.value = 'live'
      return true
    } catch (err) {
      if (bootstrapStreamStarted) {
        deps.finishStreamingBootstrap(roomIdentifier, false)
      }
      deps.stopStreaming()
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

  function leaveRoom() {
    deps.stopStreaming()
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
    clearPersistedSession()
  }

  async function restoreSession(): Promise<boolean> {
    const saved = loadPersistedSession()
    if (!saved) return false
    return joinRoom(saved.identifier)
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

  return {
    joinRoom,
    leaveRoom,
    renameRoom,
    restoreSession,
  }
}
