<template>
  <header class="desktop-room-header" data-testid="desktop-room-header">
    <template v-if="sidebarMode === 'hidden'">
      <button class="ghost-button sidebar-reveal-button desktop-room-sidebar-reveal" type="button" aria-label="Show sidebar" data-testid="room-sidebar-reveal-button" @click="emit('cycleSidebar')">
        <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM12.5 3.5v13m-5-9 2.5 2.5-2.5 2.5" /></svg>
      </button>
      <h3 class="desktop-room-toolbar-title" :title="room.gitRoom ? `${room.displayName} · ${room.gitRoom.repository.fullName}` : room.displayName">{{ headerDisplayName }}</h3>
    </template>
      <nav ref="tabsElement" class="desktop-room-tabs room-view-tabs" aria-label="Room navigation" data-testid="desktop-room-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="desktop-room-tab room-view-tab"
          :data-active="activeTab === tab.id"
          :data-testid="`desktop-room-tab-${tab.id}`"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          :aria-label="tabAriaLabel(tab)"
          :title="tab.label"
          type="button"
          @click="prepareTabChange($event, tab.id); emit('selectTab', tab.id)"
        >
          <svg class="desktop-room-tab-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              v-if="tab.id === 'chat'"
              d="M3.5 4.5h9v5.25h-4L5.5 12v-2.25h-2V4.5Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'events'"
              d="M5 5v8m6-2V7a3 3 0 0 0-3-3M3 3a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm6 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'board'"
              d="M3 2.5h10v11H3zM6.5 2.5v11M10 2.5v11"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'activity'"
              d="M10 13v-1.5A2.5 2.5 0 0 0 7.5 9h-3A2.5 2.5 0 0 0 2 11.5V13M8 4.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm3-2a2 2 0 0 1 0 4M14 13v-1.5A2.5 2.5 0 0 0 12 9"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'rooms'"
              d="M2.5 2.5h11v11h-11zM2.5 6h11M7 6v7.5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else
              d="M4 2.5h8v11l-4-2.5-4 2.5z"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="room-view-label" aria-hidden="true"><span>{{ tab.label }}</span></span>
          <RoomViewCount v-if="tab.id === 'events'" :count="tab.indicator?.count ?? 0" notification />
          <RoomViewCount v-else-if="tab.count !== null" :count="tab.count" />
        </button>
        <span ref="indicatorElement" class="desktop-room-tab-underline room-view-underline" style="visibility: hidden" aria-hidden="true" />
      </nav>
      <div class="desktop-room-tools" data-testid="desktop-room-tools">
        <RoomAttentionButton v-if="attentionCount" :count="attentionCount" :pulse="attention?.pulse" :aria-label="`Open Inbox for ${room.displayName}, ${attentionCount} ${attentionCount === 1 ? 'request needs' : 'requests need'} you`" data-testid="room-inbox-shortcut" @click="emit('openInbox')" />
        <span v-if="storage.effectiveMode === 'local'" class="desktop-room-local-label" data-testid="desktop-room-local-badge">Local</span>
        <button v-if="projectConnectionNeeded" class="desktop-room-project-connect" type="button" data-testid="desktop-room-connect-project" @click="emit('connectProject')">Connect project</button>
        <button class="desktop-room-find" type="button" aria-label="Find in room" :title="`Find in room (${findShortcut})`" aria-keyshortcuts="Meta+f Control+f" :aria-expanded="searchOpen" :data-active="searchOpen" data-testid="desktop-room-search-toggle" @click="emit('toggleSearch')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
        </button>
        <button class="desktop-room-settings-button" type="button" aria-label="Room settings" title="Room settings" aria-haspopup="dialog" :aria-expanded="actionPanelOpen" :data-active="actionPanelOpen" data-testid="desktop-room-actions-toggle" @click="emit('toggleActionPanel')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1" fill="currentColor"/></svg>
        </button>
      </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopRoomInfo, DesktopRoomStorageState } from "../../../../../../electron/ipc-types";
import RoomViewCount from "../../../../../../../../shared/ui/RoomViewCount.vue";
import RoomAttentionButton from "../../../../../../../../shared/ui/RoomAttentionButton.vue";
import "../../../../../../../../shared/ui/room-navigation.css";
import type { SidebarMode } from "../../types";
import type { RoomTab, RoomTabId } from "./types";
import { useSlidingTabIndicator } from "../../../../../../../../shared/ui/useSlidingTabIndicator";

const props = defineProps<{
  sidebarMode: SidebarMode;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  tabs: RoomTab[];
  activeTab: RoomTabId;
  searchOpen: boolean;
  actionPanelOpen: boolean;
  projectConnectionNeeded?: boolean;
  attention?: { count: number; pulse: boolean };
}>();

const emit = defineEmits<{
  cycleSidebar: [];
  toggleSearch: [];
  toggleActionPanel: [];
  selectTab: [tabId: RoomTabId];
  connectProject: [];
  openInbox: [];
}>();

const { tabsElement, indicatorElement, prepareTabChange } = useSlidingTabIndicator(() => props.activeTab);
const findShortcut = ref("Ctrl F");
const headerDisplayName = computed(() => compactRoomDisplayName(props.room.displayName));
const attentionCount = computed(() => props.attention?.count ?? 0);

function handleFindShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f" || props.actionPanelOpen) return;
  event.preventDefault();
  if (props.searchOpen) {
    tabsElement.value?.closest(".desktop-room-shell")?.querySelector<HTMLInputElement>(".desktop-room-search-strip input")?.focus();
  } else {
    emit("toggleSearch");
  }
}
onMounted(() => {
  findShortcut.value = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ F" : "Ctrl F";
  window.addEventListener("keydown", handleFindShortcut);
});
onBeforeUnmount(() => window.removeEventListener("keydown", handleFindShortcut));

function tabAriaLabel(tab: RoomTab): string {
  const parts = [tab.label];
  if (tab.count !== null) parts.push(String(tab.count));
  if (tab.indicator) {
    parts.push(tab.indicator.count ? `${tab.indicator.count} new` : tab.indicator.label);
  }
  return parts.join(", ");
}

function compactRoomDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  const branchPrefix = "Branch: ";
  if (normalized.startsWith(branchPrefix)) {
    return `${branchPrefix}${compactBranchName(normalized.slice(branchPrefix.length), 28)}`;
  }
  return compactMiddle(normalized, 36);
}

function compactBranchName(branchName: string, maxLength: number): string {
  const normalized = branchName.trim();
  if (normalized.length <= maxLength) return normalized;
  const slashIndex = normalized.indexOf("/");
  if (slashIndex > 0) {
    const namespace = normalized.slice(0, slashIndex);
    const suffixBudget = maxLength - namespace.length - 4;
    if (suffixBudget > 8) {
      return `${namespace}/${normalized.slice(slashIndex + 1, slashIndex + 1 + suffixBudget)}...`;
    }
  }
  return compactMiddle(normalized, maxLength);
}

function compactMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const leftLength = Math.ceil((maxLength - 3) / 2);
  const rightLength = Math.floor((maxLength - 3) / 2);
  return `${value.slice(0, leftLength)}...${value.slice(-rightLength)}`;
}

</script>
