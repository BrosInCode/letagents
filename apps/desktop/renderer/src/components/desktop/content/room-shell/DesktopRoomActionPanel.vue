<template>
  <section class="desktop-room-action-panel" data-testid="desktop-room-action-panel">
    <div class="desktop-room-action-panel-topbar">
      <p class="desktop-room-action-kicker">Room settings</p>
      <button
        class="desktop-room-action-panel-close"
        type="button"
        aria-label="Close room settings"
        @click="$emit('close')"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
      <div class="desktop-room-inspector">
        <form class="desktop-room-identity-card" data-testid="desktop-room-rename-card" @submit.prevent="submitRename">
          <div class="desktop-room-inspector-header">
            <div>
              <p class="desktop-room-action-kicker">Room identity</p>
              <h4>{{ room.displayName }}</h4>
            </div>
            <span class="desktop-room-status-chip">{{ room.role }}</span>
          </div>

          <label class="desktop-room-title-control">
            <span class="sr-only">Room name</span>
            <input v-model="renameDraft" type="text" :disabled="renameBusy" placeholder="Name this room">
            <button type="submit" :disabled="renameBusy || !renameDraft.trim()">
              {{ renameBusy ? "Saving" : "Save" }}
            </button>
          </label>

          <div class="desktop-room-inline-note" :data-state="renameError ? 'error' : 'neutral'">
            <span class="desktop-room-mini-dot" />
            <p v-if="renameError">{{ renameError }}</p>
            <p v-else>Rename and share this room without leaving chat.</p>
          </div>

          <div class="desktop-room-link-line" data-testid="desktop-room-share-card">
            <div>
              <small>Room link</small>
              <span :title="roomUrl">{{ shortRoomUrl }}</span>
            </div>
            <button type="button" @click="$emit('copy-room-link')">{{ copied ? "Copied" : "Copy link" }}</button>
          </div>
        </form>

        <div class="desktop-room-property-list" aria-label="Room settings inspector">
          <button class="desktop-room-property-row" type="button" data-testid="desktop-room-rules-card" @click="$emit('open-rules')">
            <span class="desktop-room-action-icon is-blue" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 5h14v11H8l-3 3V5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="M9 9h6M9 12h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="desktop-room-property-copy">
              <strong>Rules</strong>
              <small>Review the room contract and operating constraints.</small>
            </span>
            <span class="desktop-room-row-action">Open</span>
          </button>

          <button class="desktop-room-property-row" type="button" data-testid="desktop-room-sounds-card" @click="$emit('toggle-sound')">
            <span class="desktop-room-action-icon is-amber" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="M13.7 21a2 2 0 0 1-3.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="desktop-room-property-copy">
              <strong>Sounds</strong>
              <small>{{ soundEnabled ? "Message and send sounds are active." : "Room sounds are muted." }}</small>
            </span>
            <span class="desktop-room-toggle" :data-active="soundEnabled">
              <span />
            </span>
          </button>

          <button class="desktop-room-property-row" type="button" data-testid="desktop-room-notifications-card" @click="$emit('toggle-notifications')">
            <span class="desktop-room-action-icon is-emerald" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
                <path d="m9 12 2 2 4-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="desktop-room-property-copy">
              <strong>Alerts</strong>
              <small>{{ notificationDescription }}</small>
            </span>
            <span class="desktop-room-status-chip" :data-state="notificationShortLabel.toLowerCase()">{{ notificationShortLabel }}</span>
          </button>

          <button class="desktop-room-property-row" type="button" data-testid="desktop-room-liquid-glass-card" @click="$emit('toggle-liquid-glass')">
            <span class="desktop-room-action-icon is-glass" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M5 7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 16.5v-9Z" stroke="currentColor" stroke-width="1.8"/>
                <path d="M8 9h8M8 12h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </span>
            <span class="desktop-room-property-copy">
              <strong>Liquid glass</strong>
              <small>{{ liquidGlassEnabled ? "Room widgets use glass surfaces." : "Room widgets use simpler surfaces." }}</small>
            </span>
            <span class="desktop-room-toggle" :data-active="liquidGlassEnabled">
              <span />
            </span>
          </button>

          <button class="desktop-room-property-row" type="button" data-testid="desktop-room-export-card" @click="$emit('export-chat')">
            <span class="desktop-room-action-icon is-slate" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                <path d="M7 10l5 5 5-5M12 15V3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="desktop-room-property-copy">
              <strong>Export</strong>
              <small>Download the visible chat history as plain text.</small>
            </span>
            <span class="desktop-room-row-action">Export</span>
          </button>

          <div class="desktop-room-github-pill" :data-state="githubDotState" data-testid="desktop-room-github-card">
            <div class="desktop-room-github-summary">
              <span class="desktop-room-github-dot" :data-state="githubDotState" />
              <div>
                <strong>{{ githubTitle }}</strong>
                <small>{{ githubDescription }}</small>
              </div>
            </div>
            <div class="desktop-room-github-actions">
              <span class="desktop-room-status-chip" :data-state="githubDotState">{{ githubStatusLabel }}</span>
              <button
                v-if="githubStatus && !githubStatus.connected && githubStatus.installUrlAvailable"
                type="button"
                :disabled="githubBusy"
                @click="$emit('install-github')"
              >
                {{ githubBusy ? "Opening" : "Install" }}
              </button>
              <button v-else type="button" :disabled="githubBusy" @click="$emit('refresh-github')">
                {{ githubLoading ? "Checking" : "Check" }}
              </button>
            </div>
            <p v-if="githubFriendlyError" class="desktop-room-action-error">{{ githubFriendlyError }}</p>
          </div>
        </div>
      </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopGitHubIntegrationStatus, DesktopRoomInfo } from "../../../../../../electron/ipc-types";

