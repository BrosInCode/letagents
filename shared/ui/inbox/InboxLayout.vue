<template>
  <section ref="root" class="inbox-layout" :aria-labelledby="`${id}-title`">
    <header class="inbox-page-header">
      <h1 :id="`${id}-title`" ref="heading" tabindex="-1">Inbox</h1>
      <div class="inbox-header-actions"><slot name="header-actions" /><button type="button" class="inbox-icon-button" :disabled="loading" aria-label="Refresh" title="Refresh inbox" @click="emit('refresh')"><svg viewBox="0 0 24 24" aria-hidden="true" :class="{ 'inbox-spinning': loading }"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg></button></div>
    </header>
    <slot name="reminders" />
    <div class="inbox-tabs" role="tablist" aria-label="Inbox view">
      <button v-for="tab in sections" :id="`${id}-${tab.id}`" :key="tab.id" type="button" role="tab" :aria-selected="section === tab.id" :aria-controls="`${id}-panel`" :tabindex="section === tab.id ? 0 : -1" @click="changeSection(tab.id)" @keydown="tabKeydown($event, tab.id)">{{ tab.label }}<span v-if="tab.id !== 'answered' && (tab.id !== 'updates' || updatesLoaded)">{{ counts[tab.id] }}</span></button>
    </div>
    <div class="inbox-toolbar">
      <details ref="roomMenu" class="inbox-room-picker" @toggle="roomMenuToggled" @keydown.esc.stop.prevent="closeRoomMenu">
        <summary class="inbox-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 3h9v11H3Z" /></svg><span>{{ roomLabel }}</span><svg class="inbox-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></summary>
        <div class="inbox-room-menu">
          <label class="inbox-menu-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref="roomSearch" v-model="roomQuery" type="search" placeholder="Find a room" aria-label="Find a room" autocomplete="off" /></label>
          <div class="inbox-room-options-list" @keydown="roomKeydown">
            <button type="button" class="inbox-room-option" :aria-pressed="!selectedRooms.length" @click="emit('update:rooms', [])"><span>All rooms</span><svg v-if="!selectedRooms.length" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></button>
            <button v-for="room in matchingRooms" :key="room.id" type="button" class="inbox-room-option" :aria-pressed="selectedRooms.includes(room.id)" @click="toggleRoom(room.id)"><span>{{ room.label }}</span><svg v-if="selectedRooms.includes(room.id)" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg></button>
            <p v-if="!matchingRooms.length" class="inbox-menu-empty">No rooms found.</p>
          </div>
          <div class="inbox-menu-footer"><span>{{ selectedRooms.length ? `${selectedRooms.length} selected` : 'Across all rooms' }}</span><button type="button" class="inbox-text-button" @click="closeRoomMenu">Done</button></div>
        </div>
      </details>
      <label class="inbox-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg><input ref="search" :value="query" type="search" placeholder="Search inbox…" aria-label="Search inbox" @input="updateQuery" @keydown.esc.stop="emit('update:query', '')" /><kbd aria-hidden="true">/</kbd></label>
    </div>
    <div v-if="$slots.notices" class="inbox-notices"><slot name="notices" /></div>
    <div :id="`${id}-panel`" class="inbox-panel" role="tabpanel" :aria-labelledby="`${id}-${section}`">
      <div v-if="items.length || selectedKey" class="inbox-workspace" :class="{ 'inbox-show-detail': mobileDetail }">
        <div class="inbox-queue-pane">
          <nav ref="queue" class="inbox-queue" aria-label="Inbox items" @keydown="queueKeydown">
            <button v-for="item in items" :key="item.key" type="button" class="inbox-queue-row" :data-inbox-key="item.key" :data-selected="selectedKey === item.key" :aria-current="selectedKey === item.key ? 'true' : undefined" @click="selectItem(item.key)">
              <span class="inbox-queue-avatar"><slot name="item-avatar" :item="item"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v12H9l-5 4Z" /><path d="M8 9h8m-8 4h5" /></svg></slot></span>
              <span class="inbox-queue-copy"><strong>{{ item.title }}</strong><span>{{ item.actor }}<span v-if="item.actor && item.roomName" aria-hidden="true"> · </span>{{ item.roomName }}</span></span>
            </button>
            <p v-if="!items.length" class="inbox-queue-empty">Nothing else waiting here.</p>
          </nav>
          <div v-if="$slots['queue-footer']" class="inbox-queue-footer"><slot name="queue-footer" /></div>
        </div>
        <div ref="detail" class="inbox-detail-pane">
          <button type="button" class="inbox-mobile-back inbox-text-button" @click="backToQueue"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>Inbox</button>
          <slot name="detail" />
        </div>
      </div>
      <slot v-else name="empty"><div class="inbox-empty"><h2>{{ loading ? 'Checking your rooms' : 'Nothing here yet' }}</h2><p>{{ query ? 'Try another name, room, or phrase.' : 'Requests and updates will appear here.' }}</p></div></slot>
    </div>
    <slot name="footer" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { InboxQueueItem, InboxRoomOption, InboxSection } from './types';
