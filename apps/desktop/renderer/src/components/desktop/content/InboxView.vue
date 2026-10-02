<template>
  <section class="knowledge-page needs-you-page" aria-labelledby="inbox-title" data-testid="inbox-view" :data-motion="motionEnabled" @pointerdown.capture="motionEnabled = true" @keydown.capture="motionEnabled = false">
    <header class="knowledge-header">
      <div><h1 id="inbox-title" ref="pageHeading" tabindex="-1">{{ sectionTitle }}<span class="knowledge-total">{{ items.length }}</span></h1><p>{{ sectionDescription }}</p></div>
      <div class="knowledge-header-actions inbox-header-actions">
        <button v-if="sourceNoticeHidden" ref="showNoticeButton" class="knowledge-icon-button inbox-notice-indicator" :aria-label="hasSourceFailure ? 'Show loading issues' : 'Show inbox information'" :title="hasSourceFailure ? 'Some updates couldn’t be loaded' : 'Room access and history limits'" @click="showSourceNotice"><TriangleAlert :size="16" aria-hidden="true" /></button>
        <button v-if="section === 'updates'" class="knowledge-button" :disabled="!items.length" :title="`Mark the ${items.length.toLocaleString()} displayed updates read${rooms.length ? ' in the selected rooms' : ''}. New activity will still appear.`" @click="markRead(items)"><CheckCheck :size="15" aria-hidden="true" />Mark all updates read</button>
        <button class="knowledge-button" :disabled="loading" @click="emit('refresh')"><RefreshCw :size="14" :class="{ 'knowledge-spin': loading }" />Refresh</button>
      </div>
    </header>
    <MessageRemindersSection @open="emit('openRoom', $event)" />
    <div class="knowledge-filters">
      <div class="knowledge-segments" aria-label="Inbox view">
        <button v-for="tab in sections" :key="tab.id" :aria-pressed="section === tab.id" @click="emit('update:section', tab.id)">{{ tab.label }}<span v-if="tab.id !== 'answered'">{{ count(tab.id) }}</span></button>
      </div>
      <details ref="roomMenu" class="inbox-room-filter" @keydown.esc.stop="closeRoomMenu" @toggle="roomMenuToggled">
        <summary class="knowledge-button"><SlidersHorizontal :size="14" />{{ roomFilterLabel }}<ChevronDown :size="13" /></summary>
        <div class="inbox-room-options">
          <input ref="roomSearch" v-model="roomQuery" class="inbox-room-search" type="search" placeholder="Find a room" aria-label="Find a room" />
          <button class="knowledge-text-button" @click="emit('update:rooms', [])">All rooms</button>
          <label v-for="room in matchingRooms" :key="room.roomIdentifier"><input type="checkbox" :checked="rooms.includes(room.roomIdentifier)" @change="toggleRoom(room.roomIdentifier)" />{{ room.displayName }}</label>
          <p v-if="!matchingRooms.length && roomQuery.trim()" class="inbox-room-empty">No rooms match “{{ roomQuery.trim() }}”.</p>
        </div>
      </details>
    </div>

    <p v-if="hiddenByFilter" class="inbox-filter-hidden">{{ hiddenByFilter.toLocaleString() }} hidden by the room filter<button class="knowledge-text-button" @click="emit('update:rooms', [])">Show all rooms</button></p>
    <p v-if="sendError" class="knowledge-notice" role="alert">{{ sendError }}</p>
    <p v-if="error" class="knowledge-notice" role="alert">{{ error }} <button @click="emit('refresh')">Try again</button></p>
    <div v-if="sourceNotices.length && !sourceNoticeHidden" class="inbox-source-notice-container">
    <details ref="sourceNotice" class="inbox-source-notice">
      <summary><TriangleAlert :size="15" aria-hidden="true" /><span>{{ hasSourceFailure ? 'Some updates couldn’t be loaded' : 'About this view' }}<span>{{ hasSourceFailure ? 'Showing what loaded. Requests or updates may be missing.' : 'Room access and history limits.' }}</span></span><ChevronDown :size="14" aria-hidden="true" /></summary>
      <ul><li v-for="message in sourceNotices" :key="message">{{ message }}</li></ul><button class="knowledge-button" @click="emit('refresh')"><RefreshCw :size="14" :class="{ 'knowledge-spin': loading }" aria-hidden="true" />{{ hasSourceFailure ? 'Retry sources' : 'Refresh' }}</button>
    </details>
    <button class="knowledge-icon-button inbox-notice-dismiss" :aria-label="hasSourceFailure ? 'Dismiss loading notice' : 'Dismiss inbox information'" title="Dismiss this notice" @click="dismissSourceNotice"><X :size="15" aria-hidden="true" /></button>
    </div>
    <div v-if="lastRead.length" class="inbox-undo" role="status"><span>{{ lastRead.length.toLocaleString() }} {{ lastRead.length === 1 ? 'update' : 'updates' }} marked read in this inbox.</span><button class="knowledge-text-button" @click="undoRead">Undo</button></div>
    <div v-if="loading && !data" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" /><h2>Checking your rooms</h2><p>Gathering requests and updates.</p></div>
    <div v-else-if="!items.length && !selected" class="knowledge-empty"><span class="knowledge-empty-mark"><Inbox v-if="section === 'updates'" :size="26" aria-hidden="true" /><CircleCheck v-else :size="26" aria-hidden="true" /></span><h2>{{ emptyTitle }}</h2><p>{{ emptyDescription }}</p><button v-if="rooms.length && !hiddenByFilter" class="knowledge-button inbox-empty-action" @click="emit('update:rooms', [])">Show all rooms</button></div>
    <div v-else class="knowledge-workspace">
      <nav class="knowledge-queue" aria-label="Inbox items">
        <!-- Rows only move with CSS. A row that leaves goes at once: a CSS leave
          waits for animation frames, which stop while the window is hidden or
          occluded, and the decided row would stay listed beside its successor. -->
        <TransitionGroup name="knowledge-list" :css="false">
          <button v-for="item in items" :key="item.key" class="knowledge-queue-item" :data-selected="selected?.key === item.key" :aria-current="selected?.key === item.key ? 'true' : undefined" @click="selectItem(item)">
            <span class="knowledge-queue-top"><span class="knowledge-category" :data-kind="item.category">{{ inboxCategoryLabel(item.category) }}</span><time :datetime="item.timestamp" :title="date(item.timestamp)">{{ inboxRelativeTime(item.timestamp, now) }}</time></span>
            <strong>{{ item.title }}</strong><span class="knowledge-queue-preview">{{ item.body }}</span><span class="knowledge-room-name"><span class="knowledge-room-dot"></span>{{ item.roomName }}<ChevronRight :size="13" /></span>
          </button>
        </TransitionGroup>
      </nav>
      <article v-if="selected" :key="selected.key" class="knowledge-detail knowledge-enter" aria-labelledby="request-title">
        <div class="knowledge-detail-context">
        <p v-if="outcome" class="inbox-outcome" :class="{ 'knowledge-success': outcome.sent }" role="status"><CircleCheck v-if="outcome.sent" :size="15" aria-hidden="true" />{{ outcome.text }}</p>
        <div class="knowledge-detail-top"><span class="knowledge-category" :data-kind="selected.category">{{ inboxCategoryLabel(selected.category) }}</span><button v-if="selected.roomIdentifier" class="knowledge-text-button" @click="openRoom(selected, 'room')">Open room <ArrowUpRight :size="14" /></button></div>
        <h2 id="request-title" ref="requestHeading" tabindex="-1">{{ selected.title }}</h2>
        <p class="knowledge-byline"><span>{{ selected.actor }}</span><span>{{ selected.roomName }}</span><time :datetime="selected.timestamp" :title="date(selected.timestamp)">{{ inboxRelativeTime(selected.timestamp, now) === 'Just now' ? 'Just now' : `${inboxRelativeTime(selected.timestamp, now)} ago` }}</time></p>
        <dl v-if="selectedApproval" class="inbox-approval-fields"><template v-for="(field, index) in hostApprovalFields(selectedApproval.presentation)" :key="index"><dt>{{ field.label }}</dt><dd><pre>{{ field.value }}</pre></dd></template></dl>
        <div v-else class="knowledge-prose">{{ selected.body || 'Open the original work for more context.' }}</div>
        <p v-if="selectedApproval?.detail" class="knowledge-prose inbox-approval-detail">{{ selectedApproval.detail }}</p>
        <div v-if="selected.record?.recommendation" class="knowledge-recommendation"><span><Lightbulb :size="15" aria-hidden="true" />Suggested approach</span><p>{{ selected.record.recommendation }}</p></div>
        <div v-if="selected.record?.unblocks" class="knowledge-unblocks"><ArrowRight :size="15" /><p><strong>Your answer unblocks</strong>{{ selected.record.unblocks }}</p></div>
        <div v-if="selected.record?.source_url || selected.record?.source_message_id" class="knowledge-source-row"><button v-if="selected.record.source_url" class="knowledge-button" @click="openSource(selected.record.source_url)"><Link2 :size="14" />View source</button><button v-if="selected.record.source_message_id" class="knowledge-button" @click="openRoom(selected, 'source')"><MessageSquare :size="14" />Original message</button></div>
        </div>
        <div v-if="selected.record?.response" class="knowledge-answer" role="status"><span><CircleCheck :size="16" /> Answer recorded</span><p>{{ selected.record.response.body }}</p><small>{{ selected.record.response.actor.label }} · {{ date(selected.record.response.at) }}</small></div>
        <div v-else-if="selectedApproval" class="knowledge-task-action">
          <p v-if="selectedApproval.status === 'pending' && selectedApproval.presentation.denyScope === 'session_pending'" class="inbox-approval-note">Deny applies to all pending permissions for this agent.</p>
          <div v-if="selectedApproval.status === 'pending'" class="knowledge-source-row"><button class="knowledge-button" :disabled="approvalDisabled" @click="decideApproval('deny')">Deny</button><button class="knowledge-button knowledge-primary" :disabled="approvalDisabled" @click="decideApproval('allow_once')">{{ approvalState.busy === selectedApproval.id ? 'Recording…' : hostApprovalAllowLabel(selectedApproval.presentation) }}</button><button v-if="selectedApproval.presentation.alwaysAllow" class="knowledge-button" :disabled="approvalDisabled" :title="HOST_APPROVAL_ALWAYS_ALLOW_HINT" @click="decideApproval('allow_always')">{{ hostApprovalAlwaysAllowLabel(selectedApproval.presentation) }}</button></div>
          <div v-else-if="selectedApproval.retryDecision" class="knowledge-source-row"><button class="knowledge-button knowledge-primary" :disabled="approvalDisabled" @click="decideApproval(selectedApproval.retryDecision)">Retry recorded {{ selectedApproval.retryDecision === 'deny' ? 'denial' : 'approval' }}</button></div>
          <p v-else-if="selectedApproval.status === 'decision_sent' || selectedApproval.status === 'resolved'" class="knowledge-success inbox-approval-result" role="status"><CircleCheck :size="16" aria-hidden="true" />{{ hostApprovalStatusLabel(selectedApproval.status) }}</p>
          <p v-else class="inbox-approval-note inbox-approval-result" role="status">{{ hostApprovalStatusLabel(selectedApproval.status) }}.{{ selectedApproval.status === 'uncertain' ? ' Your decision will not be sent again.' : '' }}</p>
          <p v-if="approvalState.error" class="knowledge-inline-error inbox-approval-error" role="status">{{ approvalState.error }} <button class="knowledge-text-button" :disabled="approvalState.loading" @click="refreshApproval">Refresh approvals</button></p>
        </div>
        <form v-else-if="selected.record" class="knowledge-response" @submit.prevent="respond">
          <label :for="`response-${selected.record.id}`">Your response</label><textarea :id="`response-${selected.record.id}`" v-model="drafts[selected.key]" rows="4" maxlength="8000" placeholder="Give the agent a clear decision or next step…" :disabled="sending" required></textarea>
          <div class="knowledge-response-footer"><small>Sent to the room and saved with this request.</small><button class="knowledge-button knowledge-primary" :disabled="sending || !drafts[selected.key]?.trim()"><LoaderCircle v-if="sending" :size="14" class="knowledge-spin" /><Send v-else :size="14" />{{ sending ? 'Sending…' : 'Send response' }}</button></div>
        </form>
        <div v-else class="knowledge-task-action">
          <div class="knowledge-source-row"><button class="knowledge-button knowledge-primary" @click="openRoom(selected)">{{ actionLabel(selected) }}<ArrowUpRight :size="14" /></button><button v-if="selected.section === 'updates'" class="knowledge-button" @click="markRead([selected])"><Check :size="14" />Mark read</button></div>
          <ol v-if="selected.activity?.activity.length" class="inbox-activity"><li v-for="event in selected.activity.activity" :key="event.id"><strong>{{ event.label }}</strong><p v-if="event.description">{{ event.description }}</p><time v-if="event.timestamp" :datetime="event.timestamp">{{ date(event.timestamp) }}</time></li></ol>
        </div>
      </article>
    </div>
    <div v-if="section === 'updates' && roomsWithMoreThreads.length" class="inbox-pagination"><button v-for="room in roomsWithMoreThreads" :key="room.roomIdentifier" class="knowledge-button" :disabled="loadingOlder" @click="loadOlder(room.roomIdentifier)">{{ loadingOlder ? 'Loading…' : `More replies · ${room.displayName}` }}</button></div>
  </section>
