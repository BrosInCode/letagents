<template>
  <header class="chat-header">
    <div class="header-main">
      <div class="chat-title">
        <div class="chat-title-heading">
          <span class="room-mark" aria-hidden="true">#</span>
          <h2 :title="title">{{ title }}</h2>
          <button v-if="canRename" class="title-rename-btn" @click="$emit('rename')" type="button" aria-label="Rename room" title="Rename room">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          </button>
        </div>
        <p v-if="gitRoom" class="header-repository" :title="repositoryTitle">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 13H3V3h5l2 2h3v3M9 9v4m0-2h3m0 0V9m0 2v2" /></svg>
          <span>{{ gitRoom.repository.full_name }}</span>
          <span v-if="!gitRoom.ref.is_default" class="repository-ref">· {{ gitRoomRefLabel(gitRoom) }}</span>
        </p>
        <p v-else :title="subtitle">{{ subtitle }}</p>
      </div>
      <span v-if="connectionState !== 'live'" class="presence" :data-state="connectionState" role="status">{{ presenceLabel }}</span>
    </div>

    <div class="header-navigation">
      <nav ref="tabsElement" class="tab-bar" aria-label="Room navigation">
        <button
          v-for="tab in visibleTabs"
          :key="tab.id"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          @click="prepareTabChange($event, tab.id); $emit('update:activeTab', tab.id)"
          type="button"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path :d="tab.icon" /></svg>
          <span>{{ tab.label }}</span>
        </button>
        <span ref="indicatorElement" class="tab-underline" style="visibility: hidden" aria-hidden="true" />
      </nav>
      <div class="header-actions">
        <button ref="searchToggleEl" class="action-btn find-button" @click="toggleSearch" type="button" aria-label="Find in room" aria-keyshortcuts="Meta+f Control+f" :aria-expanded="searchActive && canSearch" :disabled="!canSearch" :title="canSearch ? 'Find in room' : 'Open Chat to find messages'">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" /></svg>
          <span>Find</span><kbd aria-hidden="true">{{ findShortcut }}</kbd>
        </button>
        <span class="tool-divider" aria-hidden="true" />
        <button class="action-btn" @click="$emit('toggleDrawer')" type="button" aria-label="Room settings" title="Room settings">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12M5 2.5v3M11 6.5v3M6 10.5v3" /></svg>
        </button>
      </div>
    </div>

    <div v-show="searchActive && canSearch" class="header-search" @keydown.escape.stop.prevent="closeSearch">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" /></svg>
      <input ref="searchInputEl" type="text" class="input" placeholder="Search messages…" aria-label="Search messages" autocomplete="off" :value="searchQuery" @input="$emit('update:searchQuery', ($event.target as HTMLInputElement).value)" />
      <span v-if="searchQuery" class="search-count">{{ matchCount }} match{{ matchCount !== 1 ? 'es' : '' }}</span>
      <button class="search-close" @click="closeSearch" type="button" aria-label="Close search">&times;</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { GitRoomInfo } from '@/composables/useRoom'
import { gitRoomRefLabel, gitRoomAccessLabel } from './gitRoomLabels'
import { useSlidingTabIndicator } from '../../../../../shared/ui/useSlidingTabIndicator'

type RoomTab = 'chat' | 'events' | 'board' | 'activity' | 'rooms'
const BASE_TABS: ReadonlyArray<{ id: RoomTab; label: string; icon: string; requiresEvents?: boolean }> = [
  { id: 'chat', label: 'Chat', icon: 'M3 3h10v7H7l-4 3V3Z' },
  { id: 'events', label: 'Events', icon: 'M5 5v8m6-2V7a3 3 0 0 0-3-3M3 3a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm6 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z', requiresEvents: true },
  { id: 'board', label: 'Board', icon: 'M3 2.5h10v11H3zM6.5 2.5v11M10 2.5v11' },
  { id: 'activity', label: 'Activity', icon: 'M2 8h3l1.5-5 3 10L11 8h3' },
  { id: 'rooms', label: 'Rooms', icon: 'M2.5 2.5h11v11h-11zM2.5 6h11M7 6v7.5' },
]

const props = defineProps<{
  title: string
  subtitle: string
  activeTab: RoomTab
  connectionState: 'idle' | 'connecting' | 'live' | 'error'
  searchQuery: string
  matchCount: number
  canRename?: boolean
  showEventsTab?: boolean
  gitRoom?: GitRoomInfo | null
}>()

defineEmits<{
  toggleDrawer: []
  'update:activeTab': [tab: RoomTab]
  'update:searchQuery': [query: string]
  rename: []
}>()

const searchActive = ref(false)
const searchInputEl = ref<HTMLInputElement | null>(null)
const searchToggleEl = ref<HTMLButtonElement | null>(null)
const findShortcut = ref('Ctrl F')
const canSearch = computed(() => props.activeTab === 'chat')
const visibleTabs = computed(() => BASE_TABS.filter(tab => !tab.requiresEvents || props.showEventsTab))
const { tabsElement, indicatorElement, prepareTabChange } = useSlidingTabIndicator(() => props.activeTab)
const repositoryTitle = computed(() => props.gitRoom ? `${props.gitRoom.repository.full_name} · ${gitRoomRefLabel(props.gitRoom)} · ${gitRoomAccessLabel(props.gitRoom)}` : '')
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
  if (searchActive.value) closeSearch()
  else openSearch()
}
function openSearch(): boolean {
  if (!canSearch.value) return false
  searchActive.value = true
  void nextTick(() => searchInputEl.value?.focus())
  return true
}
defineExpose({ openSearch })
function closeSearch() {
  searchActive.value = false
  searchToggleEl.value?.focus()
}
function handleFindShortcut(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return
  if (openSearch()) event.preventDefault()
}
onMounted(() => {
  findShortcut.value = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ F' : 'Ctrl F'
  window.addEventListener('keydown', handleFindShortcut)
})
onBeforeUnmount(() => window.removeEventListener('keydown', handleFindShortcut))
</script>

