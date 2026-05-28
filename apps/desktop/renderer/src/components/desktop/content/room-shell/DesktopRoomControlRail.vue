<template>
  <div v-if="actionPanelOpen || searchOpen" class="desktop-room-control-rail" data-testid="desktop-room-control-rail">
    <DesktopRoomActionPanel
      :open="actionPanelOpen"
      :room="room"
      :room-url="roomUrl"
      :copied="copied"
      :sound-enabled="soundEnabled"
      :notifications-enabled="notificationsEnabled"
      :notification-permission="notificationPermission"
      :liquid-glass-enabled="liquidGlassEnabled"
      :rename-busy="renameBusy"
      :rename-error="renameError"
      :github-status="githubStatus"
      :github-loading="githubLoading"
      :github-busy="githubBusy"
      :github-error="githubError"
      @copy-room-link="emit('copyRoomLink')"
      @open-rules="emit('openRules')"
      @toggle-sound="emit('toggleSound')"
      @toggle-notifications="emit('toggleNotifications')"
      @toggle-liquid-glass="emit('toggleLiquidGlass')"
      @rename-room="emit('renameRoom', $event)"
      @refresh-github="emit('refreshGithub')"
      @install-github="emit('installGithub')"
      @export-chat="emit('exportChat')"
    />

    <div v-if="searchOpen" class="desktop-room-search-strip" data-testid="desktop-room-search-strip">
      <label>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
        <input
          ref="searchInputElement"
          v-model="searchQuery"
          type="search"
          placeholder="Search messages"
          data-testid="desktop-room-search-input"
          @keydown.enter.prevent="emit('moveSearch', 1)"
          @keydown.escape.prevent="emit('closeSearch')"
        >
      </label>
      <span>{{ searchSummary }}</span>
      <div>
        <button type="button" :disabled="!searchResultsCount" @click="emit('moveSearch', -1)">Previous</button>
        <button type="button" :disabled="!searchResultsCount" @click="emit('moveSearch', 1)">Next</button>
        <button type="button" @click="emit('closeSearch')">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import type {
  DesktopGitHubIntegrationStatus,
  DesktopRoomInfo,
} from "../../../../../../electron/ipc-types";
import DesktopRoomActionPanel from "../DesktopRoomActionPanel.vue";

const props = defineProps<{
  actionPanelOpen: boolean;
  searchOpen: boolean;
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
  searchSummary: string;
  searchResultsCount: number;
}>();

const emit = defineEmits<{
  copyRoomLink: [];
  openRules: [];
  toggleSound: [];
  toggleNotifications: [];
  toggleLiquidGlass: [];
  renameRoom: [displayName: string];
  refreshGithub: [];
  installGithub: [];
  exportChat: [];
  moveSearch: [delta: 1 | -1];
  closeSearch: [];
}>();

const searchQuery = defineModel<string>("searchQuery", { required: true });
const searchInputElement = ref<HTMLInputElement | null>(null);

watch(
  () => props.searchOpen,
  async (open) => {
    if (!open) return;
    await nextTick();
    searchInputElement.value?.focus();
  },
);
</script>