import './inbox.css';

const props = withDefaults(defineProps<{
  section: InboxSection; counts: Record<InboxSection, number>; updatesLoaded?: boolean; loading?: boolean;
  items: InboxQueueItem[]; selectedKey?: string; rooms: InboxRoomOption[]; selectedRooms: string[]; query: string;
}>(), { updatesLoaded: true, loading: false, selectedKey: '' });
const emit = defineEmits<{
  'update:section': [section: InboxSection]; 'update:rooms': [rooms: string[]]; 'update:query': [query: string]; select: [key: string]; refresh: [];
}>();
const id = `inbox-${useId()}`;
const sections: { id: InboxSection; label: string }[] = [{ id: 'needs-you', label: 'Needs you' }, { id: 'updates', label: 'Updates' }, { id: 'answered', label: 'Answered' }];
const root = ref<HTMLElement>(), heading = ref<HTMLElement>(), queue = ref<HTMLElement>(), detail = ref<HTMLElement>();
const search = ref<HTMLInputElement>(), roomSearch = ref<HTMLInputElement>(), roomMenu = ref<HTMLDetailsElement>();
const roomQuery = ref(''), mobileDetail = ref(false);
const roomLabel = computed(() => !props.selectedRooms.length ? 'All rooms' : props.selectedRooms.length > 1 ? `${props.selectedRooms.length} rooms` : props.rooms.find(room => room.id === props.selectedRooms[0])?.label || 'Selected room');
const matchingRooms = computed(() => props.rooms.filter(room => room.label.toLocaleLowerCase().includes(roomQuery.value.trim().toLocaleLowerCase())));
function focusHeading() { heading.value?.focus({ preventScroll: true }); }
defineExpose({ focusHeading });
function changeSection(section: InboxSection) { mobileDetail.value = false; emit('update:section', section); }
function updateQuery(event: Event) { emit('update:query', (event.target as HTMLInputElement).value); }
function toggleRoom(id: string) { emit('update:rooms', props.selectedRooms.includes(id) ? props.selectedRooms.filter(room => room !== id) : [...props.selectedRooms, id]); }
watch([() => props.section, () => props.selectedRooms], () => { mobileDetail.value = false; });
watch(() => props.selectedKey, async (key, previous) => {
  if (key === previous) return;
  await nextTick();
  if (detail.value) detail.value.scrollTop = 0;
});
async function selectItem(key: string) {
  emit('select', key); mobileDetail.value = true; await nextTick();
  if (root.value && root.value.clientWidth <= 700) detail.value?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}
async function backToQueue() {
  mobileDetail.value = false; await nextTick();
  queue.value?.querySelector<HTMLElement>('[aria-current="true"]')?.focus({ preventScroll: true });
}
async function tabKeydown(event: KeyboardEvent, current: InboxSection) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = sections.findIndex(tab => tab.id === current);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : sections.length - 1)) % sections.length;
  changeSection(sections[next]!.id); await nextTick();
  root.value?.querySelector<HTMLElement>(`[role="tab"][aria-selected="true"]`)?.focus();
}
function queueKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = Array.from(queue.value?.querySelectorAll<HTMLButtonElement>('.inbox-queue-row') || []);
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
  // Keyboard browsing keeps focus in the queue; Enter opens the item on narrow screens.
  next?.focus(); if (next?.dataset.inboxKey) emit('select', next.dataset.inboxKey);
}
function roomKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const buttons = Array.from(roomMenu.value?.querySelectorAll<HTMLButtonElement>('.inbox-room-option') || []);
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
}
function closeRoomMenu() {
  if (roomMenu.value) { roomMenu.value.open = false; roomMenu.value.querySelector('summary')?.focus(); }
}
function roomMenuToggled() { if (roomMenu.value?.open) void nextTick(() => roomSearch.value?.focus()); else roomQuery.value = ''; }
function outsideRoomMenu(event: PointerEvent) { if (roomMenu.value?.open && event.target instanceof Node && !roomMenu.value.contains(event.target)) roomMenu.value.open = false; }
function searchShortcut(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || target?.closest?.('input,textarea,select,[contenteditable="true"],[role="dialog"],dialog')) return;
  event.preventDefault(); search.value?.focus();
}
onMounted(() => { document.addEventListener('pointerdown', outsideRoomMenu); document.addEventListener('keydown', searchShortcut); });
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outsideRoomMenu); document.removeEventListener('keydown', searchShortcut); });
</script>
