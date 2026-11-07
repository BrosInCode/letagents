import { computed, readonly, ref } from 'vue'
import {
  createJoinRequestSoundGate,
  type RoomJoinRequestAlert,
  type RoomJoinRequestEvent,
} from '../../../../shared/room-join-requests.mjs'
import {
  asRoomApiError,
  decideRoomJoinRequest,
  fetchPendingRoomJoinRequests,
} from './room/membership'
import { onJoinRequestDecided } from './roomJoinRequestDecided'
import { playJoinRequestSound } from './room/sound'
import { roomNotificationPreferences } from './room/notificationPreferences'
import { roomNotificationsSuppressed } from '../../../../shared/room-notification-preferences.mjs'

const DISMISSED_STORAGE_KEY = 'lac-join-request-dismissed'
const MAX_DISMISSED = 200
const MAX_TERMINAL = 200

export interface JoinRequestAlertDeps {
  fetchPending(room: string): Promise<RoomJoinRequestAlert[]>
  decide(room: string, requestId: string, decision: 'approve' | 'decline'): Promise<unknown>
  playSound(): void
  soundAllowed?(accessRoom: string): Promise<boolean>
  hidden(): boolean
  now?(): number
}

function readDismissed(): Set<string> {
  try {
    if (typeof sessionStorage === 'undefined') return new Set()
    const raw = sessionStorage.getItem(DISMISSED_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDismissed(ids: Set<string>): void {
  try {
    if (typeof sessionStorage === 'undefined') return
    sessionStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...ids].slice(-MAX_DISMISSED)))
  } catch {
    /* A closed banner that comes back after a reload is the only cost. */
  }
}

/**
 * The requests to join the open room that its admins have not answered yet,
 * for the banner at the top of the room. The room stream adds a request the
 * moment it arrives and drops it when any admin answers; opening the room as
 * an admin reads the ones already waiting. A new request plays the room sound
 * once (at most once a minute while the tab is hidden). Closing the banner is
 * remembered for this tab session; a decided request never comes back.
 */
