<template>
  <header class="desktop-room-header" data-testid="desktop-room-header">
    <div class="desktop-room-header-main">
      <button
        v-if="sidebarMode === 'hidden'"
        class="ghost-button sidebar-reveal-button desktop-room-sidebar-reveal"
        type="button"
        aria-label="Show sidebar"
        data-testid="room-sidebar-reveal-button"
        @click="emit('cycleSidebar')"
      >
        <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
          <path d="M12.5 3.5v13" />
          <path d="m7.5 7.5 2.5 2.5-2.5 2.5" />
        </svg>
      </button>
      <div class="desktop-room-heading">
        <h3 class="desktop-room-title" :title="room.displayName">
          <span class="desktop-room-mark" aria-hidden="true">#</span>
          <span class="desktop-room-title-text">{{ headerDisplayName }}</span>
        </h3>
        <p v-if="room.gitRoom" class="desktop-room-repository" :title="room.gitRoom.repository.fullName">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 13H3V3h5l2 2h3v3M9 9v4m0-2h3m0 0V9m0 2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span>{{ room.gitRoom.repository.fullName }}</span>
        </p>
        <div v-if="room.code || storage.effectiveMode === 'local'" class="desktop-room-badges">
          <span
            v-if="storage.effectiveMode === 'local'"
            class="desktop-room-badge"
            data-testid="desktop-room-local-badge"
          >
            Local
          </span>
          <span v-if="room.code" class="desktop-room-badge" data-testid="desktop-room-code">{{ room.code }}</span>
        </div>
      </div>
      <div class="desktop-room-context-actions">
        <button v-if="attentionCount" class="desktop-room-project-connect" type="button" :aria-label="`Open Inbox for ${room.displayName}, ${attentionCount} requests need you`" data-testid="room-inbox-shortcut" @click="emit('openInbox')">Needs you · {{ attentionCount }} ↗</button>
        <button
          v-if="projectConnectionNeeded"
          class="desktop-room-project-connect"
          type="button"
          data-testid="desktop-room-connect-project"
          @click="emit('connectProject')"
        >
          Connect project
        </button>
      </div>
    </div>

    <div class="desktop-room-header-actions">
      <nav ref="tabsElement" class="desktop-room-tabs" aria-label="Room navigation" data-testid="desktop-room-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="desktop-room-tab"
          :data-active="activeTab === tab.id"
          :data-testid="`desktop-room-tab-${tab.id}`"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          :aria-label="tabAriaLabel(tab)"
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
              d="M2.5 8h2.25l1.5-3.5 3 7 1.25-3.5h3"
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
          <span>{{ tab.label }}</span>
          <small v-if="tab.count !== null">{{ tab.count }}</small>
          <DesktopStatusIndicator
            v-if="tab.indicator"
            class="desktop-room-tab-indicator"
            :label="tab.indicator.label"
            :count="tab.indicator.count ?? null"
            :tone="tab.indicator.tone ?? 'info'"
            :pulse="tab.indicator.pulse ?? false"
            :mode="tab.indicator.mode ?? 'dot'"
          />
        </button>
        <span ref="indicatorElement" class="desktop-room-tab-underline" style="visibility: hidden" aria-hidden="true" />
      </nav>
      <div class="desktop-room-tools" data-testid="desktop-room-tools">
        <button class="desktop-room-find" type="button" aria-label="Find in room" aria-keyshortcuts="Meta+f Control+f" :aria-expanded="searchOpen" :data-active="searchOpen" data-testid="desktop-room-search-toggle" @click="emit('toggleSearch')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
          <span>Find</span><kbd aria-hidden="true">{{ findShortcut }}</kbd>
        </button>
        <span class="desktop-room-tool-divider" aria-hidden="true" />
        <button class="desktop-room-settings-button" type="button" aria-label="Room settings" title="Room settings" aria-haspopup="dialog" :aria-expanded="actionPanelOpen" :data-active="actionPanelOpen" data-testid="desktop-room-actions-toggle" @click="emit('toggleActionPanel')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12M5 2.5v3M11 6.5v3M6 10.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopRoomInfo, DesktopRoomStorageState } from "../../../../../../electron/ipc-types";
import DesktopStatusIndicator from "../../controls/DesktopStatusIndicator.vue";
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
  attentionCount?: number;
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
