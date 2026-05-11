<template>
  <section class="settings-page surface-page" data-testid="settings-view">
    <article class="surface-intro">
      <p class="sidebar-label">Settings</p>
      <h3>Account, rooms, and desktop setup.</h3>
      <p>Manage the account connection, MCP install state, and the rooms attached to this account.</p>
    </article>

    <div class="settings-grid">
      <article class="surface-row settings-card" data-testid="settings-account">
        <div class="settings-account-summary">
          <span class="auth-avatar" aria-hidden="true">{{ accountInitials }}</span>
          <div>
            <p class="surface-title">{{ accountTitle }}</p>
            <p class="surface-subtitle">{{ accountSubtitle }}</p>
          </div>
        </div>
        <div class="surface-meta settings-actions">
          <span class="state-pill" :data-state="authStatus?.authenticated ? 'connected' : 'offline'">
            {{ authStatus?.authenticated ? "connected" : "signed out" }}
          </span>
          <button
            v-if="authStatus?.authenticated"
            class="ghost-button"
            type="button"
            :disabled="busy"
            data-testid="settings-sign-out"
            @click="$emit('sign-out')"
          >
            Sign out
          </button>
          <button
            v-else
            class="primary-button"
            type="button"
            :disabled="busy"
            data-testid="settings-connect-github"
            @click="$emit('start-auth')"
          >
            Connect GitHub
          </button>
        </div>
      </article>

      <article class="surface-row settings-card" data-testid="settings-desktop">
        <div>
          <p class="surface-title">Desktop runtime</p>
          <p class="surface-subtitle">{{ apiEndpointLabel }}</p>
          <code v-if="appInfo?.workspaceRoot">{{ appInfo.workspaceRoot }}</code>
        </div>
        <div class="surface-meta">
          <span class="state-pill" data-state="connected">local</span>
          <code>{{ versionLabel }}</code>
        </div>
      </article>

      <article class="surface-row settings-card" data-testid="settings-mcp">
        <div>
          <p class="surface-title">MCP setup</p>
          <p class="surface-subtitle">{{ mcpSetupLabel }}</p>
        </div>
        <div class="surface-meta settings-actions">
          <span class="state-pill" :data-state="mcpInstallState?.completed ? 'installed' : 'starting'">
            {{ mcpInstallState?.completed ? "installed" : "needs setup" }}
          </span>
          <button
            class="ghost-button"
            type="button"
            data-testid="settings-open-setup"
            @click="$emit('open-setup')"
          >
            Open setup
          </button>
        </div>
      </article>
    </div>

    <section class="settings-section" aria-labelledby="settings-rooms-title">
      <header class="settings-section-header">
        <div>
          <p class="sidebar-label">Rooms</p>
          <h4 id="settings-rooms-title">Account rooms</h4>
        </div>
        <div class="settings-section-actions">
          <span class="state-pill" data-state="connected">{{ roomSummaryLabel }}</span>
          <button
            class="ghost-button"
            type="button"
            :disabled="busy"
            data-testid="settings-refresh-rooms"
            @click="$emit('refresh')"
          >
            Refresh
          </button>
        </div>
      </header>

      <p
        v-if="feedback"
        class="settings-feedback"
        :data-state="feedback.state"
        data-testid="settings-feedback"
      >
        {{ feedback.message }}
      </p>

      <div class="surface-list" data-testid="settings-room-list">
        <article
          v-for="room in accountRooms"
          :key="room.roomIdentifier"
          class="surface-row settings-room-row"
          :data-testid="`settings-room-${slugify(room.roomIdentifier)}`"
        >
          <div class="settings-room-copy">
            <p class="surface-title">{{ room.displayName }}</p>
            <p class="surface-subtitle">{{ room.roomIdentifier }}</p>
            <div class="settings-room-meta">
              <span>{{ roleSourceLabel(room) }}</span>
              <span v-if="room.focusRooms.length">{{ room.focusRooms.length }} focus {{ room.focusRooms.length === 1 ? "room" : "rooms" }}</span>
              <span>{{ lastOpenedLabel(room) }}</span>
            </div>
          </div>

          <div class="settings-room-actions">
            <button
              class="ghost-button settings-icon-button"
              type="button"
              :disabled="isBusy(room)"
              :aria-label="`Open ${room.displayName}`"
              title="Open room"
              @click="$emit('open-room', room)"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M7.5 4.75 12.75 10 7.5 15.25" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" />
              </svg>
            </button>
            <button
              v-if="room.canLeave"
              class="ghost-button"
              type="button"
              :disabled="isBusy(room)"
              :data-testid="`settings-leave-room-${slugify(room.roomIdentifier)}`"
              @click="$emit('leave-room', room)"
            >
              {{ busyLabel(room, "leave", "Leave") }}
            </button>
            <button
              v-if="room.canDelete"
              class="ghost-button settings-danger-button"
              type="button"
              :disabled="isBusy(room)"
              :data-testid="`settings-delete-room-${slugify(room.roomIdentifier)}`"
              @click="$emit('delete-room', room)"
            >
              {{ busyLabel(room, "delete", "Delete") }}
            </button>
            <span
              v-else-if="room.deleteReason"
              class="settings-muted-note"
              :title="room.deleteReason"
            >
              Protected
            </span>
          </div>
        </article>

        <article v-if="!accountRooms.length" class="surface-row single-line" data-testid="settings-rooms-empty">
          <p class="surface-title">No account rooms found.</p>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAccountRoomEntry,
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopMcpInstallState,
} from "../../../../../electron/ipc-types";

