<template>
  <Transition name="room-panel">
    <section v-if="open" class="desktop-room-action-panel" data-testid="desktop-room-action-panel">
      <div class="desktop-room-deck">
        <form class="desktop-room-identity-card" data-testid="desktop-room-rename-card" @submit.prevent="submitRename">
          <div class="desktop-room-action-kicker">
            <span>Room</span>
            <small>{{ room.role }}</small>
          </div>
          <label class="desktop-room-title-control">
            <span class="sr-only">Room name</span>
            <input v-model="renameDraft" type="text" :disabled="renameBusy" placeholder="Name this room">
            <button type="submit" :disabled="renameBusy || !renameDraft.trim()">
              {{ renameBusy ? "Saving" : "Save" }}
            </button>
          </label>
          <p v-if="renameError" class="desktop-room-action-error">{{ renameError }}</p>
          <p v-else class="desktop-room-action-note">Rename the room, share it, or open the room contract without leaving chat.</p>
          <div class="desktop-room-link-line" data-testid="desktop-room-share-card">
            <span :title="roomUrl">{{ shortRoomUrl }}</span>
            <button type="button" @click="$emit('copy-room-link')">{{ copied ? "Copied" : "Copy link" }}</button>
          </div>
        </form>

        <div class="desktop-room-command-grid">
          <button class="desktop-room-command" type="button" data-testid="desktop-room-rules-card" @click="$emit('open-rules')">
            <span class="desktop-room-action-icon is-blue">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 5h14v11H8l-3 3V5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            <span>
              <strong>Rules</strong>
              <small>Room contract</small>
            </span>
          </button>

          <button class="desktop-room-command" type="button" data-testid="desktop-room-sounds-card" @click="$emit('toggle-sound')">
            <span class="desktop-room-action-icon is-amber">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="M13.7 21a2 2 0 0 1-3.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            <span>
              <strong>Sounds</strong>
              <small>{{ soundEnabled ? "On" : "Muted" }}</small>
            </span>
          </button>

          <button class="desktop-room-command" type="button" data-testid="desktop-room-notifications-card" @click="$emit('toggle-notifications')">
            <span class="desktop-room-action-icon is-emerald">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span>
              <strong>Alerts</strong>
              <small>{{ notificationShortLabel }}</small>
            </span>
          </button>

          <button class="desktop-room-command" type="button" data-testid="desktop-room-export-card" @click="$emit('export-chat')">
            <span class="desktop-room-action-icon is-slate">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span>
              <strong>Export</strong>
              <small>Visible chat</small>
            </span>
          </button>

          <div class="desktop-room-github-pill" data-testid="desktop-room-github-card">
            <span class="desktop-room-github-dot" :data-state="githubDotState" />
            <span>
              <strong>{{ githubTitle }}</strong>
              <small>{{ githubDescription }}</small>
            </span>
            <button
              v-if="githubStatus && !githubStatus.connected && githubStatus.installUrlAvailable"
              type="button"
              :disabled="githubBusy"
              @click="$emit('install-github')"
            >
              {{ githubBusy ? "Opening" : "Install" }}
            </button>
            <button v-else type="button" :disabled="githubBusy" @click="$emit('refresh-github')">Check</button>
            <p v-if="githubError" class="desktop-room-action-error">{{ githubError }}</p>
          </div>
        </div>
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

const notificationShortLabel = computed(() => {
  if (props.notificationPermission === "unsupported") return "Unavailable";
  if (props.notificationsEnabled) return "On";
  if (props.notificationPermission === "denied") return "Blocked";
  return "Off";
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
