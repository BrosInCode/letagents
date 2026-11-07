<template>
  <header class="chat-header">
    <div class="room-toolbar">
      <div class="room-identity" :title="repositoryTitle || subtitle">
        <h2 :title="title">{{ title }}</h2>
        <span v-if="gitRoom && !gitRoom.ref.is_default" class="repository-ref">{{ gitRoomRefLabel(gitRoom) }}</span>
        <button v-if="canRename" class="title-rename-btn" @click="$emit('rename')" type="button" aria-label="Rename room" title="Rename room">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
        </button>
      </div>
      <nav ref="tabsElement" class="room-view-tabs" aria-label="Room navigation">
        <button
          v-for="tab in visibleTabs"
          :key="tab.id"
          class="room-view-tab"
          :aria-label="tabLabel(tab)"
          :title="tab.label"
          :aria-current="activeTab === tab.id ? 'page' : undefined"
          @click="prepareTabChange($event, tab.id); $emit('update:activeTab', tab.id)"
          type="button"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path :d="tab.icon" /></svg>
          <span class="room-view-label" aria-hidden="true"><span>{{ tab.label }}</span></span>
          <RoomViewCount v-if="tab.id === 'events'" :count="activityUnreadCount || 0" notification />
          <RoomViewCount v-if="tab.id === 'rooms'" :count="roomCount || 0" />
        </button>
        <span ref="indicatorElement" class="room-view-underline" style="visibility: hidden" aria-hidden="true" />
      </nav>
      <div class="header-actions">
        <span v-if="connectionState !== 'live'" class="presence" :data-state="accessLocked || waitingForGitHub ? 'idle' : connectionState" role="status">{{ presenceLabel }}</span>
        <RoomAttentionButton v-if="needsYouCount" :count="needsYouCount" :pulse="attentionPulse" :aria-label="`Open Inbox for ${title}, ${needsYouCount} ${needsYouCount === 1 ? 'request needs' : 'requests need'} you`" @click="$emit('openInbox')" />
        <button ref="searchToggleEl" class="action-btn find-button" @click="toggleSearch" type="button" aria-label="Find in room" aria-keyshortcuts="Meta+f Control+f" :aria-expanded="searchActive && canSearch" :disabled="!canSearch" :title="canSearch ? `Find in room (${findShortcut})` : 'Open Chat to find messages'">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m11 11 3 3M7 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Z" /></svg>
        </button>
        <button class="action-btn" @click="$emit('toggleDrawer')" type="button" aria-label="Room settings" title="Room settings">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="13" cy="8" r=".8"/></svg>
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
import RoomViewCount from '../../../../../shared/ui/RoomViewCount.vue'
import RoomAttentionButton from '../../../../../shared/ui/RoomAttentionButton.vue'
import '../../../../../shared/ui/room-navigation.css'

type RoomTab = 'chat' | 'events' | 'board' | 'activity' | 'rooms'
const BASE_TABS: ReadonlyArray<{ id: RoomTab; label: string; icon: string; requiresEvents?: boolean }> = [
  { id: 'chat', label: 'Chat', icon: 'M3 3h10v7H7l-4 3V3Z' },
  { id: 'events', label: 'Activity', icon: 'M5 5v8m6-2V7a3 3 0 0 0-3-3M3 3a2 2 0 1 0 4 0 2 2 0 0 0-4 0Zm6 10a2 2 0 1 0 4 0 2 2 0 0 0-4 0Z', requiresEvents: true },
  { id: 'board', label: 'Board', icon: 'M3 2.5h10v11H3zM6.5 2.5v11M10 2.5v11' },
  { id: 'activity', label: 'Agents', icon: 'M10 13v-1.5A2.5 2.5 0 0 0 7.5 9h-3A2.5 2.5 0 0 0 2 11.5V13M8 4.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm3-2a2 2 0 0 1 0 4M14 13v-1.5A2.5 2.5 0 0 0 12 9' },
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
  activityUnreadCount?: number
  roomCount?: number
  needsYouCount?: number
  attentionPulse?: boolean
  /** Signed in but not let in: there is nothing to reconnect to. */
  accessLocked?: boolean
  /** GitHub did not answer the role check; the page retries on its own. */
  waitingForGitHub?: boolean
}>()

