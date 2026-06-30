<template>
  <div class="first-run-room-step" data-testid="first-run-room-step">
    <section class="room-start-panel" data-testid="room-choice-panel">
      <div class="room-start-main">
        <span class="room-start-eyebrow">Final step</span>
        <h2>Start with a repo or invite.</h2>
        <p>Choose the project or shared room where LetAgents should open first.</p>

        <article
          v-if="selectedRoomIdentifier"
          class="selected-room-card"
          :data-access-state="selectedRoomAccessState"
          data-testid="selected-room-card"
        >
          <span class="room-choice-icon room-choice-icon-selected" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M4.75 6.75a2 2 0 0 1 2-2h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2V6.75Z" />
              <path d="m8.25 12.25 2.5 2.5 5-5.5" />
            </svg>
          </span>
          <div>
            <small>Selected room</small>
            <strong>{{ selectedRoomTitle }}</strong>
            <p v-if="selectedRoomDetail">{{ selectedRoomDetail }}</p>
          </div>
          <span class="selected-room-status">{{ selectedRoomStatus }}</span>
        </article>
      </div>

      <div class="room-choice-panel">
        <article class="room-choice-card room-choice-card-primary" data-testid="room-choice-repo">
          <span class="room-choice-icon room-choice-icon-repo" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M3.75 7.75a2 2 0 0 1 2-2h4l1.4 1.6h7.1a2 2 0 0 1 2 2v7.15a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V7.75Z" />
              <path d="M8.5 12.25h7" />
              <path d="M12 12.25v3.25" />
              <path d="M8.5 15.5h7" />
            </svg>
          </span>
          <div>
            <strong>Use a repository</strong>
            <p>Choose a repo and LetAgents opens its shared room.</p>
          </div>
          <button
            class="room-choice-action"
            type="button"
            :disabled="busy"
            data-testid="room-choice-pick-repo"
            @click.stop.prevent="$emit('pick-repo')"
          >
            Pick repo
          </button>
        </article>

        <article class="room-choice-card" data-testid="room-choice-code">
          <span class="room-choice-icon room-choice-icon-code" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 6.75a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2.15a2.1 2.1 0 0 0 0 4.2v2.15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V13.1a2.1 2.1 0 0 0 0-4.2V6.75Z" />
              <path d="M9 8.5h6" />
              <path d="M9 12h6" />
              <path d="M9 15.5h3.5" />
            </svg>
          </span>
          <div>
            <strong>Use an invite code</strong>
            <p>Join a room someone already created.</p>
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
      </div>
    </section>

    <aside class="setup-checklist room-setup-rail" data-testid="setup-checklist">
      <article class="setup-check-item">
        <span class="setup-check-icon setup-check-icon-mcp" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 4.75v4.5" />
            <path d="M16 4.75v4.5" />
            <path d="M6.75 9.25h10.5v2.5a5.25 5.25 0 0 1-10.5 0v-2.5Z" />
            <path d="M12 17v2.25" />
          </svg>
        </span>
        <div>
          <strong>MCP installed</strong>
          <p>Your chosen agent app can load LetAgents.</p>
        </div>
      </article>

      <article class="setup-check-item">
        <span class="setup-check-icon setup-check-icon-github" aria-hidden="true">
          <svg v-if="githubConnected" viewBox="0 0 24 24">
            <path fill="currentColor" stroke="none" d="M12 3.75c-3.1 0-5.6 2.54-5.6 5.68 0 2.52 1.6 4.65 3.82 5.4.28.05.38-.12.38-.28v-1.06c-1.55.34-1.88-.68-1.88-.68-.25-.66-.62-.84-.62-.84-.5-.35.04-.35.04-.35.56.04.85.6.85.6.5.87 1.31.62 1.63.48.05-.37.2-.62.35-.77-1.24-.14-2.54-.63-2.54-2.82 0-.62.22-1.13.57-1.53-.06-.14-.25-.72.06-1.51 0 0 .47-.15 1.54.59.45-.13.92-.19 1.4-.19.47 0 .95.06 1.4.19 1.06-.74 1.53-.59 1.53-.59.31.79.12 1.37.06 1.51.36.4.58.91.58 1.53 0 2.2-1.31 2.68-2.55 2.82.2.18.38.53.38 1.07v1.56c0 .16.1.33.38.28 2.22-.75 3.82-2.88 3.82-5.4 0-3.14-2.5-5.68-5.6-5.68Z" />
            <path fill="none" d="M18.5 15.5 20 17l2.25-2.5" />
          </svg>
          <svg v-else viewBox="0 0 24 24">
            <path d="M8 10.25V8.5a4 4 0 0 1 7.55-1.83" />
            <path d="M6.75 10.25h10.5v8.25H6.75z" />
            <path d="M12 13.5v1.75" />
          </svg>
        </span>
        <div>
          <strong>{{ githubCheck.title }}</strong>
          <p>{{ githubCheck.copy }}</p>
        </div>
      </article>

      <article class="setup-check-item">
        <span class="setup-check-icon setup-check-icon-room" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5.75 4.75h10.5v14.5H5.75z" />
            <path d="M16.25 8.75h2v8.5h-2" />
            <path d="M9.25 12h4.5" />
            <path d="m12.25 10.5 1.5 1.5-1.5 1.5" />
          </svg>
        </span>
        <div>
          <strong>Choose the room</strong>
          <p>Open a repo room now, or join another room with an invite code later.</p>
        </div>
      </article>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DesktopRoomAccess } from "../../../../../electron/ipc-types";

const props = defineProps<{
  selectedRoomName: string | null;
  selectedRoomIdentifier: string | null;
  selectedRoomAccessStatus: DesktopRoomAccess["status"] | null;
  roomNeedsGithubAccess: boolean;
  githubConnected: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  "pick-repo": [];
  "join-room-code": [roomCode: string];
}>();

const roomCode = ref("");

function submitRoomCode(): void {
  const value = roomCode.value.trim();
  if (!value) return;
  emit("join-room-code", value);
}

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
  if (props.githubConnected && props.selectedRoomAccessStatus === "auth_required") return "ready";
  return props.selectedRoomAccessStatus || "ready";
});

const selectedRoomStatus = computed(() => {
  if (props.roomNeedsGithubAccess) return "GitHub required";
  if (props.githubConnected && props.selectedRoomAccessStatus === "auth_required") return "GitHub connected";
  return "Ready";
});

const githubCheck = computed(() =>
  props.githubConnected
    ? {
        title: "GitHub connected",
        copy: "LetAgents can confirm access and find repositories you can work in.",
      }
    : props.roomNeedsGithubAccess
      ? {
          title: "GitHub needed",
          copy: "This private repo room needs a GitHub check before it opens.",
        }
      : {
          title: "GitHub optional",
          copy: "Public and invite rooms work now; connect GitHub later for private repos.",
        }
);
</script>
