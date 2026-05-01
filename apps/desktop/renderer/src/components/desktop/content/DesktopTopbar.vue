<template>
  <header class="app-topbar" :data-room-entry="activeEntry.type === 'room'" data-testid="desktop-topbar">
    <button
      v-if="sidebarMode === 'hidden'"
      class="ghost-button sidebar-reveal-button"
      type="button"
      aria-label="Show sidebar"
      data-testid="sidebar-reveal-button"
      @click="$emit('cycle-sidebar')"
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M7 4.5 12.5 10 7 15.5"
          fill="none"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.8"
        />
      </svg>
    </button>
    <div v-if="activeEntry.type !== 'room'" class="topbar-title">
      <p class="sidebar-label">{{ activeEntry.sectionLabel }}</p>
      <h2>{{ activeEntry.title }}</h2>
    </div>
    <div v-else class="topbar-spacer" aria-hidden="true"></div>
    <div class="topbar-actions">
      <button class="ghost-button" type="button" data-testid="topbar-system-button" @click="$emit('show-system')">
        System
      </button>
      <button
        class="primary-button"
        type="button"
        :disabled="loading"
        data-testid="topbar-refresh-button"
        @click="$emit('refresh')"
      >
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import type { SidebarEntry, SidebarMode } from "../types";

defineProps<{
  activeEntry: SidebarEntry;
  sidebarMode: SidebarMode;
  loading: boolean;
}>();

defineEmits<{
  refresh: [];
  "show-system": [];
  "cycle-sidebar": [];
}>();
</script>
