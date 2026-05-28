<template>
  <nav class="mobile-bottom-nav" role="tablist" aria-label="Room navigation">
    <button
      role="tab"
      :aria-selected="activeTab === 'chat'"
      :class="{ active: activeTab === 'chat' }"
      type="button"
      @click="selectTab('chat')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Chat</span>
    </button>
    <button
      v-if="showEventsTab"
      role="tab"
      :aria-selected="activeTab === 'events'"
      :class="{ active: activeTab === 'events' }"
      type="button"
      @click="selectTab('events')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span>Events</span>
    </button>
    <button
      role="tab"
      :aria-selected="activeTab === 'board'"
      :class="{ active: activeTab === 'board' }"
      type="button"
      @click="selectTab('board')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
      <span>Board</span>
    </button>
    <button
      role="tab"
      :aria-selected="activeTab === 'activity'"
      :class="{ active: activeTab === 'activity' }"
      type="button"
      @click="selectTab('activity')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <span>Activity</span>
    </button>
    <button
      role="tab"
      :aria-selected="activeTab === 'rooms'"
      :class="{ active: activeTab === 'rooms' }"
      type="button"
      @click="selectTab('rooms')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="8" y="13" width="8" height="7"/></svg>
      <span>Rooms</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import type { RoomTab } from './types'

defineProps<{
  activeTab: RoomTab
  showEventsTab: boolean
}>()

const emit = defineEmits<{
  'update:activeTab': [tab: RoomTab]
}>()

function selectTab(tab: RoomTab) {
  emit('update:activeTab', tab)
}
</script>

<style scoped>
.mobile-bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  .mobile-bottom-nav {
    display: flex;
    align-items: center;
    justify-content: space-around;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding: 0 4px env(safe-area-inset-bottom, 0px);
    background: var(--bg-0, #09090b);
    border-top: 1px solid var(--line, #27272a);
    position: sticky;
    bottom: 0;
    z-index: 50;
  }

  .mobile-bottom-nav button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    flex: 1;
    padding: 6px 0;
    border: none;
    background: none;
    color: var(--muted, #71717a);
    cursor: pointer;
    transition: color 150ms;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-bottom-nav button svg {
    width: 19px;
    height: 19px;
  }

  .mobile-bottom-nav button span {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .mobile-bottom-nav button.active,
  .mobile-bottom-nav button[aria-selected="true"] {
    color: var(--accent, #6366f1);
  }

  .mobile-bottom-nav button:hover:not(.active) {
    color: var(--text, #fafafa);
  }
}
</style>
