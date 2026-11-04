import { computed, onScopeDispose, ref, watch } from 'vue'
import { joinRequestRetryAt, resolveJoinRequestView } from './joinRequestView'
import {
  asRoomApiError,
  cancelRoomJoinRequest,
  fetchRoomMembership,
  joinRequestFromPayload,
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
  const busy = ref(false)
  const error = ref('')
  const now = ref(Date.now())
  const view = computed(() => resolveJoinRequestView(joinRequest.value, now.value))

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

  async function run(action: (room: string) => Promise<void>, failure: string) {
    const room = options.room()
    if (busy.value || !room) return
    busy.value = true
    error.value = ''
    try {
      await action(room)
    } catch (cause) {
      error.value = asRoomApiError(cause).message || failure
    } finally {
      busy.value = false
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

  const check = () => run(async (room) => { await readMembership(room) }, 'Could not check your access. Try again.')

  const ask = () => run(async (room) => {
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
      throw failure
    }
  }, 'Could not send your request. Try again.')

  const cancel = () => run(async (room) => {
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

  return { joinRequest, view, busy, error, now, ask, cancel, check }
}
