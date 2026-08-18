<template>
  <div class="first-run-room-step" data-testid="first-run-room-step">
    <div class="first-run-room-paths" aria-label="Choose how to open a room">
      <button
        class="first-run-room-path"
        type="button"
        aria-describedby="room-choice-pick-repo-help"
        :disabled="busy"
        data-testid="room-choice-pick-repo"
        @click="$emit('pick-repo')"
      >
        <span class="first-run-room-path-icon" aria-hidden="true">
          <FolderGit2 />
        </span>
        <span class="first-run-room-path-label">Repository</span>
        <span id="room-choice-pick-repo-help" class="first-run-room-path-detail">
          Open a room tied to your code.
        </span>
      </button>

      <button
        class="first-run-room-path"
        type="button"
        aria-describedby="room-choice-create-help"
        :disabled="busy"
        data-testid="room-choice-create"
        @click="$emit('create-room')"
      >
        <span class="first-run-room-path-icon" aria-hidden="true">
          <Plus />
        </span>
        <span class="first-run-room-path-label">New room</span>
        <span id="room-choice-create-help" class="first-run-room-path-detail">
          Create a room and share an invite.
        </span>
      </button>

      <button
        class="first-run-room-path"
        type="button"
        aria-describedby="room-choice-join-help"
        :aria-expanded="showJoinForm"
        :disabled="busy"
        data-testid="room-choice-join"
        @click="showJoinForm = !showJoinForm"
      >
        <span class="first-run-room-path-icon" aria-hidden="true">
          <KeyRound />
        </span>
        <span class="first-run-room-path-label">Join room</span>
        <span id="room-choice-join-help" class="first-run-room-path-detail">
          Enter an invite from someone else.
        </span>
      </button>
    </div>

    <Transition name="first-run-pop">
      <form
        v-if="showJoinForm"
        class="first-run-room-join"
        data-testid="room-code-form"
        @submit.prevent="submitRoomCode"
      >
        <input
          v-model="roomCode"
          type="text"
          placeholder="Invite code"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          :disabled="busy"
          data-testid="room-code-input"
        >
        <button type="submit" :disabled="busy || !roomCode.trim()" data-testid="room-code-submit">
          Join
        </button>
      </form>
    </Transition>

    <Transition name="first-run-pop">
      <p v-if="feedback" class="first-run-room-feedback" role="status" aria-live="polite">
        {{ feedback }}
      </p>
    </Transition>

    <Transition name="first-run-pop" mode="out-in">
      <article
        v-if="selectedRoomIdentifier"
        :key="selectedRoomIdentifier"
        class="first-run-room-ready"
        :data-access-state="selectedRoomAccessState"
        data-testid="selected-room-card"
        role="status"
        aria-live="polite"
      >
        <span class="first-run-room-ready-check" aria-hidden="true">
          <Check />
        </span>
        <div class="first-run-room-ready-copy">
          <small>{{ createdInviteCode ? "Room created" : "Ready to open" }}</small>
          <strong>{{ selectedRoomTitle }}</strong>
          <span v-if="selectedRoomDetail && !createdInviteCode">{{ selectedRoomDetail }}</span>
        </div>

        <div v-if="createdInviteCode" class="first-run-room-invite" data-testid="first-run-room-invite">
          <code>{{ createdInviteCode }}</code>
          <button
            type="button"
            :aria-label="inviteCopied ? 'Invite code copied' : 'Copy invite code'"
            data-testid="first-run-room-copy-invite"
            @click="copyInviteCode"
          >
            <Transition name="first-run-icon" mode="out-in">
              <Check v-if="inviteCopied" key="copied" aria-hidden="true" />
              <CopyIcon v-else key="copy" aria-hidden="true" />
            </Transition>
            <span>{{ inviteCopied ? "Copied" : "Copy" }}</span>
          </button>
        </div>

        <span v-else-if="roomNeedsGithubAccess" class="first-run-room-ready-status">
          GitHub required
        </span>
      </article>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Check, Copy as CopyIcon, FolderGit2, KeyRound, Plus } from "@lucide/vue";
import type { DesktopRoomAccess } from "../../../../../electron/ipc-types";
import { useCopyIndicator } from "../../../composables/useCopyIndicator";

const props = defineProps<{
  selectedRoomName: string | null;
  selectedRoomIdentifier: string | null;
  selectedRoomAccessStatus: DesktopRoomAccess["status"] | null;
  roomNeedsGithubAccess: boolean;
  createdInviteCode: string | null;
  busy: boolean;
  feedback?: string | null;
}>();

const emit = defineEmits<{
  "pick-repo": [];
  "create-room": [];
  "join-room-code": [roomCode: string];
}>();

const roomCode = ref("");
const showJoinForm = ref(false);
const { copied: inviteCopied, copy: copyInvite } = useCopyIndicator();

function submitRoomCode(): void {
  const value = roomCode.value.trim();
  if (!value) return;
  emit("join-room-code", value);
}

async function copyInviteCode(): Promise<void> {
  if (!props.createdInviteCode) return;
  await copyInvite(props.createdInviteCode);
}

watch(
  () => props.selectedRoomIdentifier,
  (roomIdentifier) => {
    if (!roomIdentifier) return;
    showJoinForm.value = false;
    roomCode.value = "";
  },
);

const selectedRoomTitle = computed(() => {
  const name = props.selectedRoomName?.trim() || "";
  const identifier = props.selectedRoomIdentifier?.trim() || "";
  if (name && name !== identifier) return name;
  const githubMatch = identifier.match(/^github\.com\/[^/]+\/([^/]+)(?:\/.*)?$/i);
  return githubMatch?.[1] || identifier || "Room";
});

const selectedRoomDetail = computed(() => {
  const identifier = props.selectedRoomIdentifier?.trim() || "";
  return identifier && identifier !== selectedRoomTitle.value ? identifier : null;
});

const selectedRoomAccessState = computed(() => {
  if (props.roomNeedsGithubAccess) return "auth_required";
  return props.selectedRoomAccessStatus || "ready";
});
</script>
