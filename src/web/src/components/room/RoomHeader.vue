<template>
  <header class="chat-header">
    <button class="menu-btn" @click="$emit('toggleDrawer')" type="button" aria-label="Open menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>

    <div class="chat-title" :class="{ searching: searchActive }">
      <h2>{{ title }}</h2>
      <p>{{ subtitle }}</p>
    </div>

    <!-- Inline Search Bar -->
    <div class="header-search" :class="{ active: searchActive }">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <input
        ref="searchInputEl"
        type="text"
        class="input"
        placeholder="Search messages..."
        :value="searchValue"
        @input="onSearchInput"
        @keydown.escape.prevent="$emit('closeSearch')"
      />
      <span class="search-count">{{ searchCountText }}</span>
      <button class="search-close" type="button" aria-label="Close search" @click="$emit('closeSearch')">&times;</button>
    </div>

    <div class="header-actions">
      <button
        v-if="isAdmin"
        class="rename-btn"
        type="button"
        aria-label="Rename room"
        @click="$emit('rename')"
      >
        <svg class="icon-inline" viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">
          <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
        </svg>
      </button>
      <button
        class="rename-btn"
        type="button"
        aria-label="Search messages"
        title="Search messages"
        @click="$emit('toggleSearch')"
      >
        <svg class="icon-inline" viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
      </button>
      <div class="tab-bar" role="tablist">
        <button
          role="tab"
          :aria-selected="activeTab === 'chat'"
          @click="$emit('update:activeTab', 'chat')"
          type="button"
        >Chat</button>
        <button
          role="tab"
          :aria-selected="activeTab === 'board'"
          @click="$emit('update:activeTab', 'board')"
          type="button"
        >Board</button>
      </div>

      <div class="presence" :data-state="connectionState">
        {{ presenceLabel }}
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'

const props = defineProps<{
  title: string
  subtitle: string
  activeTab: 'chat' | 'board'
  connectionState: 'idle' | 'connecting' | 'live' | 'error'
  isAdmin: boolean
  searchActive: boolean
}>()

const emit = defineEmits<{
  toggleDrawer: []
  'update:activeTab': [tab: 'chat' | 'board']
  rename: []
  toggleSearch: []
  search: [query: string]
  closeSearch: []
}>()

const searchInputEl = ref<HTMLInputElement | null>(null)
const searchValue = ref('')
const searchCountText = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onSearchInput(e: Event) {
  const value = (e.target as HTMLInputElement).value
  searchValue.value = value
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('search', value.trim())
  }, 250)
}

watch(() => props.searchActive, async (active) => {
  if (active) {
    await nextTick()
    searchInputEl.value?.focus()
  } else {
    // Clear pending debounce to prevent stale query from reapplying
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    searchValue.value = ''
    searchCountText.value = ''
  }
})

onUnmounted(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
})

const presenceLabel = computed(() => {
  switch (props.connectionState) {
    case 'live': return 'Live updates'
    case 'connecting': return 'Connecting…'
    case 'error': return 'Reconnecting…'
    default: return 'Waiting for room'
  }
})
</script>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  height: 56px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-0);
}

.menu-btn {
  display: flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border-radius: 8px;
  background: none; border: none; cursor: pointer;
  transition: background 150ms;
}
.menu-btn:hover { background: var(--surface); }
.menu-btn svg {
  width: 18px; height: 18px; stroke: var(--text);
  fill: none; stroke-width: 2; stroke-linecap: round;
}

.chat-title { flex: 1; min-width: 0; }
.chat-title.searching { display: none; }
.chat-title h2 {
  font-size: 0.92rem; font-weight: 700; letter-spacing: -0.02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.chat-title p {
  font-size: 0.72rem; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.header-search {
  display: none; flex: 1; align-items: center; gap: 8px;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 8px; padding: 4px 10px; min-width: 0;
  transition: border-color 0.2s;
}
.header-search.active { display: flex; }
.header-search:focus-within {
  border-color: var(--line-strong);
  box-shadow: 0 0 0 2px rgba(129, 140, 248, 0.18);
}
.header-search svg { flex-shrink: 0; opacity: 0.5; width: 14px; height: 14px; }
.header-search .input {
  flex: 1; border: none; background: none; outline: none;
  font-size: 0.82rem; color: inherit; padding: 0; min-width: 0;
}
.header-search .search-count { font-size: 0.72rem; color: var(--muted); white-space: nowrap; }
.header-search .search-close {
  background: none; border: none; color: var(--muted);
  font-size: 1.1rem; cursor: pointer; padding: 0 2px; line-height: 1;
  transition: color 0.15s;
}
.header-search .search-close:hover { color: var(--text); }

.header-actions { display: flex; align-items: center; gap: 4px; }

.rename-btn {
  padding: 5px 10px; border-radius: 6px;
  font-size: 0.72rem; font-weight: 600; color: var(--muted);
  background: none; border: none; cursor: pointer;
  transition: background 150ms, color 150ms;
}
.rename-btn:hover { background: var(--surface); color: var(--text); }

.tab-bar {
  display: flex; gap: 2px; padding: 3px;
  border-radius: 8px; background: var(--surface);
}
.tab-bar button {
  padding: 5px 14px; border-radius: 6px;
  font-size: 0.78rem; font-weight: 600; color: var(--muted);
  background: none; border: none; cursor: pointer; transition: all 150ms;
}
.tab-bar button[aria-selected="true"] {
  background: var(--bg-0); color: var(--text);
}
.tab-bar button:hover:not([aria-selected="true"]) { color: var(--text); }

.presence {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 6px;
  font-size: 0.72rem; color: var(--muted); white-space: nowrap;
}
.presence::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--warning); transition: background 150ms;
}
.presence[data-state="live"]::before { background: var(--success); }
.presence[data-state="error"]::before { background: var(--danger); }

@media (max-width: 860px) {
  .chat-header {
    flex-wrap: wrap; align-items: flex-start; height: auto;
    padding: 12px 16px; row-gap: 10px;
  }
  .chat-title { flex: 1 1 220px; min-width: min(220px, 100%); }
  .header-actions {
    flex: 1 1 100%; flex-wrap: wrap;
    justify-content: space-between; gap: 8px;
  }
  .header-search.active { order: 3; flex: 1 1 100%; width: 100%; }
  .tab-bar { flex: 1 1 auto; min-width: 0; }
  .tab-bar button { flex: 1 1 0; text-align: center; }
  .presence { margin-left: auto; }
}

@media (max-width: 640px) {
  .chat-header { padding: 10px 12px; }
  .chat-title h2 { font-size: 0.86rem; }
  .chat-title p { font-size: 0.68rem; }
  .header-actions { gap: 6px; }
  .presence { padding: 4px 8px; font-size: 0.68rem; }
  .tab-bar { width: 100%; }
}
</style>
