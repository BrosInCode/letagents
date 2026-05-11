<template>
  <section class="settings-page surface-page" data-testid="settings-view">
    <article class="settings-hero surface-intro">
      <div>
        <p class="sidebar-label">Settings</p>
        <h3>Control the account, rooms, and local setup.</h3>
        <p>Keep account-connected rooms organized, recover rooms you left, and manage destructive room actions from one place.</p>
      </div>
      <div class="settings-hero-actions">
        <button class="ghost-button" type="button" data-testid="settings-open-setup" @click="$emit('open-setup')">
          Setup
        </button>
        <button class="primary-button" type="button" :disabled="busy" data-testid="settings-refresh-rooms" @click="$emit('refresh')">
          {{ busy ? "Refreshing" : "Refresh" }}
        </button>
      </div>
    </article>

    <div class="settings-summary-grid" data-testid="settings-summary">
      <article class="settings-summary-card">
        <span>Active</span>
        <strong>{{ activeRoomCount }}</strong>
      </article>
      <article class="settings-summary-card">
        <span>Focus</span>
        <strong>{{ focusRoomCount }}</strong>
      </article>
      <article class="settings-summary-card">
        <span>Created</span>
        <strong>{{ createdRoomCount }}</strong>
      </article>
      <article class="settings-summary-card">
        <span>Left</span>
        <strong>{{ archivedRoomCount }}</strong>
      </article>
    </div>

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
        </div>
      </article>
    </div>

    <section class="settings-section" aria-labelledby="settings-rooms-title">
      <header class="settings-section-header">
        <div>
          <p class="sidebar-label">Rooms</p>
          <h4 id="settings-rooms-title">Account rooms</h4>
        </div>
        <span class="state-pill" data-state="connected">{{ roomSummaryLabel }}</span>
      </header>

      <div class="settings-room-toolbar" data-testid="settings-room-toolbar">
        <label class="settings-search">
          <span>Search rooms</span>
          <input v-model="roomSearch" type="search" placeholder="Search name, ID, or focus room" />
        </label>
        <div class="settings-filter-group" role="tablist" aria-label="Room filters">
          <button
            v-for="filter in roomFilters"
            :key="filter.id"
            class="settings-filter"
            type="button"
            :data-active="roomFilter === filter.id"
            :data-testid="`settings-filter-${filter.id}`"
            @click="roomFilter = filter.id"
          >
            {{ filter.label }}
          </button>
        </div>
      </div>

      <p
        v-if="feedback"
        class="settings-feedback"
        :data-state="feedback.state"
        data-testid="settings-feedback"
      >
        {{ feedback.message }}
      </p>

      <div class="surface-list settings-room-list" data-testid="settings-room-list">
        <article
          v-for="room in filteredRooms"
          :key="room.roomIdentifier"
          class="settings-room-row"
          :data-archived="room.archived"
          :data-testid="`settings-room-${slugify(room.roomIdentifier)}`"
        >
          <div class="settings-room-header">
            <button
              class="settings-pin-button"
              type="button"
              :disabled="isBusy(room)"
              :aria-label="room.pinned ? `Unpin ${room.displayName}` : `Pin ${room.displayName}`"
              :title="room.pinned ? 'Unpin room' : 'Pin room'"
              :data-active="room.pinned"
              @click="$emit('toggle-pin-room', room)"
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M10.75 2.75 15 7l-2.2 2.2.35 4.15-1.3 1.3-3.15-3.15-3.95 3.95-.2-.2 3.95-3.95-3.15-3.15 1.3-1.3 4.15.35 1.95-2.45Z" />
              </svg>
            </button>
            <div class="settings-room-copy">
              <div class="settings-room-title-line">
                <p class="surface-title">{{ room.displayName }}</p>
                <span v-if="room.archived" class="state-pill" data-state="offline">left</span>
                <span v-else-if="room.pinned" class="state-pill" data-state="installed">pinned</span>
              </div>
              <p class="surface-subtitle">{{ room.roomIdentifier }}</p>
            </div>
            <div class="settings-room-actions">
              <button class="ghost-button settings-compact-button" type="button" :disabled="isBusy(room)" @click="copyRoomIdentifier(room)">
                {{ copiedRoomIdentifier === room.roomIdentifier ? "Copied" : "Copy ID" }}
              </button>
              <button
                v-if="!room.archived"
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
            </div>
          </div>

          <div class="settings-room-meta">
            <span>{{ roleSourceLabel(room) }}</span>
            <span>{{ lastOpenedLabel(room) }}</span>
            <span v-if="room.focusRooms.length">{{ room.focusRooms.length }} focus {{ room.focusRooms.length === 1 ? "room" : "rooms" }}</span>
            <span v-if="room.canDelete">created here</span>
          </div>

          <div v-if="room.focusRooms.length" class="settings-focus-list">
            <span v-for="focusRoom in room.focusRooms" :key="focusRoom.roomIdentifier">
              {{ focusRoom.displayName }}
            </span>
          </div>

          <footer class="settings-room-footer">
            <button
              v-if="room.archived"
              class="primary-button"
              type="button"
              :disabled="isBusy(room)"
              :data-testid="`settings-restore-room-${slugify(room.roomIdentifier)}`"
              @click="$emit('restore-room', room)"
            >
              {{ busyLabel(room, "restore", "Restore") }}
            </button>
            <button
              v-else-if="room.canLeave"
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
            <span v-else-if="room.deleteReason" class="settings-muted-note" :title="room.deleteReason">
              Protected
            </span>
          </footer>
        </article>

        <article v-if="!filteredRooms.length" class="surface-row single-line" data-testid="settings-rooms-empty">
          <p class="surface-title">{{ emptyRoomsLabel }}</p>
        </article>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
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

