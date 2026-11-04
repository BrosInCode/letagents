<template>
  <div class="auth-join" :data-join-state="joinState.kind" data-testid="room-join-access">
    <template v-if="repoRoom">
      <h1>Ask a repository admin to add you on GitHub</h1>
      <p>{{ access.message || REPO_COLLABORATOR_REQUIRED_MESSAGE }}</p>
    </template>

    <template v-else-if="joinState.kind === 'main_room_only'">
      <h1>Ask for the main room's link</h1>
      <p>This is a focus room in a members-only room. It uses the members of its main room. Ask a member for the main room's link, then ask to join there.</p>
    </template>

    <template v-else-if="joinState.kind === 'pending'">
      <h1>Waiting for an admin</h1>
      <p>You asked to join {{ askedLabel }}. A room admin can let you in. The room opens when you check again after that.</p>
    </template>

    <template v-else-if="joinState.kind === 'declined'">
      <h1>An admin declined your request</h1>
      <p>You can ask again {{ retryLabel }}.</p>
    </template>

    <template v-else>
      <h1>Ask to join this room</h1>
      <p v-if="joinState.declined">An admin declined your last request. You can ask again.</p>
      <p v-else>{{ access.message || ROOM_MEMBERSHIP_REQUIRED_MESSAGE }}</p>
    </template>

    <span v-if="account" class="auth-account-chip" data-testid="auth-account">
      <span class="auth-avatar" aria-hidden="true">{{ loginInitials(account.login) }}</span>
      <span>
        <strong>{{ account.displayName || account.login }}</strong>
        <small>· signed in</small>
      </span>
    </span>

    <div class="auth-actions">
      <button
        v-if="!repoRoom && joinState.kind !== 'pending' && joinState.kind !== 'main_room_only'"
        class="primary-button"
        type="button"
        :disabled="disabled || joinState.kind === 'declined'"
        data-testid="room-join-ask-button"
        @click="ask"
      >
        {{ action === "ask" ? "Asking…" : joinState.kind === "ask" && !joinState.declined ? "Ask to join" : "Ask again" }}
      </button>
      <button
        :class="repoRoom || joinState.kind === 'pending' || joinState.kind === 'main_room_only' ? 'primary-button' : 'ghost-button'"
        type="button"
        :disabled="disabled"
        data-testid="room-join-check-button"
        @click="$emit('refresh-room')"
      >
        Check again
      </button>
      <button
        v-if="joinState.kind === 'pending'"
        class="ghost-button"
        type="button"
        :disabled="disabled"
        data-testid="room-join-cancel-button"
        @click="cancel"
      >
        {{ action === "cancel" ? "Cancelling…" : "Cancel request" }}
      </button>
      <button
        v-else
        class="auth-quiet-button"
        type="button"
        :disabled="disabled"
        data-testid="auth-sign-out-button"
        @click="$emit('sign-out')"
      >
        Use another account
      </button>
    </div>

    <p v-if="error" class="auth-feedback" role="alert" data-testid="room-join-error">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  REPO_COLLABORATOR_REQUIRED_MESSAGE,
  ROOM_MEMBERSHIP_REQUIRED_MESSAGE,
} from "../../../../../../../shared/room-membership.mjs";
import type {
  DesktopAuthAccount,
  DesktopRoomAccess,
  RoomJoinRequestSummary,
} from "../../../../../electron/ipc-types";
import { desktopIpc } from "../../../ipc/index";
import { loginInitials } from "../../../domain/initials";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import { isFocusRoomIdentifier, joinAskedLabel, joinRetryLabel, resolveJoinCardState } from "./auth-onboarding";

const props = defineProps<{
  access: DesktopRoomAccess;
  account: DesktopAuthAccount | null;
  busy: boolean;
  now: number;
}>();

const emit = defineEmits<{
  "refresh-room": [];
  "sign-out": [];
}>();

const repoRoom = computed(() => props.access.status === "repo_collaborator_required");
const action = ref<"ask" | "cancel" | null>(null);
const error = ref<string | null>(null);
// What the last action returned, until the next room check brings the server's own copy.
const latest = ref<{ room: string | null; joinRequest: RoomJoinRequestSummary | null } | null>(null);
// The server answered that only the main room takes requests (a focus room).
const mainRoomOnlyAnswer = ref<string | null>(null);

watch(
  [() => props.access.roomIdentifier, () => props.access.joinRequest],
  () => {
    latest.value = null;
    error.value = null;
  },
);
watch(() => props.access.roomIdentifier, () => { mainRoomOnlyAnswer.value = null; });

const joinRequest = computed(() =>
  latest.value?.room === props.access.roomIdentifier ? latest.value.joinRequest : props.access.joinRequest ?? null);
// A non-member gets a focus room's refusal with no room name: its main room takes the request.
const mainRoomOnly = computed(() =>
  mainRoomOnlyAnswer.value === props.access.roomIdentifier
  || (isFocusRoomIdentifier(props.access.roomIdentifier) && !props.access.displayName && !props.access.joinRequest));
const joinState = computed(() => resolveJoinCardState(joinRequest.value, props.now, mainRoomOnly.value));
const disabled = computed(() => props.busy || action.value !== null);
const askedLabel = computed(() =>
  joinState.value.kind === "pending" ? joinAskedLabel(joinState.value.askedAt, props.now) : "");
const retryLabel = computed(() =>
  joinState.value.kind === "declined" ? joinRetryLabel(joinState.value.retryAt, props.now) : "");

async function ask(): Promise<void> {
  const room = props.access.roomIdentifier;
  if (!room || disabled.value) return;
  action.value = "ask";
  error.value = null;
  try {
    const result = await desktopIpc.roomMembers.requestJoin(room);
    if (result.ok) {
      latest.value = { room, joinRequest: result.joinRequest };
    } else if (result.code === "ROOM_ALREADY_MEMBER") {
      // Let in since the room was last checked: open it.
      emit("refresh-room");
    } else if (result.code === "ROOM_JOIN_REQUEST_COOLDOWN" && result.joinRequest) {
      latest.value = { room, joinRequest: result.joinRequest };
    } else if (result.code === "ROOM_JOIN_REQUEST_MAIN_ROOM_ONLY") {
      mainRoomOnlyAnswer.value = room;
    } else {
      error.value = result.status === 429
        ? "Too many requests. Wait a minute, then ask again."
        : result.message || "LetAgents could not send the request.";
    }
  } catch (cause) {
    error.value = safeUserVisibleErrorDetail(cause, "LetAgents could not send the request.");
  } finally {
    action.value = null;
  }
}

async function cancel(): Promise<void> {
  const room = props.access.roomIdentifier;
  const state = joinState.value;
  if (!room || state.kind !== "pending" || disabled.value) return;
  action.value = "cancel";
  error.value = null;
  try {
    const result = await desktopIpc.roomMembers.decideJoinRequest(room, state.requestId, "cancel");
    if (result.ok || result.code === "ROOM_JOIN_REQUEST_NOT_PENDING") {
      // A request an admin decided first comes back with that decision.
      latest.value = { room, joinRequest: result.joinRequest };
      if (!result.ok && result.joinRequest?.state === "approved") emit("refresh-room");
    } else {
      error.value = result.message || "LetAgents could not cancel the request.";
    }
  } catch (cause) {
    error.value = safeUserVisibleErrorDetail(cause, "LetAgents could not cancel the request.");
  } finally {
    action.value = null;
  }
}
</script>
