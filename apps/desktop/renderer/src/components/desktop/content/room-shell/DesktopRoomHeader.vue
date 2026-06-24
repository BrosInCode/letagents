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
        <h3 class="desktop-room-title">
          <span v-if="isGitHubRepoRoom" class="desktop-room-provider-icon" aria-label="GitHub repository room">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 .2a7.9 7.9 0 0 0-2.5 15.4c.4.1.5-.2.5-.4v-1.4c-2 .4-2.5-.9-2.5-.9-.3-.8-.8-1-.8-1-.7-.5.1-.5.1-.5.7.1 1.1.8 1.1.8.7 1.1 1.8.8 2.1.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.8 0-.8.3-1.5.8-2.1-.1-.2-.3-1 .1-2.1 0 0 .6-.2 2.1.8A7.3 7.3 0 0 1 8 4.3c.6 0 1.3.1 1.9.3 1.4-1 2.1-.8 2.1-.8.4 1.1.1 1.9.1 2.1.5.6.8 1.3.8 2.1 0 2.9-1.8 3.6-3.4 3.8.3.2.5.7.5 1.4v2c0 .2.1.5.5.4A7.9 7.9 0 0 0 8 .2Z"
              />
            </svg>
          </span>
          <span class="desktop-room-title-text">{{ room.displayName }}</span>
        </h3>
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
    </div>

    <div class="desktop-room-header-actions">
      <div
        ref="overflowMenuRoot"
        class="desktop-room-overflow"
        data-testid="desktop-room-tools"
        @pointerdown.stop
        @keydown.escape.stop="closeOverflowMenu"
      >
        <button
          class="desktop-room-overflow-button"
          type="button"
          aria-label="Room actions"
          aria-haspopup="menu"
          :aria-expanded="overflowMenuOpen"
          :data-active="overflowMenuOpen || searchOpen || actionPanelOpen"
          data-testid="desktop-room-overflow-toggle"
          @click.stop="toggleOverflowMenu"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 8h.01M8 8h.01M12 8h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </button>
        <Transition name="desktop-room-overflow-pop" @after-leave="handleOverflowMenuAfterLeave">
          <div
            v-if="overflowMenuOpen"
            class="desktop-room-overflow-menu"
            role="menu"
            data-testid="desktop-room-overflow-menu"
          >
            <button
              class="desktop-room-menu-item"
              type="button"
              role="menuitem"
              :data-active="searchOpen"
              data-testid="desktop-room-search-toggle"
              @click.stop="selectOverflowAction('find')"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
              <span>Find</span>
            </button>
            <button
              class="desktop-room-menu-item"
              type="button"
              role="menuitem"
              :data-active="actionPanelOpen"
              data-testid="desktop-room-actions-toggle"
              @click.stop="selectOverflowAction('settings')"
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 5h10M3 11h10M6 3v4M10 9v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </Transition>
      </div>

      <nav class="desktop-room-tabs" role="tablist" aria-label="Room navigation" data-testid="desktop-room-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="desktop-room-tab"
          :data-active="activeTab === tab.id"
          :data-testid="`desktop-room-tab-${tab.id}`"
          role="tab"
          :aria-selected="activeTab === tab.id"
          type="button"
          @click="emit('selectTab', tab.id)"
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
              v-else-if="tab.id === 'inbox'"
              d="M3.25 3.5h9.5v5.25l-1.5 3.75h-6.5l-1.5-3.75V3.5Zm0 5.25h3l.75 1.5h2l.75-1.5h3"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'events'"
              d="M2.5 8h2.25l1.5-3.5 3 7 1.25-3.5h3M11.5 3.5h2v2"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else-if="tab.id === 'board'"
              d="M3.25 3.5h9.5M4.25 6h2.5v6h-2.5V6Zm5 0h2.5v3.75h-2.5V6Z"
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
              d="M5 3.5h7.5v7.5H5V3.5Zm-1.5 2v7h7"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              v-else
              d="M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 13c.75-2.15 2.25-3.25 4.5-3.25 1.25 0 2.28.34 3.08 1.03M12.5 3.5v3M11 5h3"
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
      </nav>

    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopRoomInfo, DesktopRoomStorageState } from "../../../../../../electron/ipc-types";
import DesktopStatusIndicator from "../../controls/DesktopStatusIndicator.vue";
import type { SidebarMode } from "../../types";
import type { RoomTab, RoomTabId } from "./types";

const props = defineProps<{
  sidebarMode: SidebarMode;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  tabs: RoomTab[];
  activeTab: RoomTabId;
  searchOpen: boolean;
  actionPanelOpen: boolean;
}>();

const emit = defineEmits<{
  cycleSidebar: [];
  toggleSearch: [];
  toggleActionPanel: [];
  selectTab: [tabId: RoomTabId];
}>();

const overflowMenuOpen = ref(false);
const overflowMenuRoot = ref<HTMLElement | null>(null);
const pendingOverflowAction = ref<"find" | "settings" | null>(null);

const isGitHubRepoRoom = computed(() =>
  [props.room.identifier, props.room.name, props.room.displayName]
    .some((value) => value.toLowerCase().startsWith("github.com/"))
);

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
});

function toggleOverflowMenu(): void {
  pendingOverflowAction.value = null;
  overflowMenuOpen.value = !overflowMenuOpen.value;
}

function closeOverflowMenu(): void {
  overflowMenuOpen.value = false;
}

function selectOverflowAction(action: "find" | "settings"): void {
  pendingOverflowAction.value = action;
  closeOverflowMenu();
}

function handleOverflowMenuAfterLeave(): void {
  const action = pendingOverflowAction.value;
  pendingOverflowAction.value = null;
  if (action === null) return;
  runOverflowAction(action);
}

function runOverflowAction(action: "find" | "settings"): void {
  if (action === "find") {
    emit("toggleSearch");
    return;
  }
  emit("toggleActionPanel");
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!overflowMenuOpen.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (overflowMenuRoot.value?.contains(target)) return;
  closeOverflowMenu();
}
</script>
