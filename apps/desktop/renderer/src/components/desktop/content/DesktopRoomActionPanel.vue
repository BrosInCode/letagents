<template>
  <Transition name="room-panel">
    <section v-if="open" class="desktop-room-action-panel" data-testid="desktop-room-action-panel">
      <div class="desktop-room-action-grid">
        <article class="desktop-room-action-card desktop-room-action-card-wide" data-testid="desktop-room-share-card">
          <div class="desktop-room-action-kicker">
            <span>Room link</span>
            <small>{{ room.displayName }}</small>
          </div>
          <div class="desktop-room-share-row">
            <span :title="roomUrl">{{ shortRoomUrl }}</span>
            <button type="button" @click="$emit('copy-room-link')">{{ copied ? "Copied" : "Copy" }}</button>
          </div>
        </article>

        <article class="desktop-room-action-card" data-testid="desktop-room-rules-card">
          <div class="desktop-room-action-icon is-blue">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M5 5h14v11H8l-3 3V5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <strong>Room rules</strong>
            <p>Open the pinned operating contract.</p>
          </div>
          <button type="button" @click="$emit('open-rules')">Open</button>
        </article>

        <form class="desktop-room-action-card desktop-room-action-card-wide" data-testid="desktop-room-rename-card" @submit.prevent="submitRename">
          <div class="desktop-room-action-kicker">
            <span>Room name</span>
            <small>{{ room.role }}</small>
          </div>
          <label class="desktop-room-rename-control">
            <span class="sr-only">Room name</span>
            <input v-model="renameDraft" type="text" :disabled="renameBusy" placeholder="Name this room">
            <button type="submit" :disabled="renameBusy || !renameDraft.trim()">
              {{ renameBusy ? "Saving" : "Rename" }}
            </button>
          </label>
          <p v-if="renameError" class="desktop-room-action-error">{{ renameError }}</p>
        </form>

        <article class="desktop-room-action-card" data-testid="desktop-room-sounds-card">
          <div class="desktop-room-action-icon is-amber">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="M13.7 21a2 2 0 0 1-3.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </div>
          <div>
            <strong>Sounds</strong>
            <p>{{ soundEnabled ? "Send and room sounds are on." : "Room sounds are muted." }}</p>
          </div>
          <button type="button" @click="$emit('toggle-sound')">{{ soundEnabled ? "On" : "Off" }}</button>
        </article>

        <article class="desktop-room-action-card" data-testid="desktop-room-notifications-card">
          <div class="desktop-room-action-icon is-emerald">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
              <path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div>
            <strong>Notifications</strong>
            <p>{{ notificationDescription }}</p>
          </div>
          <button type="button" @click="$emit('toggle-notifications')">
            {{ notificationsEnabled ? "On" : "Off" }}
          </button>
        </article>

        <article class="desktop-room-action-card desktop-room-action-card-wide" data-testid="desktop-room-github-card">
          <div class="desktop-room-action-kicker">
            <span>GitHub</span>
            <small>integration</small>
          </div>
          <div class="desktop-room-github-line">
            <span class="desktop-room-github-dot" :data-state="githubDotState" />
            <div>
              <strong>{{ githubTitle }}</strong>
              <p>{{ githubDescription }}</p>
            </div>
            <button
              v-if="githubStatus && !githubStatus.connected && githubStatus.installUrlAvailable"
              type="button"
              :disabled="githubBusy"
              @click="$emit('install-github')"
            >
              {{ githubBusy ? "Opening" : "Install" }}
            </button>
            <button v-else type="button" :disabled="githubBusy" @click="$emit('refresh-github')">Check</button>
          </div>
          <p v-if="githubError" class="desktop-room-action-error">{{ githubError }}</p>
        </article>

        <article class="desktop-room-action-card" data-testid="desktop-room-export-card">
          <div class="desktop-room-action-icon is-slate">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div>
            <strong>Export</strong>
            <p>Save the visible chat history as text.</p>
          </div>
          <button type="button" @click="$emit('export-chat')">Export</button>
        </article>
      </div>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopGitHubIntegrationStatus, DesktopRoomInfo } from "../../../../../electron/ipc-types";

const props = defineProps<{
  open: boolean;
  room: DesktopRoomInfo;
  roomUrl: string;
  copied: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  notificationPermission: NotificationPermission | "unsupported";
  renameBusy: boolean;
  renameError: string | null;
  githubStatus: DesktopGitHubIntegrationStatus | null;
  githubLoading: boolean;
  githubBusy: boolean;
  githubError: string | null;
}>();

const emit = defineEmits<{
  "copy-room-link": [];
  "open-rules": [];
  "toggle-sound": [];
  "toggle-notifications": [];
  "rename-room": [displayName: string];
  "refresh-github": [];
  "install-github": [];
  "export-chat": [];
}>();

const renameDraft = ref(props.room.displayName);

const shortRoomUrl = computed(() => {
  try {
    const url = new URL(props.roomUrl);
    return decodeURIComponent(url.pathname.replace(/^\/in\//, "")) || props.roomUrl;
  } catch {
    return props.roomUrl;
  }
});

const notificationDescription = computed(() => {
  if (props.notificationPermission === "unsupported") return "This desktop shell cannot show system notifications yet.";
  if (props.notificationsEnabled) return "Desktop alerts are on for new room messages.";
  if (props.notificationPermission === "denied") return "Notifications are blocked in system settings.";
  return "LetAgents can alert you when the room moves.";
});

const githubDotState = computed(() => {
  if (props.githubLoading) return "loading";
  if (props.githubStatus?.connected) return "connected";
  if (props.githubStatus?.installUrlAvailable) return "ready";
  return "off";
});

const githubTitle = computed(() => {
  if (props.githubLoading) return "Checking GitHub";
  if (props.githubStatus?.connected) return "Connected";
  if (props.githubStatus?.installUrlAvailable) return "Ready to install";
  if (props.githubStatus?.configured === false) return "Not configured";
  return "Not connected";
});

const githubDescription = computed(() => {
  if (props.githubStatus?.connected && props.githubStatus.repository?.fullName) {
    return props.githubStatus.repository.fullName;
  }
  if (props.githubStatus?.installUrlAvailable) {
    return "Install the GitHub app to bring PRs, checks, and repo events into the room.";
  }
  if (props.githubStatus?.configured === false) {
    return "GitHub app setup is not available for this server yet.";
  }
  return "Check whether this room is connected to GitHub.";
});

watch(
  () => props.room.displayName,
  (displayName) => {
    renameDraft.value = displayName;
  }
);

function submitRename(): void {
  const nextName = renameDraft.value.trim();
  if (!nextName) return;
  emit("rename-room", nextName);
}
</script>
