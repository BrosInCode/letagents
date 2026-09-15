<template>
  <section class="knowledge-page needs-you-page" aria-labelledby="inbox-title" data-testid="inbox-view" :data-motion="motionEnabled" @pointerdown.capture="motionEnabled = true" @keydown.capture="motionEnabled = false">
    <header class="knowledge-header">
      <div><h1 id="inbox-title" ref="pageHeading" tabindex="-1">{{ sectionTitle }}<span class="knowledge-total">{{ items.length }}</span></h1><p>{{ sectionDescription }}</p></div>
      <button class="knowledge-button" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="14" :class="{ 'knowledge-spin': loading }" />Refresh</button>
    </header>
    <div class="knowledge-filters">
      <div class="knowledge-segments" aria-label="Inbox view">
        <button v-for="tab in sections" :key="tab.id" :aria-pressed="section === tab.id" @click="emit('update:section', tab.id)">{{ tab.label }}<span v-if="tab.id !== 'answered'">{{ count(tab.id) }}</span></button>
      </div>
      <details ref="roomMenu" class="inbox-room-filter" @keydown.esc.stop="closeRoomMenu">
        <summary class="knowledge-button"><SlidersHorizontal :size="14" />{{ roomFilterLabel }}<ChevronDown :size="13" /></summary>
        <div class="inbox-room-options">
          <button class="knowledge-text-button" @click="emit('update:rooms', [])">All rooms</button>
          <label v-for="room in sortedRooms" :key="room.roomIdentifier"><input type="checkbox" :checked="rooms.includes(room.roomIdentifier)" @change="toggleRoom(room.roomIdentifier)" />{{ room.displayName }}</label>
        </div>
      </details>
    </div>

    <p v-if="sendError" class="knowledge-notice" role="alert">{{ sendError }}</p>
    <p v-if="error" class="knowledge-notice" role="alert">{{ error }} <button @click="emit('refresh')">Try again</button></p>
    <details v-if="sourceNotices.length" class="inbox-source-notice">
      <summary><TriangleAlert :size="15" aria-hidden="true" /><span>{{ hasSourceFailure ? 'Some sources need checking' : 'About this view' }}<span>{{ hasSourceFailure ? 'Your available requests and updates are shown below.' : 'Room access and history limits.' }}</span></span><ChevronDown :size="14" aria-hidden="true" /></summary>
      <ul><li v-for="message in sourceNotices" :key="message">{{ message }}</li></ul><button class="knowledge-button" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="14" aria-hidden="true" />{{ hasSourceFailure ? 'Retry sources' : 'Refresh' }}</button>
    </details>
    <div v-if="lastDismissed" class="inbox-undo" role="status"><span>Dismissed “{{ lastDismissed.title }}”</span><button class="knowledge-text-button" @click="undoDismiss">Undo</button></div>
    <div v-if="loading && !data" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" /><h2>Checking your rooms</h2><p>Gathering requests and updates.</p></div>
    <div v-else-if="!items.length" class="knowledge-empty"><span class="knowledge-empty-mark"><CircleCheck :size="26" aria-hidden="true" /></span><h2>{{ emptyTitle }}</h2><p>{{ section === 'answered' ? 'Answered requests will appear here.' : section === 'updates' ? 'Room updates will appear here as work progresses.' : 'Questions, decisions and approvals will appear when someone asks for your input.' }}</p><button v-if="rooms.length" class="knowledge-button inbox-empty-action" @click="emit('update:rooms', [])">Show all rooms</button></div>
    <div v-else class="knowledge-workspace">
      <nav class="knowledge-queue" aria-label="Inbox items">
        <TransitionGroup name="knowledge-list">
          <button v-for="item in items" :key="item.key" class="knowledge-queue-item" :data-selected="selected?.key === item.key" :aria-current="selected?.key === item.key ? 'true' : undefined" @click="selectItem(item)">
            <span class="knowledge-queue-top"><span class="knowledge-category" :data-kind="item.category">{{ inboxCategoryLabel(item.category) }}</span><time :datetime="item.timestamp" :title="date(item.timestamp)">{{ relative(item.timestamp) }}</time></span>
            <strong>{{ item.title }}</strong><span class="knowledge-queue-preview">{{ item.body }}</span><span class="knowledge-room-name"><span class="knowledge-room-dot"></span>{{ item.roomName }}<ChevronRight :size="13" /></span>
          </button>
        </TransitionGroup>
      </nav>
      <article v-if="selected" :key="selected.key" class="knowledge-detail knowledge-enter" aria-labelledby="request-title">
        <div class="knowledge-detail-context">
        <div class="knowledge-detail-top"><span class="knowledge-category" :data-kind="selected.category">{{ inboxCategoryLabel(selected.category) }}</span><button v-if="selected.roomIdentifier" class="knowledge-text-button" @click="openRoom(selected, 'room')">Open room <ArrowUpRight :size="14" /></button></div>
        <h2 id="request-title" ref="requestHeading" tabindex="-1">{{ selected.title }}</h2>
        <p class="knowledge-byline"><span>{{ selected.actor }}</span><span>{{ selected.roomName }}</span><time :datetime="selected.timestamp" :title="date(selected.timestamp)">{{ relative(selected.timestamp) === 'Just now' ? 'Just now' : `${relative(selected.timestamp)} ago` }}</time></p>
        <div class="knowledge-prose">{{ selected.body || 'Open the original work for more context.' }}</div>
        <div v-if="selected.record?.recommendation" class="knowledge-recommendation"><span><Lightbulb :size="15" aria-hidden="true" />Suggested approach</span><p>{{ selected.record.recommendation }}</p></div>
        <div v-if="selected.record?.unblocks" class="knowledge-unblocks"><ArrowRight :size="15" /><p><strong>Your answer unblocks</strong>{{ selected.record.unblocks }}</p></div>
        <div v-if="selected.record?.source_url || selected.record?.source_message_id" class="knowledge-source-row"><button v-if="selected.record.source_url" class="knowledge-button" @click="openSource(selected.record.source_url)"><Link2 :size="14" />View source</button><button v-if="selected.record.source_message_id" class="knowledge-button" @click="openRoom(selected, 'source')"><MessageSquare :size="14" />Original message</button></div>
        </div>
        <div v-if="selected.record?.response" class="knowledge-answer" role="status"><span><CircleCheck :size="16" /> Answer recorded</span><p>{{ selected.record.response.body }}</p><small>{{ selected.record.response.actor.label }} · {{ date(selected.record.response.at) }}</small></div>
        <form v-else-if="selected.record" class="knowledge-response" @submit.prevent="respond">
          <label :for="`response-${selected.record.id}`">Your response</label><textarea :id="`response-${selected.record.id}`" v-model="drafts[selected.key]" rows="4" maxlength="8000" placeholder="Give the agent a clear decision or next step…" :disabled="sending" required></textarea>
          <div class="knowledge-response-footer"><small>Sent to the room and saved with this request.</small><button class="knowledge-button knowledge-primary" :disabled="sending || !drafts[selected.key]?.trim()"><LoaderCircle v-if="sending" :size="14" class="knowledge-spin" /><Send v-else :size="14" />{{ sending ? 'Sending…' : 'Send response' }}</button></div>
        </form>
        <div v-else class="knowledge-task-action">
          <div class="knowledge-source-row"><button class="knowledge-button knowledge-primary" @click="openRoom(selected)">{{ actionLabel(selected) }}<ArrowUpRight :size="14" /></button><button v-if="selected.section === 'updates'" class="knowledge-button" @click="dismiss(selected)"><Check :size="14" />Dismiss update</button></div>
          <ol v-if="selected.activity?.activity.length" class="inbox-activity"><li v-for="event in selected.activity.activity" :key="event.id"><strong>{{ event.label }}</strong><p v-if="event.description">{{ event.description }}</p><time v-if="event.timestamp" :datetime="event.timestamp">{{ date(event.timestamp) }}</time></li></ol>
        </div>
      </article>
    </div>
    <div v-if="section === 'updates' && roomsWithMoreThreads.length" class="inbox-pagination"><button v-for="room in roomsWithMoreThreads" :key="room.roomIdentifier" class="knowledge-button" :disabled="loadingOlder" @click="loadOlder(room.roomIdentifier)">{{ loadingOlder ? 'Loading…' : `More replies · ${room.displayName}` }}</button></div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronRight, CircleCheck, Link2, LoaderCircle, MessageSquare, RefreshCw, Send, SlidersHorizontal, Lightbulb, TriangleAlert } from '@lucide/vue';
