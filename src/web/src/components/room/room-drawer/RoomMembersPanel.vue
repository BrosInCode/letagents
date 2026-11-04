<template>
  <div v-if="canManage" class="drawer-section drawer-panel members-panel">
    <div class="drawer-section-title">
      <h2>Requests</h2>
      <span v-if="requests.length">{{ requests.length }} waiting</span>
    </div>
    <p v-if="requestsError" class="members-error" role="alert">{{ requestsError }}</p>
    <p v-else-if="!requests.length" class="members-note">No one is waiting to join.</p>
    <ul v-else class="member-list">
      <li v-for="request in requests" :key="request.id" class="member-row">
        <img v-if="request.avatar_url" class="member-avatar" :src="request.avatar_url" alt="" width="28" height="28" />
        <span v-else class="member-avatar fallback" aria-hidden="true">{{ initial(request) }}</span>
        <span class="member-name">
          <strong>{{ request.display_name || request.login }}</strong>
          <small>@{{ request.login }} · asked {{ askedLabel(request.created_at) }}</small>
        </span>
        <span class="member-actions">
          <button type="button" class="member-action primary" :disabled="Boolean(busyKey)" @click="decide(request, 'approve')">
            {{ busyKey === `approve:${request.id}` ? 'Approving…' : 'Approve' }}
          </button>
          <button type="button" class="member-action" :disabled="Boolean(busyKey)" @click="decide(request, 'decline')">
            {{ busyKey === `decline:${request.id}` ? 'Declining…' : 'Decline' }}
          </button>
        </span>
      </li>
    </ul>
  </div>

  <div class="drawer-section drawer-panel members-panel">
    <div class="drawer-section-title">
      <h2>Members</h2>
      <span v-if="list && !managedOnGitHub">{{ list.members.length }}</span>
    </div>

    <p v-if="managedOnGitHub" class="members-note">
      Members are managed on GitHub. People with a role on the repository can open this room.
    </p>
    <template v-else-if="notMember">
      <p class="members-note">{{ notMemberText }}</p>
      <p v-if="access.error.value" class="members-error" role="alert">{{ access.error.value }}</p>
      <span class="member-actions">
        <button v-if="access.view.value.kind === 'ask'" type="button" class="member-action primary" :disabled="access.busy.value" @click="access.ask">
          {{ access.busy.value ? 'Sending…' : 'Ask to join' }}
        </button>
        <button v-if="access.view.value.kind === 'pending'" type="button" class="member-action" :disabled="access.busy.value" @click="access.cancel">
          Cancel request
        </button>
      </span>
    </template>
    <p v-else-if="loadError" class="members-error" role="alert">
      {{ loadError }}
      <button type="button" class="member-action" @click="load">Retry</button>
    </p>
    <p v-else-if="!list" class="members-note">Loading members…</p>
    <template v-else>
      <p v-if="inheritsMembers" class="members-note">This focus room uses the members of its parent room.</p>
      <ul class="member-list">
        <li v-for="member in list.members" :key="member.account_id" class="member-row">
          <img v-if="member.avatar_url" class="member-avatar" :src="member.avatar_url" alt="" width="28" height="28" />
          <span v-else class="member-avatar fallback" aria-hidden="true">{{ initial(member) }}</span>
          <span class="member-name">
            <strong>{{ member.display_name || member.login }}<template v-if="isSelf(member)"> (you)</template></strong>
            <small>@{{ member.login }}</small>
          </span>
          <span v-if="member.role === 'admin'" class="member-role">Admin</span>
          <span v-if="isSelf(member) || canManage" class="member-actions">
            <button v-if="isSelf(member)" type="button" class="member-action" :disabled="Boolean(busyKey)" @click="confirmLeave">
              {{ busyKey === 'leave' ? 'Leaving…' : 'Leave' }}
            </button>
            <template v-else>
              <button type="button" class="member-action" :disabled="Boolean(busyKey)"
                @click="setRole(member, member.role === 'admin' ? 'member' : 'admin')">
                {{ busyKey === `role:${member.account_id}` ? 'Saving…' : member.role === 'admin' ? 'Make member' : 'Make admin' }}
              </button>
              <button type="button" class="member-action danger" :disabled="Boolean(busyKey)" @click="confirmRemove(member)">
                {{ busyKey === `remove:${member.account_id}` ? 'Removing…' : 'Remove' }}
              </button>
            </template>
          </span>
        </li>
      </ul>
    </template>
    <p v-if="actionError" class="members-error" role="alert">{{ actionError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, toRef, watch } from 'vue'
import { useAuth } from '@/composables/useAuth'
import { formatJoinRequestTime } from '@/composables/room/joinRequestView'
import type { RoomInfo } from '@/composables/room/types'
import type { RoomJoinRequest, RoomMember } from '@/composables/room/membership'
import { useRoomJoinRequest } from '@/composables/room/useRoomJoinRequest'
import { useRoomMembers } from './useRoomMembers'

const props = defineProps<{
  open: boolean
  room: RoomInfo | null
}>()

const emit = defineEmits<{ left: [] }>()

const auth = useAuth()
const viewerAccountId = () => auth.user.value?.id ?? null
const {
  list,
  requests,
  requestsError,
  loadError,
  actionError,
  busyKey,
  notMember,
  managedOnGitHub,
  canManage,
  inheritsMembers,
  reset,
  load,
  setRole,
  remove,
  leave,
  decide,
} = useRoomMembers(toRef(props, 'room'), viewerAccountId)

// Before the server enforces members, a person who is not a member can still
// open the room; they can ask to join from here.
const access = useRoomJoinRequest({
  room: () => props.room?.identifier || '',
  onMember: () => { void load() },
})
watch(notMember, (state) => { access.joinRequest.value = state?.joinRequest ?? null })

const notMemberText = computed(() => {
  const view = access.view.value
  if (view.kind === 'pending') return 'You are not a member yet. Your request is waiting for an admin.'
  if (view.kind === 'declined') return `You are not a member. A room admin declined your request. You can ask again ${formatJoinRequestTime(view.retryAt, access.now.value)}.`
  return 'You are not a member of this room yet.'
})

watch(() => props.room?.identifier, () => reset())
watch([() => props.open, () => props.room?.identifier], ([open, roomId]) => {
  if (open && roomId) void load()
}, { immediate: true })

function isSelf(member: RoomMember) {
  return member.account_id === viewerAccountId()
}

function initial(person: Pick<RoomMember, 'display_name' | 'login'>) {
  return (person.display_name || person.login || '?').trim().charAt(0).toUpperCase() || '?'
}

function askedLabel(createdAt: RoomJoinRequest['created_at']) {
  const at = Date.parse(createdAt)
  return Number.isFinite(at) ? formatJoinRequestTime(at, Date.now()) : 'recently'
}

async function confirmLeave() {
  if (!window.confirm('Leave this room? A room admin must let you in again before you can come back.')) return
  if (await leave()) emit('left')
}

async function confirmRemove(member: RoomMember) {
  const name = member.display_name || member.login
  if (!window.confirm(`Remove ${name} from this room? Their agents leave the room too.`)) return
  await remove(member)
}
</script>

<style scoped>
.members-note { margin: 0; color: var(--text-secondary); font-size: 0.82rem; line-height: 1.5; }
.members-error { margin: 0; color: var(--red-text, #ef4444); font-size: 0.78rem; line-height: 1.5; }
.member-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.member-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; column-gap: 10px; row-gap: 4px; padding: 6px 0; }
.member-avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
.member-avatar.fallback { display: grid; place-items: center; background: var(--accent-dim); color: var(--text); font-size: 0.75rem; font-weight: 700; }
.member-name { display: grid; min-width: 0; }
.member-name strong, .member-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-name strong { color: var(--text); font-size: 0.86rem; font-weight: 600; }
.member-name small { color: var(--text-secondary); font-size: 0.74rem; }
.member-role { padding: 2px 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-secondary); font-size: 0.68rem; font-weight: 650; }
.member-row .member-actions { grid-column: 2 / -1; }
.member-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.member-action { min-height: 32px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; font-size: 0.76rem; font-weight: 600; }
.member-action:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--border-strong); }
.member-action:disabled { cursor: wait; opacity: 0.55; }
.member-action.primary { background: var(--accent-dim); border-color: var(--border-strong); }
.member-action.danger { color: var(--red-text, #ef4444); }
.members-error .member-action { margin-left: 6px; }
@media (pointer: coarse) { .member-action { min-height: 44px; } }
</style>
