import { roomAccessRefusal } from '../../../../../shared/room-membership.mjs'
import { apiFetch, onRoomAccessRefused, roomPath, type RoomApiFailure } from './api'
import { mergeMessages } from './data'
import { joinRoomSession, loadRoomBootstrap } from './join'
import { joinRequestFromPayload } from './membership'
import type { RoomJoinError } from './types'
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
  messagesHasOlder,
  messagesLoaded,
  participantHiddenCount,
  participants,
  presence,
  presenceLoaded,
  reasoningSessions,
  replaceRoomMessages,
  resetRoomState,
  room,
  roomArtifacts,
  roomSessionVersion,
  setLastActivityHistoryRequest,
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

function roomJoinErrorFrom(error: RoomApiFailure, roomIdentifier: string): RoomJoinError {
  const payload = error.payload as {
    room_id?: string
    device_flow_url?: string
    display_name?: string | null
  } | null | undefined
  return {
    status: error.status ?? null,
    code: error.code ?? null,
    message: error.message || 'Could not connect to room.',
    roomId: payload?.room_id ?? roomIdentifier,
    deviceFlowUrl: payload?.device_flow_url ?? null,
    refusal: roomAccessRefusal(payload),
    displayName: typeof payload?.display_name === 'string' ? payload.display_name : null,
    joinRequest: joinRequestFromPayload(payload),
  }
}

export function createRoomLifecycle(deps: RoomLifecycleDeps) {
  async function joinRoom(roomIdentifier: string) {
    let bootstrapStreamStarted = false
    let streamingRoomIdentifier = roomIdentifier
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
    const sessionVersion = roomSessionVersion

    try {
      const joinedRoom = await joinRoomSession(roomIdentifier)
      const canonicalIdentifier = joinedRoom.identifier
      streamingRoomIdentifier = canonicalIdentifier
      const canonicalActivityHistoryRequest = {
        ...getLastActivityHistoryRequest(),
        roomId: canonicalIdentifier,
      }
      setLastActivityHistoryRequest(canonicalActivityHistoryRequest)
      room.value = joinedRoom
      isConnected.value = true
      persistRoomSession(room.value)
      bootstrapStreamStarted = true
      await deps.startStreaming(canonicalIdentifier, true)
      const bootstrapActivityHistoryRequestId =
        getActivityHistoryRequestSequence()
      const bootstrap = await loadRoomBootstrap(
        joinedRoom,
        canonicalActivityHistoryRequest,
      )
      // The room was closed or replaced while it loaded, for example by a
      // refusal: whoever closed it owns the screen now.
      if (roomSessionVersion !== sessionVersion) return false
      replaceRoomMessages(mergeMessages([], bootstrap.messagePage.messages))
      messagesHasOlder.value = bootstrap.messagePage.hasOlder
      messagesLoaded.value = true
      tasks.value = bootstrap.tasks
      focusRooms.value = bootstrap.focusRooms
      presence.value = bootstrap.presence
      presenceLoaded.value = true
      boardHandoffPresence.value = bootstrap.presence
      participants.value = bootstrap.participantsPage.participants
      participantHiddenCount.value = bootstrap.participantsPage.hidden_count
      reasoningSessions.value = bootstrap.reasoningSessions
      roomArtifacts.value = bootstrap.roomArtifacts
      if (
        bootstrapActivityHistoryRequestId ===
          getActivityHistoryRequestSequence() &&
        room.value?.identifier === canonicalIdentifier
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

      deps.finishStreamingBootstrap(canonicalIdentifier, true)
      bootstrapStreamStarted = false

      deps.startPresenceRefreshLoop(canonicalIdentifier)
      deps.startParticipantRefreshLoop(canonicalIdentifier)
      connectionState.value = 'live'
      return true
    } catch (err) {
      if (bootstrapStreamStarted) {
        deps.finishStreamingBootstrap(streamingRoomIdentifier, false)
      }
      deps.stopStreaming()
      connectionState.value = 'error'
      joinError.value = roomJoinErrorFrom(err as RoomApiFailure, roomIdentifier)
      console.error('[useRoom] joinRoom failed:', err)
      return false
    }
  }

  // A person removed from an open room gets a 403 refusal from its next read.
  // Close the room and show the access screen instead of retrying the refusal.
  const stopListening = onRoomAccessRefused((path, error) => {
    const current = room.value
    if (!current || !isConnected.value) return
    const roomPaths = [current.identifier, current.parentRoomId].filter(Boolean).map(id => roomPath(id!))
    if (!roomPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`))) return
    deps.stopStreaming()
    resetRoomState({
      activityHistoryLoading: false,
      githubEventsLoading: false,
      connectionState: 'idle',
    })
    connectionState.value = 'error'
    joinError.value = roomJoinErrorFrom(error, current.identifier)
  })

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
    /** Stops listening for refusals; the app keeps one lifecycle for its whole life. */
    dispose: stopListening,
  }
}