type SettingsFeedback = {
  message: string;
  state: "error" | "info" | "success";
};

const props = defineProps<{
  accountRooms: DesktopAccountRoomEntry[];
  appInfo: DesktopAppInfo | null;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  feedback: SettingsFeedback | null;
  mcpInstallState: DesktopMcpInstallState | null;
  roomActionBusyKey: string | null;
}>();

defineEmits<{
  "delete-room": [room: DesktopAccountRoomEntry];
  "leave-room": [room: DesktopAccountRoomEntry];
  "open-room": [room: DesktopAccountRoomEntry];
  "open-setup": [];
  refresh: [];
  "sign-out": [];
  "start-auth": [];
}>();

const accountTitle = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) return "No account connected";
  return props.authStatus.account.displayName || props.authStatus.account.login;
});

const accountSubtitle = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) {
    return props.authStatus?.error || "Connect GitHub to sync account rooms.";
  }
  return `@${props.authStatus.account.login}`;
});

const accountInitials = computed(() => {
  const label = accountTitle.value;
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "LA";
});

const apiEndpointLabel = computed(() => props.authStatus?.apiUrl || props.appInfo?.apiUrl || "API endpoint unavailable");

const versionLabel = computed(() => {
  if (!props.appInfo) return "version unavailable";
  return `Electron ${props.appInfo.versions.electron}`;
});

const mcpSetupLabel = computed(() => {
  if (!props.mcpInstallState) return "Setup status unavailable.";
  const installed = props.mcpInstallState.targets.filter((target) => target.status === "installed").length;
  const total = props.mcpInstallState.targets.length;
  return `${installed}/${total} MCP targets installed`;
});

const roomSummaryLabel = computed(() => {
  const focusCount = props.accountRooms.reduce((total, room) => total + room.focusRooms.length, 0);
  if (!props.accountRooms.length) return "0 rooms";
  if (!focusCount) return `${props.accountRooms.length} rooms`;
  return `${props.accountRooms.length} rooms, ${focusCount} focus`;
});

function actionKey(action: "delete" | "leave", room: DesktopAccountRoomEntry): string {
  return `${action}:${room.roomIdentifier}`;
}

function busyLabel(room: DesktopAccountRoomEntry, action: "delete" | "leave", fallback: string): string {
  return props.roomActionBusyKey === actionKey(action, room)
    ? action === "delete" ? "Deleting" : "Leaving"
    : fallback;
}

function isBusy(room: DesktopAccountRoomEntry): boolean {
  return props.busy
    || props.roomActionBusyKey === actionKey("leave", room)
    || props.roomActionBusyKey === actionKey("delete", room);
}

function lastOpenedLabel(room: DesktopAccountRoomEntry): string {
  if (!room.lastOpenedAt) return "No recent activity";
  const timestamp = new Date(room.lastOpenedAt);
  if (Number.isNaN(timestamp.getTime())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function roleSourceLabel(room: DesktopAccountRoomEntry): string {
  const role = room.role === "admin" ? "Admin" : "Participant";
  if (room.source === "create_invite") return `${role} · Created`;
  if (room.source === "open_room") return `${role} · Opened`;
  if (room.source === "agent") return `${role} · Agent activity`;
  if (room.source === "participant") return `${role} · Participant`;
  return role;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}
</script>
