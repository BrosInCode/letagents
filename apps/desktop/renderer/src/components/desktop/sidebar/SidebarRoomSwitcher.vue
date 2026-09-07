<template>
  <DesktopDialogShell
    :open="open"
    aria-label="Switch rooms"
    backdrop-class="sidebar-switcher-backdrop"
    panel-class="sidebar-switcher"
    :show-close="false"
    initial-focus="#sidebar-switcher-query"
    test-id="sidebar-room-switcher"
    @close="$emit('close')"
  >
    <div class="sidebar-switcher-search">
      <Search aria-hidden="true" />
      <input
        id="sidebar-switcher-query"
        v-model="query"
        type="search"
        placeholder="Switch to a room…"
        aria-label="Search all rooms"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="Boolean(options.length)"
        :aria-controls="options.length ? 'sidebar-switcher-results' : undefined"
        :aria-activedescendant="options.length ? resultId(activeIndex) : undefined"
        autocomplete="off"
        spellcheck="false"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="chooseActive"
      />
      <button type="button" aria-label="Close room switcher" @click="$emit('close')"><X aria-hidden="true" /></button>
    </div>
    <div class="sidebar-switcher-caption"><span>{{ query.trim() ? 'Matching rooms' : 'Your rooms' }}</span><span><Focus aria-hidden="true" />Zen Mode stays on</span></div>
    <div v-if="options.length" id="sidebar-switcher-results" class="sidebar-switcher-results" role="listbox" aria-label="Rooms">
      <div
        v-for="(option, index) in options"
        :id="resultId(index)"
        :key="option.entry.id"
        role="option"
        tabindex="-1"
        :aria-selected="index === activeIndex"
        class="sidebar-switcher-result"
        @pointerenter="activeIndex = index"
        @click="$emit('select', option.entry)"
      >
        <span class="sidebar-switcher-icon" aria-hidden="true"><GitBranch v-if="option.entry.kind === 'branch'" /><MessageSquare v-else-if="option.entry.kind === 'focus'" /><House v-else /></span>
        <span class="sidebar-switcher-copy"><strong>{{ option.title }}</strong><small>{{ option.detail }}</small></span>
        <span v-if="option.entry.id === activeEntryId || (option.entry.kind === 'parent' && option.projectId === activeProjectId)" class="sidebar-switcher-current">Current<Check aria-hidden="true" /></span>
        <ChevronRight v-else class="sidebar-switcher-arrow" aria-hidden="true" />
      </div>
    </div>
    <p v-else class="sidebar-switcher-empty" role="status">{{ query.trim() ? `No rooms match “${query.trim()}”.` : 'No rooms available.' }}</p>
    <footer class="sidebar-switcher-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></footer>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Check, ChevronRight, Focus, GitBranch, House, MessageSquare, Search, X } from '@lucide/vue';
import DesktopDialogShell from '../content/DesktopDialogShell.vue';
import type { ProjectGroup, RoomEntry } from '../types';
import { sidebarRoomSwitchOptions } from '../../../domain/sidebar-zen-mode';

const props = defineProps<{ open: boolean; projects: ProjectGroup[]; activeProjectId: string | null; activeEntryId: string }>();
const emit = defineEmits<{ close: []; select: [entry: RoomEntry] }>();
const query = ref('');
const activeIndex = ref(0);
const options = computed(() => sidebarRoomSwitchOptions(props.projects, query.value));
const resultId = (index: number) => `sidebar-switcher-result-${index}`;
watch(() => props.open, (open) => { if (open) { query.value = ''; activeIndex.value = 0; } });
watch(query, () => { activeIndex.value = 0; });
watch(options, (entries) => { activeIndex.value = Math.min(activeIndex.value, Math.max(0, entries.length - 1)); });
async function move(delta: number): Promise<void> {
  if (!options.value.length) return;
  activeIndex.value = (activeIndex.value + delta + options.value.length) % options.value.length;
  await nextTick();
  document.getElementById(resultId(activeIndex.value))?.scrollIntoView({ block: 'nearest' });
}
function chooseActive(): void {
  const option = options.value[activeIndex.value];
  if (option) emit('select', option.entry);
}
</script>

<style>
.sidebar-switcher-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: clamp(40px, 14vh, 145px) 20px 20px;
  background: var(--overlay-scrim);
  backdrop-filter: blur(5px);
}
.sidebar-switcher {
  display: flex;
  flex-direction: column;
  width: 490px;
  max-width: 100%;
  max-height: calc(100dvh - clamp(40px, 14vh, 145px) - 20px);
  overflow: hidden;
  outline: none;
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-xl);
}
.sidebar-switcher-search {
  display: flex;
  align-items: center;
  gap: 11px;
  flex-shrink: 0;
  padding: 18px;
  border-bottom: 1px solid var(--border);
  color: var(--text-tertiary);
}
.sidebar-switcher-search:focus-within {
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--blue) 40%, transparent);
}
.sidebar-switcher-search > svg {
  width: 19px;
  height: 19px;
  flex-shrink: 0;
}
.sidebar-switcher-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: 0.88rem var(--font-sans);
}
.sidebar-switcher-search input::placeholder { color: var(--text-tertiary); }
.sidebar-switcher-search button {
  display: grid;
  place-items: center;
  padding: 4px;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.sidebar-switcher-search button svg { width: 17px; height: 17px; }
.sidebar-switcher-caption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 16px 19px 9px;
  color: var(--text-tertiary);
  font-size: 0.65rem;
}
.sidebar-switcher-caption > span:last-child,
.sidebar-switcher-current {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.sidebar-switcher-caption svg { width: 12px; height: 12px; }
.sidebar-switcher-results { min-height: 0; overflow: auto; padding: 0 8px 9px; }
.sidebar-switcher-result {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 13px 11px;
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.sidebar-switcher-result[aria-selected="true"] { background: var(--accent-hover); }
.sidebar-switcher-icon {
  display: grid;
  place-items: center;
  flex: 0 0 35px;
  height: 35px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--accent-dim);
  color: var(--text-secondary);
}
.sidebar-switcher-icon svg { width: 19px; height: 19px; }
.sidebar-switcher-copy { flex: 1; min-width: 0; }
.sidebar-switcher-copy strong,
.sidebar-switcher-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-switcher-copy strong { font-size: 0.82rem; font-weight: 600; }
.sidebar-switcher-copy small { margin-top: 5px; color: var(--text-tertiary); font-size: 0.65rem; }
.sidebar-switcher-current { flex-shrink: 0; color: var(--text-tertiary); font-size: 0.65rem; }
.sidebar-switcher-current svg,
.sidebar-switcher-arrow { width: 14px; height: 14px; flex-shrink: 0; color: var(--text-tertiary); }
.sidebar-switcher-footer {
  display: flex;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  color: var(--text-tertiary);
  font-size: 0.65rem;
}
.sidebar-switcher-footer > span { display: inline-flex; align-items: center; gap: 5px; }
.sidebar-switcher-footer kbd {
  min-width: 17px;
  padding: 1px 3px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  color: var(--text-secondary);
  font: inherit;
  text-align: center;
}
.sidebar-switcher-empty { margin: 0; padding: 40px 20px; color: var(--text-tertiary); font-size: 0.82rem; text-align: center; }
.sidebar-switcher button:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
@media (prefers-reduced-transparency: reduce) {
  .sidebar-switcher-backdrop { backdrop-filter: none; }
}
</style>