</template>

<script setup lang="ts">
import MessageRemindersSection from "./MessageRemindersSection.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleCheck, Inbox, Link2, LoaderCircle, MessageSquare, RefreshCw, Send, SlidersHorizontal, Lightbulb, TriangleAlert, X } from '@lucide/vue';
import type { DesktopRentalRequest, DesktopRoomThreadInboxPage } from '../../../../../electron/ipc-types.js';
import type { DesktopNeedsYou } from '../../../../../electron/ipc-types/knowledge.js';
import type { AttentionNavigationIntent } from './room-shell/types';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
import { buildUniversalInbox, compareUniversalInboxItems, filterUniversalInbox, inboxCategoryLabel, inboxNavigationIntent, inboxRelativeTime, inboxSourceFailureKey, inboxSourceFailures, markInboxUpdatesRead, nextInboxSelection, searchInboxRooms, stableInboxOrder, undoInboxRead, type InboxReadChange, type InboxSection, type UniversalInboxItem } from './room-inbox/universal';
import { isActionableHostApproval, type AgentAttentionItem } from './room-inbox/agent-attention';
import type { KnowledgeRecord } from '../../../../../../../shared/room-knowledge.mjs';
import type { HostApprovalSelection } from '../../../../../shared/host-approvals';
import { decideHostApproval, hostApprovalRoom, refreshHostApprovals } from './room-chat/host-approvals';
import { HOST_APPROVAL_ALWAYS_ALLOW_HINT, HOST_APPROVAL_SETTLE_MS, hostApprovalAllowLabel, hostApprovalAlwaysAllowLabel, hostApprovalFields, hostApprovalStatusLabel } from './room-chat/host-approval-presentation';
import './room-knowledge.css';