defineEmits<{
  toggleDrawer: []
  openInbox: []
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
function tabLabel(tab: typeof BASE_TABS[number]): string {
  if (tab.id === 'events' && props.activityUnreadCount) return `Activity, ${props.activityUnreadCount} unread`
  if (tab.id === 'rooms' && props.roomCount) return `Rooms, ${props.roomCount}`
  return tab.label
}
const repositoryTitle = computed(() => props.gitRoom ? `${props.gitRoom.repository.full_name} · ${gitRoomRefLabel(props.gitRoom)} · ${gitRoomAccessLabel(props.gitRoom)}` : '')
const presenceLabel = computed(() => {
  if (props.accessLocked && props.connectionState === 'error') return 'No access'
  if (props.waitingForGitHub && props.connectionState === 'error') return 'Waiting for GitHub'
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
.chat-header { position: relative; z-index: 20; min-width: 0; border-bottom: 1px solid var(--line, #27272a); background: var(--bg-0, #09090b); }
.room-toolbar { display: flex; align-items: center; gap: 12px; min-width: 0; height: 52px; padding: env(safe-area-inset-top, 0px) max(16px, env(safe-area-inset-right, 0px)) 0 max(20px, env(safe-area-inset-left, 0px)); }
.chat-header svg { width: 18px; height: 18px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.room-identity { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 210px; flex: 0 1 auto; }
.room-identity h2 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 1.4; font-weight: 600; letter-spacing: -.015em; }
.repository-ref { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px; color: var(--muted, #a1a1aa); font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 3px; flex-shrink: 0; margin-left: auto; }
.action-btn, .title-rename-btn, .search-close { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; min-height: 36px; min-width: 36px; padding: 0 7px; background: transparent; border: 0; border-radius: 6px; color: var(--muted, #a1a1aa); font: inherit; font-size: 0.8rem; cursor: pointer; transition: color 140ms ease, background 140ms ease; }
.title-rename-btn { min-width: 28px; min-height: 28px; }
.title-rename-btn svg { width: 13px; height: 13px; }
.action-btn[aria-expanded="true"] { background: var(--accent-hover); color: var(--text, #fafafa); }
.action-btn:disabled { opacity: .45; cursor: default; }
.chat-header button:focus-visible { outline: 2px solid var(--text, #fafafa); outline-offset: -2px; border-radius: 4px; }
.header-search { position: absolute; top: calc(100% + 8px); right: 16px; display: flex; align-items: center; gap: 8px; width: min(420px, calc(100% - 32px)); min-height: 44px; box-sizing: border-box; padding: 4px 6px 4px 12px; border: 1px solid var(--line, #27272a); border-radius: 10px; background: var(--surface, #18181b); box-shadow: 0 10px 30px #0003; }
.header-search .input { flex: 1; min-width: 0; width: 100%; padding: 0; background: transparent; border: 0; outline: none; font: inherit; font-size: 0.82rem; color: var(--text, #fafafa); }
.header-search:focus-within { border-color: var(--muted, #a1a1aa); }
.header-search svg, .search-count { color: var(--muted, #a1a1aa); }
.search-count { font-size: 0.72rem; white-space: nowrap; }
.search-close { font-size: 1.25rem; }
.presence { color: var(--muted, #a1a1aa); font-size: 0.72rem; white-space: nowrap; }
.presence[data-state="error"] { color: var(--danger, #f87171); }
@media (hover: hover) and (pointer: fine) {
  .action-btn:hover:not(:disabled), .title-rename-btn:hover, .search-close:hover { background: var(--accent-hover); color: var(--text, #fafafa); }
}
@media (max-width: 980px) {
  .room-toolbar { gap: 8px; height: 52px; padding-right: max(12px, env(safe-area-inset-right, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); }
  .room-identity { flex: 1; max-width: none; }
  .room-view-tabs, .presence { display: none; }
  .action-btn, .title-rename-btn, .search-close { min-width: 44px; min-height: 44px; }
  .title-rename-btn { padding: 0; }
  .header-search { right: 12px; }
  .header-search .input { font-size: 16px; }
  .repository-ref { display: none; }
}
@media (pointer: coarse) {
  .action-btn, .title-rename-btn, .search-close { min-width: 44px; min-height: 44px; }
  .header-search .input { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) { .action-btn, .title-rename-btn, .search-close { transition: none; } }
</style>