const props = defineProps<{
  room: DesktopRoomInfo;
  roomUrl: string;
  copied: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  notificationPermission: NotificationPermission | "unsupported";
  liquidGlassEnabled: boolean;
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
  "toggle-liquid-glass": [];
  "rename-room": [displayName: string];
  "refresh-github": [];
  "install-github": [];
  "export-chat": [];
  close: [];
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

const notificationDescription = computed(() => {
  if (props.notificationPermission === "unsupported") return "Desktop alerts are unavailable in this environment.";
  if (props.notificationsEnabled) return "Desktop alerts can notify you about new room messages.";
  if (props.notificationPermission === "denied") return "Notifications are blocked by the system permission.";
  return "Ask before showing desktop alerts for this room.";
});

const githubDotState = computed(() => {
  if (props.githubLoading) return "loading";
  if (githubBridgeUpgradeNeeded.value) return "off";
  if (props.githubError) return "error";
  if (props.githubStatus?.connected) return "connected";
  if (props.githubStatus?.installUrlAvailable) return "ready";
  return "off";
});

const githubTitle = computed(() => {
  if (props.githubLoading) return "Checking GitHub";
  if (githubBridgeUpgradeNeeded.value) return "Restart the app";
  if (props.githubError) return "GitHub integration unavailable";
  if (props.githubStatus?.connected) return "Connected";
  if (props.githubStatus?.installUrlAvailable) return "Ready to install";
  if (props.githubStatus?.configured === false) return "Not configured";
  return "Not connected";
});

const githubDescription = computed(() => {
  if (githubBridgeUpgradeNeeded.value) {
    return "Restart the app.";
  }
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

const githubStatusLabel = computed(() => {
  if (props.githubLoading) return "Checking";
  if (githubBridgeUpgradeNeeded.value) return "Restart";
  if (props.githubError) return "Error";
  if (props.githubStatus?.connected) return "Connected";
  if (props.githubStatus?.installUrlAvailable) return "Ready";
  if (props.githubStatus?.configured === false) return "Setup needed";
  return "Offline";
});

const githubFriendlyError = computed(() => {
  if (!props.githubError) return null;
  if (githubBridgeUpgradeNeeded.value) return null;
  return props.githubError;
});

const githubBridgeUpgradeNeeded = computed(() => {
  return Boolean(
    props.githubError?.includes("No handler registered")
    || props.githubError?.includes("desktop:room:get-github-integration-status")
    || props.githubError === "Restart LetAgents Desktop to load the latest room tools."
  );
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