<style scoped>
.chat-header { position: relative; z-index: 20; display: flex; flex-direction: column; gap: 14px; min-width: 0; padding: 20px 24px 0; border-bottom: 1px solid var(--line, #27272a); background: var(--surface, #18181b); }
.chat-header svg { width: 17px; height: 17px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.header-main, .header-navigation { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-width: 0; }
.chat-title { flex: 1; min-width: 0; }
.chat-title-heading { display: flex; align-items: center; gap: 12px; min-width: 0; }
.room-mark { font-size: 1.3rem; font-weight: 450; color: var(--muted, #a1a1aa); }
.chat-title h2 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 1.4rem; line-height: 1.2; font-weight: 700; letter-spacing: -0.035em; }
.chat-title p { margin: 6px 0 0; font-size: 0.78rem; line-height: 1.4; color: var(--muted, #a1a1aa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header-repository { display: flex; align-items: center; gap: 8px; }
.header-repository span { overflow: hidden; text-overflow: ellipsis; }
.header-repository .repository-ref { flex-shrink: 1; }
.header-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.action-btn, .title-rename-btn, .search-close { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; min-width: 36px; padding: 0 7px; background: transparent; border: 0; border-radius: 6px; color: var(--muted, #a1a1aa); font: inherit; font-size: 0.8rem; cursor: pointer; transition: color 140ms ease, background 140ms ease; }
.title-rename-btn { min-width: 28px; min-height: 28px; }
.title-rename-btn svg { width: 13px; height: 13px; }
.action-btn[aria-expanded="true"] { background: var(--bg-0, #09090b); color: var(--text, #fafafa); }
.action-btn:disabled { opacity: .45; cursor: default; }
.find-button kbd { padding: 1px 5px; margin-left: 6px; border: 1px solid var(--line, #27272a); border-radius: 4px; font: inherit; font-size: 0.68rem; }
.tool-divider { width: 1px; height: 16px; margin: 0 4px; background: var(--line, #27272a); }
.tab-bar { position: relative; display: flex; align-items: center; gap: 24px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tab-bar::-webkit-scrollbar { display: none; }
.tab-bar button { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0; min-height: 44px; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--muted, #a1a1aa); font: inherit; font-size: 0.82rem; font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 140ms ease; }
.tab-bar button[aria-current="page"] { color: var(--text, #fafafa); }
.tab-underline { position: absolute; top: 0; left: 0; height: 2px; border-radius: 2px; background: var(--text, #fafafa); transform-origin: left center; pointer-events: none; }
.chat-header button:focus-visible { outline: 2px solid var(--text, #fafafa); outline-offset: -2px; border-radius: 4px; }
.header-search { position: absolute; top: calc(100% + 8px); right: 24px; display: flex; align-items: center; gap: 8px; width: min(420px, calc(100% - 32px)); min-height: 44px; box-sizing: border-box; padding: 4px 6px 4px 12px; border: 1px solid var(--line, #27272a); border-radius: 10px; background: var(--surface, #18181b); box-shadow: 0 10px 30px #0003; }
.header-search .input { flex: 1; min-width: 0; width: 100%; padding: 0; background: transparent; border: 0; outline: none; font: inherit; font-size: 0.82rem; color: var(--text, #fafafa); }
.header-search:focus-within { border-color: var(--muted, #a1a1aa); }
.header-search svg, .search-count { color: var(--muted, #a1a1aa); }
.search-count { font-size: 0.72rem; white-space: nowrap; }
.search-close { font-size: 1.25rem; }
.presence { color: var(--muted, #a1a1aa); font-size: 0.72rem; white-space: nowrap; }
.presence[data-state="error"] { color: var(--danger, #f87171); }
@media (hover: hover) and (pointer: fine) {
  .tab-bar button:hover { color: var(--text, #fafafa); }
  .action-btn:hover:not(:disabled), .title-rename-btn:hover, .search-close:hover { background: var(--bg-0, #09090b); color: var(--text, #fafafa); }
}
@media (max-width: 980px) {
  .chat-header { flex-direction: row; align-items: center; gap: 8px; padding: 8px 12px; }
  .header-main { flex: 1; min-width: 0; gap: 6px; }
  .chat-title h2 { font-size: 1.05rem; }
  .chat-title-heading { gap: 8px; }
  .chat-title p { font-size: 0.7rem; }
  .tab-bar, .find-button kbd, .presence { display: none; }
  .action-btn, .title-rename-btn, .search-close { min-width: 44px; min-height: 44px; }
  .title-rename-btn { min-width: 28px; padding: 0; }
  .header-search { right: 12px; }
  .header-search .input { font-size: 16px; }
  .header-repository .repository-ref { display: none; }
}
@media (pointer: coarse) {
  .action-btn, .title-rename-btn, .search-close { min-width: 44px; min-height: 44px; }
  .header-search .input { font-size: 16px; }
}
</style>
