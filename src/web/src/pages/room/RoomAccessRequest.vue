<template>
  <section class="room-access" aria-labelledby="room-access-title">
    <div class="room-access-copy" role="status">
      <span class="room-access-status" :data-state="state">
        <span class="room-access-dot" aria-hidden="true" />
        {{ statusLabel }}
      </span>
      <h2 id="room-access-title" class="room-access-title">{{ displayName || roomId }}</h2>
      <p class="room-access-body">{{ body }}</p>
    </div>
    <p v-if="errorText" class="room-access-error" role="alert">{{ errorText }}</p>
    <div ref="actionsElement" class="room-access-actions">
      <button v-if="state === 'ask'" class="room-access-btn primary" type="button" :disabled="busy" @click="joinRequest.ask">
        {{ joinRequest.busyAction.value === 'ask' ? 'Sending…' : 'Ask to join' }}
      </button>
      <button v-if="state !== 'ask'" class="room-access-btn" type="button" :disabled="busy" @click="checkAgain">
        {{ checking ? 'Checking…' : 'Check again' }}
      </button>
      <button v-if="state === 'pending'" class="room-access-btn secondary" type="button" :disabled="busy" @click="joinRequest.cancel">
        {{ joinRequest.busyAction.value === 'cancel' ? 'Cancelling…' : 'Cancel request' }}
      </button>
    </div>
    <p v-if="login" class="room-access-note">Signed in as {{ login }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
  roomAccessRefusal,
} from '../../../../../shared/room-membership.mjs'
import { formatJoinRequestTime } from '@/composables/room/joinRequestView'
import { asRoomApiError, fetchRoomMembership, type RoomJoinRequestSummary } from '@/composables/room/membership'
import type { RoomAccessRefusal } from '@/composables/room/types'
import { useRoomJoinRequest } from '@/composables/room/useRoomJoinRequest'

const props = defineProps<{
  refusal: RoomAccessRefusal
  roomId: string
  displayName: string | null
  initialRequest: RoomJoinRequestSummary | null
  login: string | null
}>()

const emit = defineEmits<{ retry: [] }>()

const joinRequest = useRoomJoinRequest({
  room: () => props.roomId,
  initialRequest: props.initialRequest,
  onMember: () => emit('retry'),
})

const repoChecking = ref(false)
const repoError = ref('')
const isRepoRoom = computed(() => props.refusal === 'repo_collaborator_required')
const busy = computed(() => joinRequest.busy.value || repoChecking.value)
const checking = computed(() => repoChecking.value || joinRequest.busyAction.value === 'check')
const errorText = computed(() => repoError.value || joinRequest.error.value)
const state = computed(() => isRepoRoom.value ? 'repo' : joinRequest.view.value.kind)

const statusLabel = computed(() => ({
  repo: 'GitHub role required',
  ask: 'Members only',
  pending: 'Waiting for an admin',
  declined: 'Request declined',
})[state.value])

const body = computed(() => {
  if (isRepoRoom.value) return REPO_COLLABORATOR_REQUIRED_MESSAGE
  const view = joinRequest.view.value
  const now = joinRequest.now.value
  if (view.kind === 'pending') {
    const askedAt = Date.parse(view.askedAt)
    const asked = Number.isFinite(askedAt) ? `You asked ${formatJoinRequestTime(askedAt, now)}. ` : ''
    return `${asked}A room admin can let you in or decline your request.`
  }
  if (view.kind === 'declined') {
    return `A room admin declined your request. You can ask again ${formatJoinRequestTime(view.retryAt, now)}.`
  }
  return view.previouslyDeclined
    ? 'A room admin declined your last request. You can ask again now.'
    : ROOM_MEMBERSHIP_REQUIRED_MESSAGE
})

// A repository role is decided on GitHub. The membership read answers once the
// person has a role and refuses until then, so the screen stays put on a refusal.
async function checkRepoAccess() {
  if (repoChecking.value) return
  repoChecking.value = true
  repoError.value = ''
  try {
    await fetchRoomMembership(props.roomId)
    emit('retry')
  } catch (cause) {
    const failure = asRoomApiError(cause)
    if (roomAccessRefusal(failure.payload) !== 'repo_collaborator_required') {
      repoError.value = failure.message || 'Could not check your access. Try again.'
    }
  } finally {
    repoChecking.value = false
  }
}

function checkAgain() {
  return isRepoRoom.value ? checkRepoAccess() : joinRequest.check()
}

// Coming back to the window is the moment an admin may have answered. There is
// no timer: a person who never leaves the tab uses "Check again".
const FOCUS_CHECK_GAP_MS = 5_000
let lastFocusCheck = 0
function handleWindowFocus() {
  if (state.value === 'ask' || Date.now() - lastFocusCheck < FOCUS_CHECK_GAP_MS) return
  lastFocusCheck = Date.now()
  void checkAgain()
}
onMounted(() => window.addEventListener('focus', handleWindowFocus))
onBeforeUnmount(() => window.removeEventListener('focus', handleWindowFocus))

// The button a person pressed can disappear with the state it belonged to;
// keep keyboard focus in the screen instead of dropping it to the page.
const actionsElement = ref<HTMLElement | null>(null)
// Every button is disabled until the action that changed the state ends, so
// wait for that before choosing where focus goes.
let restoreFocus = false
watch(state, () => { restoreFocus = true })
watch([state, busy], async () => {
  if (!restoreFocus || busy.value) return
  restoreFocus = false
  await nextTick()
  const active = typeof document === 'undefined' ? null : document.activeElement
  // Only take focus back when it fell to the page; never pull it from elsewhere.
  if (active && active !== document.body) return
  actionsElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
})
</script>

<style scoped>
.room-access {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-secondary, #a1a1aa);
  text-align: center;
}

.room-access-copy {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.room-access-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 0.7rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.room-access-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blue-text, #93c5fd);
}

.room-access-status[data-state="pending"] .room-access-dot { background: #facc15; }
.room-access-status[data-state="declined"] .room-access-dot { background: var(--muted, #71717a); }

.room-access-title {
  max-width: 460px;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text, #fafafa);
  font-size: 1.1rem;
  font-weight: 700;
}

.room-access-body,
.room-access-error,
.room-access-note {
  max-width: 420px;
  margin: 0;
  line-height: 1.6;
}

.room-access-error { color: var(--red-text, #f87171); font-size: 0.85rem; }
.room-access-note { font-size: 0.78rem; }

.room-access-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 4px;
}

.room-access-btn {
  min-height: 40px;
  padding: 8px 20px;
  border: 1px solid var(--border, #27272a);
  border-radius: 8px;
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s;
}

.room-access-btn:hover:not(:disabled) { background: var(--border, #27272a); }
.room-access-btn:disabled { cursor: wait; opacity: 0.6; }
.room-access-btn:focus-visible { outline: 2px solid var(--blue-text, #93c5fd); outline-offset: 2px; }
.room-access-btn.primary { border-color: var(--border-strong, #3f3f46); font-weight: 650; }
.room-access-btn.secondary { background: transparent; color: var(--text-secondary, #a1a1aa); }

@media (max-width: 768px) {
  .room-access { padding: 24px 16px; }
  .room-access-body { font-size: 0.85rem; }
}
</style>
