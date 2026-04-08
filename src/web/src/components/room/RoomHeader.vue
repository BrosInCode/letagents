<template>
  <header class="chat-header">
    <button class="menu-btn" @click="$emit('toggleDrawer')" type="button" aria-label="Open menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>

    <div v-show="!searchActive || !canSearch" class="chat-title">
      <h2>{{ title }}</h2>
      <p>{{ subtitle }}</p>
    </div>

    <!-- Inline search bar -->
    <div v-show="searchActive && canSearch" class="header-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        ref="searchInputEl"
        type="text"
        class="input"
        placeholder="Search messages..."
        autocomplete="off"
        :value="searchQuery"
        @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="searchQuery" class="search-count">{{ matchCount }} match{{ matchCount !== 1 ? 'es' : '' }}</span>
      <button class="search-close" @click="closeSearch" type="button" aria-label="Close search">&times;</button>
    </div>

    <div class="header-actions">
      <!-- Rename button (only when authenticated & room active) -->
      <button v-if="canRename" class="action-btn" @click="$emit('rename')" type="button" aria-label="Rename room" title="Rename room">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>

      <!-- Search toggle -->
      <button v-if="canSearch" class="action-btn" @click="toggleSearch" type="button" aria-label="Search messages" title="Search messages">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </button>

      <div class="tab-bar" role="tablist">
        <button
          role="tab"
          :aria-selected="activeTab === 'chat'"
          @click="$emit('update:activeTab', 'chat')"
          type="button"
        >Chat</button>
        <button
          v-if="showEventsTab"
          role="tab"
          :aria-selected="activeTab === 'events'"
          @click="$emit('update:activeTab', 'events')"
          type="button"
        >Events</button>
        <button
          role="tab"
          :aria-selected="activeTab === 'board'"
          @click="$emit('update:activeTab', 'board')"
          type="button"
        >Board</button>
        <button
          role="tab"
          :aria-selected="activeTab === 'activity'"
          @click="$emit('update:activeTab', 'activity')"
          type="button"
        >Activity</button>
      </div>

      <div class="presence" :data-state="connectionState">
        {{ presenceLabel }}
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'

const props = defineProps<{
  title: string
  subtitle: string
  activeTab: 'chat' | 'events' | 'board' | 'activity'
  connectionState: 'idle' | 'connecting' | 'live' | 'error'
  searchQuery: string
  matchCount: number
  canRename?: boolean
  showEventsTab?: boolean
}>()

defineEmits<{
  toggleDrawer: []
  'update:activeTab': [tab: 'chat' | 'events' | 'board' | 'activity']
  'update:searchQuery': [query: string]
  rename: []
}>()

const searchActive = ref(false)
const searchInputEl = ref<HTMLInputElement | null>(null)
const canSearch = computed(() => props.activeTab === 'chat')

const presenceLabel = computed(() => {
  switch (props.connectionState) {
    case 'live': return 'Connected'
    case 'connecting': return 'Connecting…'
    case 'error': return 'Reconnecting…'
    default: return 'Waiting for room'
  }
})

function toggleSearch() {
  if (!canSearch.value) return
  searchActive.value = !searchActive.value
  if (searchActive.value) {
    nextTick(() => searchInputEl.value?.focus())
  }
}

function closeSearch() {
  searchActive.value = false
}
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  height: 56px;
  border-bottom: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: none;
  border: none;
  cursor: pointer;
  transition: background 150ms;
}
.menu-btn:hover { background: var(--surface, #18181b); }
.menu-btn svg {
  width: 18px;
  height: 18px;
  stroke: var(--text, #fafafa);
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}

.chat-title { flex: 1; min-width: 0; }
.chat-title h2 {
  font-size: 0.92rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat-title p {
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Inline search ── */
.header-search {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px;
  border-radius: 8px;
  background: var(--surface, #18181b);
  border: 1px solid var(--line, #27272a);
  transition: border-color 200ms;
}
.header-search:focus-within { border-color: var(--text, #fafafa); }
.header-search svg { flex-shrink: 0; opacity: 0.5; width: 14px; height: 14px; }
.header-search .input {
  flex: 1;
  border: none;
  background: none;
  color: var(--text, #fafafa);
  font-size: 0.82rem;
  outline: none;
  font-family: inherit;
}
.header-search .input::placeholder { color: var(--muted, #71717a); }
.search-count { font-size: 0.72rem; color: var(--muted, #71717a); white-space: nowrap; }
.search-close {
  background: none;
  border: none;
  color: var(--muted, #71717a);
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
  padding: 0 2px;
  transition: color 150ms;
}
.search-close:hover { color: var(--text, #fafafa); }

.header-actions { display: flex; align-items: center; gap: 4px; }

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted, #71717a);
  transition: all 150ms;
}
.action-btn:hover { background: var(--surface, #18181b); color: var(--text, #fafafa); }

.tab-bar {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--surface, #18181b);
}
.tab-bar button {
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted, #71717a);
  background: none;
  border: none;
  cursor: pointer;
  transition: all 150ms;
}
.tab-bar button[aria-selected="true"] {
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
}
.tab-bar button:hover:not([aria-selected="true"]) { color: var(--text, #fafafa); }

.presence {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.72rem;
  color: var(--muted, #71717a);
  white-space: nowrap;
}
.presence::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning, #fbbf24);
  transition: background 150ms;
}
.presence[data-state="live"]::before { background: var(--success, #34d399); }
.presence[data-state="error"]::before { background: var(--danger, #f87171); }

@media (max-width: 600px) {
  .chat-header { padding: 0 12px; gap: 8px; }
  .action-btn:first-of-type { display: none; }
}
</style>
