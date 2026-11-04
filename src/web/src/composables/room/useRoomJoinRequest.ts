import { computed, onScopeDispose, ref, watch } from 'vue'
import { joinRequestRetryAt, resolveJoinRequestView, type JoinRequestView } from './joinRequestView'
import {
  asRoomApiError,
  cancelRoomJoinRequest,
  fetchRoomMembership,
  isFocusRoomId,
  joinRequestFromPayload,
  ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY,
  requestRoomAccess,
  type RoomJoinRequestSummary,
} from './membership'

/**
 * Ask-to-join state for a person who is not a member of a room. It never polls:
 * the caller runs check() on window focus, when a panel opens, or from a button.
 */
export function useRoomJoinRequest(options: {
  room: () => string
  initialRequest?: RoomJoinRequestSummary | null
  onMember: () => void
}) {
  const joinRequest = ref<RoomJoinRequestSummary | null>(options.initialRequest ?? null)
  // A focus room takes no requests: the person asks to join its main room. The
  // id tells first; a 400 answer from the server says the same.
  const mainRoomOnlyAnswered = ref(false)
  const mainRoomOnly = computed(() => mainRoomOnlyAnswered.value || isFocusRoomId(options.room()))
  /** The action that runs now, so each button can show its own progress. */
  const busyAction = ref<'ask' | 'cancel' | 'check' | null>(null)
  const busy = computed(() => busyAction.value !== null)
  const error = ref('')
  const now = ref(Date.now())
  const view = computed<JoinRequestView>(() => mainRoomOnly.value
    ? { kind: 'main_room_only' }
    : resolveJoinRequestView(joinRequest.value, now.value))

  // One timer flips "Declined" back to "Ask to join" when the wait ends.
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const clearRetryTimer = () => {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
  }
  watch(joinRequest, (request) => {
    clearRetryTimer()
    const retryAt = joinRequestRetryAt(request)
    if (retryAt === null || retryAt <= Date.now()) return
    retryTimer = setTimeout(() => { now.value = Date.now() }, Math.min(retryAt - Date.now() + 500, 2 ** 31 - 1))
  }, { immediate: true })
  onScopeDispose(clearRetryTimer)

  async function run(kind: NonNullable<typeof busyAction.value>, action: (room: string) => Promise<void>, failure: string) {
    const room = options.room()
    if (busy.value || !room) return
    busyAction.value = kind
    error.value = ''
    try {
      await action(room)
    } catch (cause) {
      error.value = asRoomApiError(cause).message || failure
    } finally {
      busyAction.value = null
      now.value = Date.now()
    }
  }

  /** Reads the membership state. Returns true when the person is a member now. */
  async function readMembership(room: string): Promise<boolean> {
    const state = await fetchRoomMembership(room)
    if (state.member) {
      options.onMember()
      return true
    }
    joinRequest.value = state.join_request ?? null
    return false
  }

  const check = () => run('check', async (room) => { await readMembership(room) }, 'Could not check your access. Try again.')

  const ask = () => run('ask', async (room) => {
    try {
      joinRequest.value = await requestRoomAccess(room) ?? joinRequest.value
    } catch (cause) {
      const failure = asRoomApiError(cause)
      // A recent decline answers with the declined request and when to ask again.
      const answered = joinRequestFromPayload(failure.payload)
      if (answered) {
        joinRequest.value = answered
        return
      }
      // A conflict can mean the person is a member already: look before failing.
      if (failure.status === 409 && await readMembership(room)) return
      if (failure.code === ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY) {
        mainRoomOnlyAnswered.value = true
        return
      }
      throw failure
    }
  }, 'Could not send your request. Try again.')

  const cancel = () => run('cancel', async (room) => {
    const current = view.value
    if (current.kind !== 'pending') return
    try {
      joinRequest.value = await cancelRoomJoinRequest(room, current.requestId) ?? null
    } catch (cause) {
      // An admin may have answered first: show that answer instead of an error.
      const answered = joinRequestFromPayload(asRoomApiError(cause).payload)
      if (!answered) throw cause
      joinRequest.value = answered
      if (answered.state === 'approved') await readMembership(room)
    }
  }, 'Could not cancel your request. Try again.')

  return { joinRequest, view, busy, busyAction, error, now, ask, cancel, check }
}
