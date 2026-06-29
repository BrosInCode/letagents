<template>
  <div class="first-run-room-step" data-testid="first-run-room-step">
    <section class="room-choice-panel" data-testid="room-choice-panel">
      <article class="room-choice-card room-choice-card-primary" data-testid="room-choice-repo">
        <span class="room-choice-icon room-choice-icon-repo" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4.75 6.25A2.5 2.5 0 0 1 7.25 3.75h9.5a2.5 2.5 0 0 1 2.5 2.5v11.5a2.5 2.5 0 0 1-2.5 2.5h-9.5a2.5 2.5 0 0 1-2.5-2.5V6.25Z" />
            <path d="M8 8.25h8" />
            <path d="M8 12h8" />
            <path d="M8 15.75h4.5" />
          </svg>
        </span>
        <div>
          <strong>Open a Git Room</strong>
          <p>Choose a project folder and LetAgents will open the matching Git Room or local folder room.</p>
          <button
            class="room-choice-action"
            type="button"
            :disabled="busy"
            data-testid="room-choice-pick-repo"
            @click.stop.prevent="$emit('pick-repo')"
          >
            Open
          </button>
        </div>
      </article>

      <article class="room-choice-card" data-testid="room-choice-code">
        <span class="room-choice-icon room-choice-icon-code" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M7.75 8.75h8.5" />
            <path d="M7.75 12h8.5" />
            <path d="M7.75 15.25h4" />
            <path d="M5.25 4.75h13.5v14.5H5.25z" />
            <path d="M8 4.75V3.25" />
            <path d="M16 4.75V3.25" />
          </svg>
        </span>
        <div>
          <strong>Join with a room code</strong>
          <p>Use an invite code when someone has already created a room and wants you or your agents there.</p>
          <form class="room-code-form" data-testid="room-code-form" @submit.prevent="submitRoomCode">
            <input
              v-model="roomCode"
              type="text"
              placeholder="Room code or room name"
              :disabled="busy"
              data-testid="room-code-input"
            >
            <button type="submit" :disabled="busy || !roomCode.trim()" data-testid="room-code-submit">
              Join
            </button>
          </form>
        </div>
      </article>

      <article v-if="roomIdentifier" class="suggested-room-card" data-testid="suggested-room-card">
        <p class="hero-kicker">Suggested from this Mac</p>
        <div>
          <strong>{{ roomName }}</strong>
          <p>{{ roomIdentifier }}</p>
        </div>
        <span>{{ roomReadyLabel }}</span>
      </article>
      <article v-else class="suggested-room-card suggested-room-card-empty" data-testid="suggested-room-empty">
        <p class="hero-kicker">No room selected yet</p>
        <div>
          <strong>Pick a project folder or enter a code</strong>
          <p>LetAgents will open the matching room once it knows where your agents should work.</p>
        </div>
      </article>
    </section>

    <aside class="setup-checklist" data-testid="setup-checklist">
      <article v-for="item in checklist" :key="item.title" class="setup-check-item">
        <span aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <div>
          <strong>{{ item.title }}</strong>
          <p>{{ item.copy }}</p>
        </div>
      </article>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
  roomName: string;
  roomIdentifier: string | null;
  githubConnected: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  "pick-repo": [];
  "join-room-code": [roomCode: string];
}>();

const roomCode = ref("");

const roomReadyLabel = computed(() => {
  return props.roomIdentifier ? "Ready to open" : "Choose a room";
});

function submitRoomCode(): void {
  const value = roomCode.value.trim();
  if (!value) return;
  emit("join-room-code", value);
}

const checklist = computed(() => [
  {
    title: "Agent app ready",
    copy: "Your chosen agent app can load LetAgents.",
  },
  props.githubConnected
    ? {
        title: "GitHub connected",
        copy: "LetAgents can confirm access and find repositories you can work in.",
      }
    : {
        title: "GitHub optional",
        copy: "Public and invite rooms work now; connect GitHub later for private repos.",
      },
  {
    title: "Choose the room",
    copy: "Open a Git Room now, or join another room with an invite code later.",
  },
]);
</script>
