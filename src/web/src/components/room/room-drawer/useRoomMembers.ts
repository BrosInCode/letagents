import { computed, ref, type Ref } from 'vue'
import { roomAccessRefusal } from '../../../../../../shared/room-membership.mjs'
import type { RoomInfo } from '../../../composables/room/types'
import {
  asRoomApiError,
  decideRoomJoinRequest,
  fetchPendingRoomJoinRequests,
  fetchRoomMembers,
  fetchRoomMembership,
  joinRequestFromPayload,
  removeRoomMember,
  setRoomMemberRole,
  type RoomJoinRequest,
  type RoomJoinRequestSummary,
  type RoomMember,
  type RoomMemberList,
} from '../../../composables/room/membership'

/**
 * Members and pending requests of the room shown in the drawer. The lists load
 * when the drawer opens and after each change; nothing refreshes on a timer.
 */
export function useRoomMembers(room: Readonly<Ref<RoomInfo | null>>, viewerAccountId: () => string | null) {
  const list = ref<RoomMemberList | null>(null)
  const requests = ref<RoomJoinRequest[]>([])
  const requestsError = ref('')
  const loading = ref(false)
  const loadError = ref('')
  const actionError = ref('')
  const busyKey = ref<string | null>(null)
  /** Set when the viewer is not a member: their latest request, if any. */
  const notMember = ref<{ joinRequest: RoomJoinRequestSummary | null } | null>(null)
  /** The display name of the room whose members these are: a focus room's parent. */
  const accessRoomName = ref('')
  let loadVersion = 0

  const roomId = computed(() => room.value?.identifier || '')
  const managedOnGitHub = computed(() => list.value?.managed_by === 'github')
  const canManage = computed(() => Boolean(list.value?.can_manage) && !managedOnGitHub.value)
  const inheritsMembers = computed(() => Boolean(list.value && list.value.access_room_id !== list.value.room_id))

  function reset() {
    loadVersion += 1
    list.value = null
    requests.value = []
    requestsError.value = ''
    loading.value = false
    loadError.value = ''
    actionError.value = ''
    notMember.value = null
    accessRoomName.value = ''
  }

  async function load() {
    const id = roomId.value
    if (!id) return
    const version = ++loadVersion
    loading.value = true
    loadError.value = ''
    try {
      const members = await fetchRoomMembers(id)
      let pending: RoomJoinRequest[] = []
      let pendingError = ''
      if (members.can_manage && members.managed_by === 'letagents') {
        try {
          pending = await fetchPendingRoomJoinRequests(id)
        } catch (cause) {
          pendingError = asRoomApiError(cause).message || 'Could not load requests.'
        }
      }
      // A focus room's members are its parent's; name the parent, once, for the Leave and Remove text.
      const parentName = members.access_room_id !== members.room_id && !accessRoomName.value
        ? await fetchRoomMembership(id).then(state => state.display_name, () => '')
        : ''
      if (version !== loadVersion) return
      if (parentName) accessRoomName.value = parentName
      list.value = members
      requests.value = pending
      requestsError.value = pendingError
      notMember.value = null
    } catch (cause) {
      if (version !== loadVersion) return
      const failure = asRoomApiError(cause)
      list.value = null
      requests.value = []
      if (roomAccessRefusal(failure.payload) === 'membership_required') {
        notMember.value = { joinRequest: joinRequestFromPayload(failure.payload) }
      } else {
        loadError.value = failure.message || 'Could not load members.'
      }
    } finally {
      if (version === loadVersion) loading.value = false
    }
  }

  async function act(key: string, action: (room: string) => Promise<void>, failure: string): Promise<boolean> {
    const id = roomId.value
    if (busyKey.value || !id) return false
    busyKey.value = key
    actionError.value = ''
    try {
      await action(id)
      return true
    } catch (cause) {
      // The server explains refusals such as removing the last admin.
      actionError.value = asRoomApiError(cause).message || failure
      return false
    } finally {
      busyKey.value = null
    }
  }

  const setRole = async (member: RoomMember, role: RoomMember['role']) => {
    const changed = await act(`role:${member.account_id}`, id => setRoomMemberRole(id, member.account_id, role).then(() => undefined),
      'Could not change the role.')
    if (changed) await load()
    return changed
  }

  const remove = async (member: RoomMember) => {
    const removed = await act(`remove:${member.account_id}`, id => removeRoomMember(id, member.account_id).then(() => undefined),
      'Could not remove the member.')
    if (removed) await load()
    return removed
  }

  /** Leaves the room. The caller moves away from the room when this returns true. */
  const leave = () => {
    const self = viewerAccountId()
    if (!self) return Promise.resolve(false)
    return act('leave', id => removeRoomMember(id, self).then(() => undefined), 'Could not leave the room.')
  }

  const decide = async (request: RoomJoinRequest, decision: 'approve' | 'decline') => {
    if (busyKey.value) return false
    const done = await act(`${decision}:${request.id}`, id => decideRoomJoinRequest(id, request.id, decision).then(() => undefined),
      decision === 'approve' ? 'Could not approve the request.' : 'Could not decline the request.')
    // Reload after a failure too: another admin may have answered the request first.
    await load()
    return done
  }

  return {
    list,
    requests,
    requestsError,
    loading,
    loadError,
    actionError,
    busyKey,
    notMember,
    accessRoomName,
    managedOnGitHub,
    canManage,
    inheritsMembers,
    reset,
    load,
    setRole,
    remove,
    leave,
    decide,
  }
}