const props = withDefaults(defineProps<{ data: DesktopNeedsYou | null; attention?: AgentAttentionItem[]; loading: boolean; error: string; rentals?: DesktopRentalRequest[]; rentalError?: string; rooms?: string[]; section?: InboxSection; storageKey?: string }>(), { attention: () => [], rentals: () => [], rentalError: '', rooms: () => [], section: 'needs-you', storageKey: 'local' });
const emit = defineEmits<{ refresh: []; openRoom: [intent: AttentionNavigationIntent]; openRental: []; 'update:section': [section: InboxSection]; 'update:rooms': [rooms: string[]]; 'threads-loaded': [room: string, page: DesktopRoomThreadInboxPage] }>();
const motionEnabled = ref(false);
const requestHeading = ref<HTMLElement | null>(null);
const pageHeading = ref<HTMLElement | null>(null);
const sourceNotice = ref<HTMLDetailsElement | null>(null);
const showNoticeButton = ref<HTMLButtonElement | null>(null);
// A dismissed notice is remembered per room filter, so switching filters never erases it.
const dismissedSourceNotices = ref<Record<string, string>>({});
const noticeScope = computed(() => JSON.stringify([...props.rooms].sort()));
// Ages advance between refreshes; the clock starts only in a mounted view.
const now = ref(Date.now()); let clock: ReturnType<typeof setInterval> | undefined;
const sectionTitle = computed(() => props.section === 'needs-you' ? 'Needs you' : props.section === 'updates' ? 'Updates' : 'Answered');
const sectionDescription = computed(() => props.section === 'needs-you' ? 'Questions and decisions waiting on your input.' : props.section === 'updates' ? 'Replies, progress, and issues across your rooms.' : 'Your decisions, saved with the original requests.');
// Loading issues follow the room filter; rental requests belong to no room.
const failedRooms = computed(() => inboxSourceFailures(props.data, props.rooms));
const rentalErrorInView = computed(() => props.rooms.length ? '' : props.rentalError);
const hasSourceFailure = computed(() => Boolean(failedRooms.value.length || unavailable.value.length || props.data?.managedSessionsUnavailable || rentalErrorInView.value || props.data?.cloudUnavailable));
const sourceFailures = computed(() => [
  ...(failedRooms.value.length ? [`Couldn’t load all inbox data for ${failedRooms.value.map(room => room.displayName).sort().join(', ')}.`] : []),
  ...(unavailable.value.length ? [`Some updates are unavailable: ${unavailable.value.join('; ')}.`] : []),
  ...(props.data?.managedSessionsUnavailable ? ['Local agent status could not be checked.'] : []),
  ...(rentalErrorInView.value ? [rentalErrorInView.value] : []),
  ...(props.data?.cloudUnavailable ? ['Shared rooms are unavailable.'] : []),
]);
const sourceNotices = computed(() => [
  ...sourceFailures.value,
  ...(props.data?.signedOut ? ['Showing local rooms. Sign in to include your shared rooms.'] : []),
  ...(props.data?.limited || props.data?.rooms.some(room => room.truncated) ? ['Showing up to 100 recent rooms and 200 requests per room, with unanswered requests first.'] : []),
  ...(props.section === 'updates' && props.data?.rooms.some(room => room.updates?.limited) ? ['Some rooms have more activity. Open the room to see its full history.'] : []),
]);
const sourceNoticeKey = computed(() => !sourceNotices.value.length ? '' : hasSourceFailure.value ? inboxSourceFailureKey(props.data, props.rooms, rentalErrorInView.value) : JSON.stringify([...sourceNotices.value].sort()));
const sourceNoticeHidden = computed(() => Boolean(sourceNoticeKey.value && sourceNoticeKey.value === dismissedSourceNotices.value[noticeScope.value]));
function setSourceNoticeDismissal(key: string) {
  const { [noticeScope.value]: _previous, ...others } = dismissedSourceNotices.value;
  // Keep the most recent filters only.
  dismissedSourceNotices.value = Object.fromEntries([...Object.entries(others), ...(key ? [[noticeScope.value, key]] : [])].slice(-20));
  try { const storage = `letagents-desktop:inbox-hidden-notice:${props.storageKey}`; if (Object.keys(dismissedSourceNotices.value).length) window.localStorage.setItem(storage, JSON.stringify(dismissedSourceNotices.value)); else window.localStorage.removeItem(storage); } catch { /* Keep dismissal usable for this session. */ }
}
function dismissSourceNotice() { setSourceNoticeDismissal(sourceNoticeKey.value); void nextTick(() => showNoticeButton.value?.focus({ preventScroll: true })); }
function showSourceNotice() { setSourceNoticeDismissal(''); void nextTick(() => { if (sourceNotice.value) { sourceNotice.value.open = true; sourceNotice.value.querySelector('summary')?.focus(); } }); }
function selectItem(item: UniversalInboxItem) {
  selectedKey.value = item.key; outcome.value = null;
  if (window.matchMedia('(max-width: 700px)').matches) void nextTick(() => { requestHeading.value?.focus({ preventScroll: true }); requestHeading.value?.scrollIntoView({ block: 'start' }); });
}
const sections: { id: InboxSection; label: string }[] = [{ id: 'needs-you', label: 'Needs you' }, { id: 'updates', label: 'Updates' }, { id: 'answered', label: 'Answered' }];
const selectedKey = ref(''); const drafts = reactive<Record<string, string>>({}); const sending = ref(false); const sendError = ref('');
const roomMenu = ref<HTMLDetailsElement | null>(null); const dismissals = ref<Record<string, string>>({}); const lastRead = ref<InboxReadChange[]>([]); const loadingOlder = ref(false);
let alive = true;
// An answer sent from here moves its request to Answered before the next refresh confirms it.
const sentAnswers = ref<Record<string, KnowledgeRecord>>({});
const allItems = computed(() => buildUniversalInbox(props.data, props.rentals, props.attention).map(item => {
  const record = sentAnswers.value[item.key];
  return record && item.record && record.version > item.record.version
    ? { ...item, record, section: 'answered' as const, timestamp: record.response?.at || item.timestamp, fingerprint: String(record.version) } : item;
}).sort(compareUniversalInboxItems));
// The list as last displayed. Arrivals join around the selected row instead of
// reshuffling it; a new section, room filter or account starts from the usual order.
let shown: { scope: string; items: UniversalInboxItem[] } = { scope: '', items: [] };
const items = computed(() => {
  const scope = JSON.stringify([props.storageKey, props.section, [...props.rooms].sort()]);
  const sorted = filterUniversalInbox(allItems.value, props.section, props.rooms, dismissals.value);
  // Until a row is chosen, the first row is the one on screen.
  const next = scope === shown.scope ? stableInboxOrder(shown.items.map(item => item.key), sorted, selectedKey.value || shown.items[0]?.key || null) : sorted;
  shown = { scope, items: next };
  return next;
});
// A decided approval leaves the queue but stays open with its result until you move on.
const decided = ref<UniversalInboxItem | null>(null);
// What the last decision did, shown on the item selected after it.
const outcome = ref<{ text: string; sent: boolean } | null>(null);
const selected = computed(() => items.value.find(item => item.key === selectedKey.value)
  ?? (decided.value?.key === selectedKey.value ? decided.value : items.value[0]));
