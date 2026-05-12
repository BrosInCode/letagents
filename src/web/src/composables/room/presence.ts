import { PRESENCE_REFRESH_INTERVAL_MS } from './constants'
import { fetchParticipants, fetchPresence } from './data'
import type { RoomAgentPresence, RoomParticipant } from './types'

interface PresenceControllerHandlers {
  getRoomIdentifier: () => string | null
  isCurrentRoom: (roomIdentifier: string) => boolean
  setPresence: (presence: RoomAgentPresence[]) => void
  setParticipants: (
    participants: RoomParticipant[],
    hiddenCount: number,
  ) => void
}

export function createPresenceController(handlers: PresenceControllerHandlers) {
  let presenceRefreshTimer: ReturnType<typeof setInterval> | null = null
  let presenceRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let participantRefreshTimer: ReturnType<typeof setInterval> | null = null
  let participantRefreshDebounceTimer: ReturnType<typeof setTimeout> | null =
    null

  async function refreshPresence(roomIdentifier: string) {
    handlers.setPresence(await fetchPresence(roomIdentifier))
  }

  async function refreshParticipants(roomIdentifier: string) {
    const next = await fetchParticipants(roomIdentifier)
    handlers.setParticipants(next.participants, next.hidden_count)
  }

  async function refreshRoomPresence(): Promise<boolean> {
    const roomIdentifier = handlers.getRoomIdentifier()
    if (!roomIdentifier) return false
    await refreshPresence(roomIdentifier)
    return true
  }

  async function refreshRoomReachability(): Promise<boolean> {
    const roomIdentifier = handlers.getRoomIdentifier()
    if (!roomIdentifier) return false
    const [nextPresence, nextParticipantsPage] = await Promise.all([
      fetchPresence(roomIdentifier),
      fetchParticipants(roomIdentifier),
    ])
    if (!handlers.isCurrentRoom(roomIdentifier)) return false
    handlers.setPresence(nextPresence)
    handlers.setParticipants(
      nextParticipantsPage.participants,
      nextParticipantsPage.hidden_count,
    )
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

  function stop() {
    stopPresenceRefreshLoop()
    stopParticipantRefreshLoop()
  }

  return {
    refreshPresence,
    refreshParticipants,
    refreshRoomPresence,
    refreshRoomReachability,
    schedulePresenceRefresh,
    scheduleParticipantRefresh,
    startPresenceRefreshLoop,
    startParticipantRefreshLoop,
    stop,
  }
}