export function createJoinRequestAlerts(deps: JoinRequestAlertDeps) {
  const roomId = ref<string | null>(null)
  const requests = ref<RoomJoinRequestAlert[]>([])
  const dismissed = ref(readDismissed())
  const busy = ref<string | null>(null)
  const error = ref('')
  const lastDecision = ref<{ outcome: 'approve' | 'decline'; request: RoomJoinRequestAlert } | null>(null)
  const gate = createJoinRequestSoundGate(deps.now ? { now: deps.now } : {})
  const terminal = new Set<string>()
  let loadVersion = 0
  let sessionVersion = 0

  const visible = computed(() => requests.value.filter(request => !dismissed.value.has(request.id)))

  /** The room the page shows now; a change clears the list. */
  function setRoom(id: string | null) {
    if (roomId.value === id) return
    loadVersion += 1
    sessionVersion += 1
    roomId.value = id
    requests.value = []
    busy.value = null
    error.value = ''
    lastDecision.value = null
  }

  /** Reads the requests already waiting. Only an admin's page calls this; the route refuses others. */
  async function load(): Promise<void> {
    const id = roomId.value
    if (!id) return
    const version = ++loadVersion
    try {
      const result = await deps.fetchPending(id)
      if (version !== loadVersion) return
      const pending = result.filter(request => !terminal.has(request.id))
      // Requests that were waiting before the page opened are not news: no sound.
      for (const request of pending) gate.remember(request.id)
      const live = new Map(requests.value.map(request => [request.id, request]))
      requests.value = [
        ...pending.map(request => live.get(request.id) ?? request),
        ...requests.value.filter(request => !pending.some(item => item.id === request.id)),
      ]
    } catch {
      // The banner shows what the stream delivers; the drawer shows the error on its own read.
    }
  }

  /** A `join_request` frame from the room stream of `streamRoomId`. */
  function receive(streamRoomId: string, event: RoomJoinRequestEvent): void {
    if (!roomId.value || streamRoomId !== roomId.value) return
    const request = event.request
    if (request.state !== 'pending') {
      forget(request.id)
      return
    }
    if (terminal.has(request.id) || requests.value.some(item => item.id === request.id)) return
    requests.value = [...requests.value, request]
    if (!gate.shouldPlay(request.id, deps.hidden())) return
    if (!deps.soundAllowed) {
      deps.playSound()
      return
    }
    const version = sessionVersion
    void deps.soundAllowed(event.access_room_id).then(allowed => {
      if (allowed && version === sessionVersion && !terminal.has(request.id)
        && !dismissed.value.has(request.id) && requests.value.some(item => item.id === request.id)) deps.playSound()
    }).catch(() => undefined)
  }

  /** Drops a request that was answered here or somewhere else (the drawer, another admin). */
  function forget(requestId: string): void {
    // A terminal frame can beat both the pending frame and the initial GET.
    terminal.add(requestId)
    if (terminal.size > MAX_TERMINAL) terminal.delete(terminal.values().next().value!)
    requests.value = requests.value.filter(item => item.id !== requestId)
  }

  function dismiss(requestIds: readonly string[] = visible.value.map(request => request.id)): void {
    const next = new Set(dismissed.value)
    for (const id of requestIds) next.add(id)
    dismissed.value = next
    writeDismissed(next)
  }

  async function decide(request: RoomJoinRequestAlert, decision: 'approve' | 'decline'): Promise<boolean> {
    const id = roomId.value
    if (!id || busy.value) return false
    const version = sessionVersion
    busy.value = `${decision}:${request.id}`
    error.value = ''
    lastDecision.value = null
    try {
      await deps.decide(id, request.id, decision)
      if (version !== sessionVersion) return false
      forget(request.id)
      lastDecision.value = { outcome: decision, request }
      return true
    } catch (cause) {
      if (version !== sessionVersion) return false
      const failure = asRoomApiError(cause)
      // Another admin answered first: the request is gone either way.
      if ((failure.payload as { code?: string } | undefined)?.code === 'ROOM_JOIN_REQUEST_NOT_PENDING') {
        forget(request.id)
        return false
      }
      error.value = failure.message || (decision === 'approve' ? 'Could not approve the request.' : 'Could not decline the request.')
      return false
    } finally {
      if (version === sessionVersion) busy.value = null
    }
  }

  function reset(): void {
    setRoom(null)
    sessionVersion += 1
    lastDecision.value = null
    terminal.clear()
    gate.reset()
  }

  return {
    roomId: readonly(roomId),
    requests: readonly(requests),
    visible,
    busy: readonly(busy),
    error: readonly(error),
    lastDecision: readonly(lastDecision),
    setRoom,
    load,
    receive,
    forget,
    dismiss,
    decide,
    reset,
  }
}

export const joinRequestAlerts = createJoinRequestAlerts({
  // The room route lists requests without the room's name; the banner names the room itself.
  fetchPending: room => fetchPendingRoomJoinRequests(room).then(list => list.map(request => ({ room_display_name: '', ...request }))),
  decide: decideRoomJoinRequest,
  playSound: playJoinRequestSound,
  soundAllowed: async accessRoom => {
    if (!roomNotificationPreferences.signedIn()) return false
    // Wait for the page's preference read, or load the parent for a focus room.
    await roomNotificationPreferences.allowsAfterRead(accessRoom, '')
    if (!roomNotificationPreferences.state(accessRoom).ready) await roomNotificationPreferences.refresh(accessRoom)
    return roomNotificationPreferences.signedIn()
      && !roomNotificationsSuppressed(roomNotificationPreferences.state(accessRoom).preference)
  },
  hidden: () => typeof document !== 'undefined' && document.hidden,
})

// A decision made in the drawer drops the request from the banner at once.
onJoinRequestDecided((requestId) => joinRequestAlerts.forget(requestId))

/** The room stream hands every `join_request` frame here. */
export function receiveRoomJoinRequestEvent(streamRoomId: string, event: RoomJoinRequestEvent): void {
  joinRequestAlerts.receive(streamRoomId, event)
}