// A selected row that leaves the list (answered elsewhere, or its agent recovered) gives way to the row that took its place.
watch(items, (list, previous) => {
  const key = selectedKey.value;
  if (!key || list.some(item => item.key === key) || decided.value?.key === key) return;
  const next = previous ? nextInboxSelection(previous, list, key) : list[0];
  selectedKey.value = next?.key ?? '';
  holdApprovalDecisions(next);
});
// Tool approvals share the composer card's state, so a decision here or there shows on both.
const selectedApproval = computed(() => selected.value?.attention?.kind === 'tool_approval' ? selected.value.attention.approval : null);
const approvalState = computed(() => hostApprovalRoom(selected.value?.roomIdentifier));
// A request selected for you opens where the previous one was; its decisions wait until it settles.
const approvalSettling = ref(false); let settleTimer: ReturnType<typeof setTimeout> | undefined;
function holdApprovalDecisions(item: UniversalInboxItem | null | undefined) {
  if (item?.attention?.kind !== 'tool_approval') return;
  approvalSettling.value = true; clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { approvalSettling.value = false; }, HOST_APPROVAL_SETTLE_MS);
}
const approvalDisabled = computed(() => approvalState.value.busy !== null || approvalState.value.error !== null || approvalSettling.value);
const sortedRooms = computed(() => [...(props.data?.rooms ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName)));
const roomSearch = ref<HTMLInputElement | null>(null); const roomQuery = ref('');
const matchingRooms = computed(() => searchInboxRooms(sortedRooms.value, roomQuery.value));
const roomFilterLabel = computed(() => !props.rooms.length ? 'All rooms' : props.rooms.length > 1 ? `${props.rooms.length} rooms` : sortedRooms.value.find(room => room.roomIdentifier === props.rooms[0])?.displayName || 'Selected room');
const unavailable = computed(() => (props.data?.rooms ?? []).filter(room => !props.rooms.length || props.rooms.includes(room.roomIdentifier)).flatMap(room => room.updates?.unavailable.length ? [`${room.displayName} (${[...room.updates.unavailable].sort().join(', ')})`] : []).sort());
const roomsWithMoreThreads = computed(() => (props.data?.rooms ?? []).filter(room => room.updates?.threads.hasMore && (!props.rooms.length || props.rooms.includes(room.roomIdentifier))));
const hiddenByFilter = computed(() => props.rooms.length ? filterUniversalInbox(allItems.value, props.section, [], dismissals.value).length - items.value.length : 0);
const emptyTitle = computed(() => props.loading ? 'Checking your rooms' : hiddenByFilter.value ? 'Nothing here in the selected rooms' : props.section === 'updates' ? 'No unread updates to show' : props.error || hasSourceFailure.value ? 'Some inbox data is unavailable' : props.section === 'answered' ? 'No answers here yet' : 'You’re clear for now');
const emptyDescription = computed(() => props.section === 'answered' ? 'Answered requests will appear here.' : props.section === 'updates' ? props.error || hasSourceFailure.value ? 'New activity will appear here. Some room data is still unavailable.' : 'Room updates will appear here as work progresses.' : 'Questions, decisions and approvals will appear when someone asks for your input.');
function count(section: InboxSection) { return filterUniversalInbox(allItems.value, section, props.rooms, dismissals.value).length; }
watch(() => selected.value?.key, () => { sendError.value = ''; });
watch([() => props.section, () => props.rooms], () => { outcome.value = null; });
// Moving to another item or section, or filtering its room out, lets the decided item go.
watch([selectedKey, () => props.section, () => props.rooms], () => {
  const item = decided.value;
  if (item && (item.key !== selectedKey.value || (props.rooms.length && !props.rooms.includes(item.roomIdentifier ?? '')))) decided.value = null;
});
watch(() => props.storageKey, () => {
  dismissals.value = {}; lastRead.value = []; dismissedSourceNotices.value = {}; selectedKey.value = ''; sendError.value = ''; outcome.value = null; sentAnswers.value = {};
  for (const key of Object.keys(drafts)) delete drafts[key];
  try { const saved = JSON.parse(window.localStorage.getItem(`letagents-desktop:inbox-dismissals:${props.storageKey}`) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) dismissals.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string')); } catch { /* Storage is optional. */ }
  try {
    const raw = window.localStorage.getItem(`letagents-desktop:inbox-hidden-notice:${props.storageKey}`) || '';
    // Before notices were scoped, one dismissal covered the unfiltered view.
    const saved: unknown = raw.startsWith('{') ? JSON.parse(raw) : raw ? { '[]': raw } : {};
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) dismissedSourceNotices.value = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { /* Storage is optional. */ }
}, { immediate: true });
// The row on screen is the selected row, so an arrival can never take its place.
// A request that appears in an empty list is selected for you, so it waits to settle too.
watch([() => selected.value?.key, selectedKey], ([key, chosen]) => {
  if (!key || chosen) return;
  selectedKey.value = key;
  holdApprovalDecisions(selected.value);
}, { immediate: true });
// A new failure in the current scope brings its notice back.
watch([sourceNoticeKey, () => props.loading, () => props.storageKey, noticeScope], ([key, loading]) => { const dismissed = dismissedSourceNotices.value[noticeScope.value]; if (!loading && props.data && dismissed && key !== dismissed) setSourceNoticeDismissal(''); }, { immediate: true });
function persistDismissals() { try { window.localStorage.setItem(`letagents-desktop:inbox-dismissals:${props.storageKey}`, JSON.stringify(dismissals.value)); } catch { /* Keep the session usable without storage. */ } }
function markRead(updates: UniversalInboxItem[]) { const result = markInboxUpdatesRead(updates, dismissals.value); if (!result.changes.length) return; dismissals.value = result.dismissals; lastRead.value = result.changes; persistDismissals(); void nextTick(() => pageHeading.value?.focus({ preventScroll: true })); }
function undoRead() { dismissals.value = undoInboxRead(lastRead.value, dismissals.value); lastRead.value = []; persistDismissals(); void nextTick(() => pageHeading.value?.focus({ preventScroll: true })); }
function toggleRoom(id: string) { emit('update:rooms', props.rooms.includes(id) ? props.rooms.filter(room => room !== id) : [...props.rooms, id]); }
function roomMenuToggled() { if (roomMenu.value?.open) void nextTick(() => roomSearch.value?.focus({ preventScroll: true })); else roomQuery.value = ''; }
function closeRoomMenu() { if (roomMenu.value) { roomMenu.value.open = false; roomMenu.value.querySelector('summary')?.focus(); } }
function outsideRoomMenu(event: PointerEvent) { if (roomMenu.value?.open && event.target instanceof Node && !roomMenu.value.contains(event.target)) roomMenu.value.open = false; }
onMounted(() => { document.addEventListener('pointerdown', outsideRoomMenu); clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onBeforeUnmount(() => { alive = false; clearInterval(clock); clearTimeout(settleTimer); document.removeEventListener('pointerdown', outsideRoomMenu); });
function date(time: string) { return Number.isFinite(Date.parse(time)) ? new Date(time).toLocaleString() : ''; }
function actionLabel(item: UniversalInboxItem) { if (item.taskId) return 'Open task'; return ({ thread: 'Open thread', github_failure: 'Open check', agent_blocked: 'Open agent', agent_offline: 'Open room activity', rental_request: 'Review rental request', agent_attention: 'Open diagnostics', board_intent: 'Review request' } as Record<string, string>)[item.category] || 'Open room'; }
function openRoom(item: UniversalInboxItem, mode?: 'room' | 'source') {
  const intent = inboxNavigationIntent(item, mode);
  if (intent) emit('openRoom', intent); else emit('openRental');
}
/** After a decision goes through, select the next request in the place this one had; the last one stays open with its result. */
function moveOnFrom(item: UniversalInboxItem, list: readonly UniversalInboxItem[], result: string, sent: boolean) {
  const next = selectedKey.value === item.key ? nextInboxSelection(list, items.value, item.key) : null;
  if (next) { selectedKey.value = next.key; outcome.value = { text: `${result}: ${item.title}`, sent }; holdApprovalDecisions(next); }
  return Boolean(next);
}
async function decideApproval(decision: HostApprovalSelection) {
  const item = selected.value; const approval = selectedApproval.value;
  if (!item?.roomIdentifier || !approval || approvalSettling.value) return;
  const list = items.value;
  selectedKey.value = item.key; decided.value = item; outcome.value = null;
  await decideHostApproval(item.roomIdentifier, approval.id, decision);
  if (!alive) return;
  const state = hostApprovalRoom(item.roomIdentifier);
  const status = state.approvals.find(entry => entry.id === approval.id)?.status ?? approval.status;
  if (!state.error && !isActionableHostApproval({ status })) moveOnFrom(item, list, hostApprovalStatusLabel(status), status === 'decision_sent' || status === 'resolved');
  void nextTick(() => requestHeading.value?.focus({ preventScroll: true }));
}
function refreshApproval() { if (selected.value?.roomIdentifier) void refreshHostApprovals(selected.value.roomIdentifier); }
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
    const list = items.value;
    const answered = await desktopIpc.room.reviseKnowledge(item.roomIdentifier, 'attention', item.record.id, { expected_version: item.record.version, response: drafts[item.key] });
    if (!alive) return;
    delete drafts[item.key];
    if (answered?.response) sentAnswers.value = { ...sentAnswers.value, [item.key]: answered };
    emit('refresh');
    if (selectedKey.value !== item.key) return; // Moved on while it was sending.
    if (moveOnFrom(item, list, 'Answer sent', true)) { void nextTick(() => requestHeading.value?.focus({ preventScroll: true })); return; }
    emit('update:section', 'answered'); void nextTick(() => pageHeading.value?.focus({ preventScroll: true }));
  } catch (error) { if (alive) sendError.value = error instanceof Error ? error.message : 'Unable to send your response.'; }
  finally { if (alive) sending.value = false; }
}
</script>
