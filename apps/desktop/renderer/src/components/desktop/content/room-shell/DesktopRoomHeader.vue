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
              v-else-if="isRoomPageTabId(tab.id)"
              :d="PAGE_ICON_PATH"
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
        <!-- More than three pinned pages share one tab that opens a menu of them. -->
        <button
          v-if="pagesMenu?.length"
          ref="pagesMenuTrigger"
          class="desktop-room-tab room-view-tab"
          :data-active="activePageInMenu !== null"
          data-testid="desktop-room-tab-pages"
          :aria-current="activePageInMenu ? 'page' : undefined"
          :aria-label="activePageInMenu ? `Pages, ${activePageInMenu.label}` : 'Pages'"
          :title="activePageInMenu?.label ?? 'Pages'"
          aria-haspopup="menu"
          :aria-expanded="pagesMenuOpen"
          type="button"
          @click="togglePagesMenu"
          @keydown.down.prevent="openPagesMenu"
        >
          <svg class="desktop-room-tab-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path :d="PAGE_ICON_PATH" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="room-view-label" aria-hidden="true"><span>{{ activePageInMenu?.label ?? "Pages" }}</span></span>
        </button>
        <span ref="indicatorElement" class="desktop-room-tab-underline room-view-underline" style="visibility: hidden" aria-hidden="true" />
      </nav>
      <div class="desktop-room-tools" data-testid="desktop-room-tools">
        <button v-if="offerTour" class="desktop-room-settings-button" type="button" aria-label="Quick tour"
          title="Quick tour" aria-haspopup="dialog" data-testid="room-header-quick-tour" @click="emit('openTour')"><Compass aria-hidden="true" /></button>
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
    <Teleport to="body">
      <div
        v-if="pagesMenuOpen && pagesMenu?.length"
        ref="pagesMenuElement"
        class="room-message-context-menu desktop-room-pages-menu"
        role="menu"
        aria-label="Pages"
        data-testid="desktop-room-pages-menu"
        :style="pagesMenuPosition"
        @keydown="pagesMenuKeydown"
      >
        <button
          v-for="page in pagesMenu"
          :key="page.id"
          type="button"
          role="menuitemradio"
          :aria-checked="activeTab === page.id"
          :data-testid="`desktop-room-pages-menu-${page.id}`"
          @click="choosePage(page.id)"
        >{{ page.label }}</button>
      </div>
    </Teleport>
  </header>
</template>

<script setup lang="ts">
import { Compass } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DesktopRoomInfo, DesktopRoomStorageState } from "../../../../../../electron/ipc-types";
import RoomViewCount from "../../../../../../../../shared/ui/RoomViewCount.vue";
import RoomAttentionButton from "../../../../../../../../shared/ui/RoomAttentionButton.vue";
import "../../../../../../../../shared/ui/room-navigation.css";
import type { SidebarMode } from "../../types";
import { isRoomPageTabId, type RoomTab, type RoomTabId } from "./types";
import { useSlidingTabIndicator } from "../../../../../../../../shared/ui/useSlidingTabIndicator";

const props = defineProps<{
  sidebarMode: SidebarMode;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  tabs: RoomTab[];
  offerTour?: boolean;
  /** Pinned pages when there are more than fit as tabs; empty or absent otherwise. */
  pagesMenu?: RoomTab[];
  activeTab: RoomTabId;
  searchOpen: boolean;
  actionPanelOpen: boolean;
  projectConnectionNeeded?: boolean;
  attention?: { count: number; pulse: boolean };
}>();

const emit = defineEmits<{
  openTour: [];
  cycleSidebar: [];
  toggleSearch: [];
  toggleActionPanel: [];
  selectTab: [tabId: RoomTabId];
  connectProject: [];
  openInbox: [];
}>();

const { tabsElement, indicatorElement, prepareTabChange } = useSlidingTabIndicator(() => props.activeTab);
const findShortcut = ref("Ctrl F");
const PAGE_ICON_PATH = "M4 2.5h5l3 3v8H4zM9 2.5v3h3M6 8.5h4M6 11h4";
const pagesMenuTrigger = ref<HTMLButtonElement | null>(null);
const pagesMenuElement = ref<HTMLElement | null>(null);
const pagesMenuOpen = ref(false);
const pagesMenuPosition = ref({ left: "0px", top: "0px" });
const activePageInMenu = computed(() => props.pagesMenu?.find((page) => page.id === props.activeTab) ?? null);

function openPagesMenu(): void {
  const rect = pagesMenuTrigger.value?.getBoundingClientRect();
  if (!rect) return;
  pagesMenuPosition.value = { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`, top: `${rect.bottom + 4}px` };
  pagesMenuOpen.value = true;
  void nextTick(() => pagesMenuElement.value?.querySelector<HTMLElement>('[aria-checked="true"], button')?.focus());
}

function closePagesMenu(returnFocus = false): void {
  if (!pagesMenuOpen.value) return;
  pagesMenuOpen.value = false;
  if (returnFocus) pagesMenuTrigger.value?.focus();
}

function togglePagesMenu(): void {
  if (pagesMenuOpen.value) closePagesMenu();
  else openPagesMenu();
}

function choosePage(tabId: RoomTabId): void {
  closePagesMenu(true);
  emit("selectTab", tabId);
}

function pagesMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" || event.key === "Tab") {
    event.preventDefault();
    closePagesMenu(true);
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const items = Array.from(pagesMenuElement.value?.querySelectorAll<HTMLElement>("button") ?? []);
  const index = items.findIndex((item) => item === document.activeElement);
  items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
}

function closePagesMenuOutside(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (target && (pagesMenuElement.value?.contains(target) || pagesMenuTrigger.value?.contains(target))) return;
  closePagesMenu();
}

watch(() => props.pagesMenu?.length ?? 0, (count) => { if (!count) closePagesMenu(); });
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
  window.addEventListener("pointerdown", closePagesMenuOutside, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleFindShortcut);
  window.removeEventListener("pointerdown", closePagesMenuOutside, true);
});

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

<style scoped>
.desktop-room-pages-menu {
  z-index: 130;
  width: 212px;
}
</style>