import type { DesktopRentalRequest, DesktopRoomThreadInboxPage } from '../../../../../electron/ipc-types.js';
import type { DesktopNeedsYou } from '../../../../../electron/ipc-types/knowledge.js';
import type { AttentionNavigationIntent } from './room-shell/types';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
import { buildUniversalInbox, filterUniversalInbox, inboxCategoryLabel, type InboxSection, type UniversalInboxItem } from './room-inbox/universal';
import './room-knowledge.css';

const props = withDefaults(defineProps<{ data: DesktopNeedsYou | null; loading: boolean; error: string; rentals?: DesktopRentalRequest[]; rentalError?: string; rooms?: string[]; section?: InboxSection; storageKey?: string }>(), { rentals: () => [], rentalError: '', rooms: () => [], section: 'needs-you', storageKey: 'local' });
const emit = defineEmits<{ refresh: []; openRoom: [intent: AttentionNavigationIntent]; openRental: []; 'update:section': [section: InboxSection]; 'update:rooms': [rooms: string[]]; 'threads-loaded': [room: string, page: DesktopRoomThreadInboxPage] }>();
const motionEnabled = ref(false);
const requestHeading = ref<HTMLElement | null>(null);
const pageHeading = ref<HTMLElement | null>(null);
const sectionTitle = computed(() => props.section === 'needs-you' ? 'Needs you' : props.section === 'updates' ? 'Updates' : 'Answered');
const sectionDescription = computed(() => props.section === 'needs-you' ? 'Questions and decisions waiting on your input.' : props.section === 'updates' ? 'Replies, progress, and issues across your rooms.' : 'Your decisions, saved with the original requests.');
const hasSourceFailure = computed(() => Boolean(props.data?.failures.length || unavailable.value.length || props.data?.managedSessionsUnavailable || props.rentalError || props.data?.cloudUnavailable));
const sourceNotices = computed(() => [
  ...(props.data?.failures.length ? [`Couldn’t fully check ${props.data.failures.map(room => room.displayName).join(', ')}.`] : []),
  ...(unavailable.value.length ? [`Some updates are unavailable: ${unavailable.value.join('; ')}.`] : []),
  ...(props.data?.managedSessionsUnavailable ? ['Local agent status could not be checked.'] : []),
  ...(props.rentalError ? [props.rentalError] : []),
  ...(props.data?.cloudUnavailable ? ['Shared rooms are unavailable.'] : []),
  ...(props.data?.signedOut ? ['Showing local rooms. Sign in to include your shared rooms.'] : []),
  ...(props.data?.limited || props.data?.rooms.some(room => room.truncated) ? ['Showing up to 100 recent rooms and 200 requests per room, with unanswered requests first.'] : []),
  ...(props.section === 'updates' && props.data?.rooms.some(room => room.updates?.limited) ? ['Some rooms have more activity. Open the room to see its full history.'] : []),
]);
function selectItem(item: UniversalInboxItem) {
  selectedKey.value = item.key;
  if (window.matchMedia('(max-width: 700px)').matches) void nextTick(() => { requestHeading.value?.focus({ preventScroll: true }); requestHeading.value?.scrollIntoView({ block: 'start' }); });
}
const sections: { id: InboxSection; label: string }[] = [{ id: 'needs-you', label: 'Needs you' }, { id: 'updates', label: 'Updates' }, { id: 'answered', label: 'Answered' }];
const selectedKey = ref(''); const drafts = reactive<Record<string, string>>({}); const sending = ref(false); const sendError = ref('');
const roomMenu = ref<HTMLDetailsElement | null>(null); const dismissals = ref<Record<string, string>>({}); const lastDismissed = ref<UniversalInboxItem | null>(null); const loadingOlder = ref(false);
let alive = true;
const allItems = computed(() => buildUniversalInbox(props.data, props.rentals));
const items = computed(() => filterUniversalInbox(allItems.value, props.section, props.rooms, dismissals.value));
const selected = computed(() => items.value.find(item => item.key === selectedKey.value) ?? items.value[0]);
const sortedRooms = computed(() => [...(props.data?.rooms ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName)));
const roomFilterLabel = computed(() => !props.rooms.length ? 'All rooms' : props.rooms.length > 1 ? `${props.rooms.length} rooms` : sortedRooms.value.find(room => room.roomIdentifier === props.rooms[0])?.displayName || 'Selected room');
const unavailable = computed(() => (props.data?.rooms ?? []).filter(room => !props.rooms.length || props.rooms.includes(room.roomIdentifier)).flatMap(room => room.updates?.unavailable.length ? [`${room.displayName} (${room.updates.unavailable.join(', ')})`] : []));
const roomsWithMoreThreads = computed(() => (props.data?.rooms ?? []).filter(room => room.updates?.threads.hasMore && (!props.rooms.length || props.rooms.includes(room.roomIdentifier))));
const emptyTitle = computed(() => props.loading ? 'Checking your rooms' : props.error || props.data?.failures.length || props.data?.cloudUnavailable || props.data?.managedSessionsUnavailable || props.rentalError || unavailable.value.length ? 'Some sources still need checking' : props.section === 'answered' ? 'No answers here yet' : props.section === 'updates' ? 'You’re caught up' : 'You’re clear for now');
function count(section: InboxSection) { return filterUniversalInbox(allItems.value, section, props.rooms, dismissals.value).length; }
watch(() => selected.value?.key, () => { sendError.value = ''; });
watch(() => props.storageKey, () => {
  dismissals.value = {}; lastDismissed.value = null; selectedKey.value = ''; sendError.value = '';
  for (const key of Object.keys(drafts)) delete drafts[key];
  try { const saved = JSON.parse(window.localStorage.getItem(`letagents-desktop:inbox-dismissals:${props.storageKey}`) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) dismissals.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); } catch { /* Storage is optional. */ }
}, { immediate: true });
function persistDismissals() { try { window.localStorage.setItem(`letagents-desktop:inbox-dismissals:${props.storageKey}`, JSON.stringify(dismissals.value)); } catch { /* Keep the session usable without storage. */ } }
function dismiss(item: UniversalInboxItem) { dismissals.value = { ...dismissals.value, [item.key]: item.fingerprint }; lastDismissed.value = item; persistDismissals(); }
function undoDismiss() { if (!lastDismissed.value) return; const next = { ...dismissals.value }; delete next[lastDismissed.value.key]; dismissals.value = next; lastDismissed.value = null; persistDismissals(); }
function toggleRoom(id: string) { emit('update:rooms', props.rooms.includes(id) ? props.rooms.filter(room => room !== id) : [...props.rooms, id]); }
function closeRoomMenu() { if (roomMenu.value) { roomMenu.value.open = false; roomMenu.value.querySelector('summary')?.focus(); } }
function outsideRoomMenu(event: PointerEvent) { if (roomMenu.value?.open && event.target instanceof Node && !roomMenu.value.contains(event.target)) roomMenu.value.open = false; }
onMounted(() => document.addEventListener('pointerdown', outsideRoomMenu));
onBeforeUnmount(() => { alive = false; document.removeEventListener('pointerdown', outsideRoomMenu); });
function date(time: string) { return Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString() : ''; }
function relative(time: string) { if (!Number.isFinite(Date.parse(time))) return ''; const hours = Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 3600000)); return hours < 1 ? 'Just now' : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`; }
function actionLabel(item: UniversalInboxItem) { if (item.taskId) return 'Open task'; return ({ thread: 'Open thread', github_failure: 'Open check', agent_blocked: 'Open agent', agent_offline: 'Open room activity', rental_request: 'Review rental request' } as Record<string, string>)[item.category] || 'Open room'; }
function openRoom(item: UniversalInboxItem, mode?: 'room' | 'source') {
  if (!item.roomIdentifier) { emit('openRental'); return; }
  const intent: AttentionNavigationIntent = { roomIdentifier: item.roomIdentifier };
  if (mode === 'source') intent.messageId = item.record?.source_message_id ?? undefined;
  else if (!mode) {
    intent.taskId = item.taskId;
    if (item.activity?.kind === 'thread') intent.threadRootId = item.activity.root.id;
    if (item.activity?.kind === 'github_failure') { intent.eventId = item.activity.event.id; intent.eventUrl = item.activity.url ?? undefined; }
    if (item.activity?.kind === 'agent_blocked') intent.reasoningSessionId = item.activity.session.id;
    if (item.activity?.kind === 'agent_offline') intent.activity = true;
  }
  emit('openRoom', intent);
}
async function openSource(url: string) { try { await desktopIpc.app.openExternalUrl(url); } catch (error) { sendError.value = String(error); } }
async function loadOlder(room: string) {
  const page = props.data?.rooms.find(item => item.roomIdentifier === room)?.updates?.threads;
  const before = page?.threads.at(-1)?.summary.latestReply?.id; if (!before || loadingOlder.value) return;
  loadingOlder.value = true; sendError.value = '';
  try { const next = await desktopIpc.room.getThreads(room, 'unread', before, 75); if (alive) emit('threads-loaded', room, next); }
  catch (error) { if (alive) sendError.value = String(error); }
  finally { if (alive) loadingOlder.value = false; }
}
async function respond() {
  const item = selected.value; if (!item?.record || !item.roomIdentifier || sending.value) return;
  sending.value = true; sendError.value = '';
  try {
    if (!desktopIpc.room.reviseKnowledge) throw new Error(desktopBridgeUpgradeMessage());
    await desktopIpc.room.reviseKnowledge(item.roomIdentifier, 'attention', item.record.id, { expected_version: item.record.version, response: drafts[item.key] });
    if (!alive) return;
    delete drafts[item.key]; selectedKey.value = item.key; emit('update:section', 'answered'); emit('refresh'); void nextTick(() => pageHeading.value?.focus({ preventScroll: true }));
  } catch (error) { if (alive) sendError.value = error instanceof Error ? error.message : 'Unable to send your response.'; }
  finally { if (alive) sending.value = false; }
}
</script>
