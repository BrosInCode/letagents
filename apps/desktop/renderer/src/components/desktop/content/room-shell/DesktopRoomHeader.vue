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
        <h3>{{ room.displayName }}</h3>
        <p class="desktop-room-subtitle">
          {{ room.kind === "focus" ? "A focused thread linked back to the main room." : "The main place for conversation, tasks, and coordination." }}
        </p>
      </div>
    </div>

    <div class="desktop-room-header-actions">
      <div class="desktop-room-tools" data-testid="desktop-room-tools">
        <button
          class="desktop-room-tool"
          type="button"
          :data-active="searchOpen"
          data-testid="desktop-room-search-toggle"
          @click="emit('toggleSearch')"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          Find
        </button>
        <button
          class="desktop-room-tool"
          type="button"
          :data-active="actionPanelOpen"
          data-testid="desktop-room-actions-toggle"
          @click="emit('toggleActionPanel')"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 5h10M3 11h10M6 3v4M10 9v4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          Settings
        </button>
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
          <span>{{ tab.label }}</span>
          <small v-if="tab.count !== null">{{ tab.count }}</small>
        </button>
      </nav>

      <div class="desktop-room-badges">
        <span v-if="room.code" class="desktop-room-badge" data-testid="desktop-room-code">{{ room.code }}</span>
        <span class="desktop-room-badge" data-testid="desktop-room-role">{{ room.role }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { DesktopRoomInfo } from "../../../../../../electron/ipc-types";
import type { SidebarMode } from "../../types";
import type { RoomTab, RoomTabId } from "./types";

defineProps<{
  sidebarMode: SidebarMode;
  room: DesktopRoomInfo;
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
</script>