type RoomFilter = "active" | "all" | "created" | "admin" | "left";

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
  "restore-room": [room: DesktopAccountRoomEntry];
  "toggle-pin-room": [room: DesktopAccountRoomEntry];
  refresh: [];
  "sign-out": [];
  "start-auth": [];
}>();

const copiedRoomIdentifier = ref<string | null>(null);
const roomFilter = ref<RoomFilter>("active");
const roomSearch = ref("");

const roomFilters: Array<{ id: RoomFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
  { id: "created", label: "Created" },
  { id: "admin", label: "Admin" },
  { id: "left", label: "Left" },
];

const activeRoomCount = computed(() => props.accountRooms.filter((room) => !room.archived).length);
const archivedRoomCount = computed(() => props.accountRooms.filter((room) => room.archived).length);
const createdRoomCount = computed(() => props.accountRooms.filter((room) => room.canDelete).length);
const focusRoomCount = computed(() => props.accountRooms.reduce((total, room) => total + room.focusRooms.length, 0));

const filteredRooms = computed(() => {
  const search = roomSearch.value.trim().toLowerCase();
  return props.accountRooms
    .filter((room) => {
      if (roomFilter.value === "active" && room.archived) return false;
      if (roomFilter.value === "created" && !room.canDelete) return false;
      if (roomFilter.value === "admin" && room.role !== "admin") return false;
      if (roomFilter.value === "left" && !room.archived) return false;
      if (!search) return true;
      const searchable = [
        room.displayName,
        room.roomIdentifier,
        room.source || "",
        ...room.focusRooms.flatMap((focusRoom) => [
          focusRoom.displayName,
          focusRoom.roomIdentifier,
          focusRoom.sourceTaskId || "",
          focusRoom.focusKey || "",
        ]),
      ].join(" ").toLowerCase();
      return searchable.includes(search);
    })
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastOpenedAt || "").localeCompare(a.lastOpenedAt || "");
    });
});

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

const emptyRoomsLabel = computed(() => {
  if (roomSearch.value.trim()) return "No rooms match that search.";
  if (roomFilter.value === "left") return "No left rooms.";
  if (roomFilter.value === "created") return "No created rooms with delete permissions.";
  return "No account rooms found.";
});

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
  if (!props.accountRooms.length) return "0 rooms";
  return `${activeRoomCount.value} active, ${archivedRoomCount.value} left`;
});

function actionKey(action: "delete" | "leave" | "pin" | "restore", room: DesktopAccountRoomEntry): string {
  return `${action}:${room.roomIdentifier}`;
}

function busyLabel(room: DesktopAccountRoomEntry, action: "delete" | "leave" | "restore", fallback: string): string {
  return props.roomActionBusyKey === actionKey(action, room)
    ? action === "delete" ? "Deleting" : action === "restore" ? "Restoring" : "Leaving"
    : fallback;
}

function isBusy(room: DesktopAccountRoomEntry): boolean {
  return props.busy
    || props.roomActionBusyKey === actionKey("leave", room)
    || props.roomActionBusyKey === actionKey("delete", room)
    || props.roomActionBusyKey === actionKey("pin", room)
    || props.roomActionBusyKey === actionKey("restore", room);
}

async function copyRoomIdentifier(room: DesktopAccountRoomEntry): Promise<void> {
  try {
    await navigator.clipboard?.writeText(room.roomIdentifier);
    copiedRoomIdentifier.value = room.roomIdentifier;
    window.setTimeout(() => {
      if (copiedRoomIdentifier.value === room.roomIdentifier) {
        copiedRoomIdentifier.value = null;
      }
    }, 1400);
  } catch {
    copiedRoomIdentifier.value = null;
  }
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
  if (room.archived) return `${role} · Left`;
  if (room.source === "create_invite") return `${role} · Created`;
  if (room.source === "open_room") return `${role} · Opened`;
  if (room.source === "agent") return `${role} · Agent activity`;
  if (room.source === "participant") return `${role} · Participant`;
  if (room.source === "focus") return `${role} · Focus activity`;
  return role;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}
</script>
