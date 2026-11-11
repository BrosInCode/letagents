<template>
  <InboxLayout ref="layout" class="needs-you-page" data-testid="inbox-view" :section="section" :counts="counts" :updates-loaded="updatesLoaded" :loading="loading" :items="items" :selected-key="selected?.key" :rooms="roomOptions" :selected-rooms="rooms" v-model:query="query" @refresh="emit('refresh')" @update:section="emit('update:section', $event)" @update:rooms="emit('update:rooms', $event)" @select="selectKey">
    <template #header-actions><button v-if="sourceNoticeHidden" ref="showNoticeButton" class="knowledge-icon-button inbox-notice-indicator" :aria-label="hasSourceFailure ? 'Show loading issues' : 'Show inbox information'" :title="hasSourceFailure ? 'Some updates couldn’t be loaded' : 'Room access and history limits'" @click="showSourceNotice"><TriangleAlert :size="16" aria-hidden="true" /></button></template>
    <template #reminders><MessageRemindersSection @open="emit('openRoom', $event)" /></template>
    <template #notices>
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
    </template>
    <template #empty>
    <div v-if="loading && !data" class="knowledge-empty" role="status"><LoaderCircle class="knowledge-spin" :size="24" /><h2>Checking your rooms</h2><p>Gathering requests and updates.</p></div>
    <div v-else-if="!items.length && !selected" class="knowledge-empty"><span class="knowledge-empty-mark"><Inbox v-if="section === 'updates'" :size="26" aria-hidden="true" /><CircleCheck v-else :size="26" aria-hidden="true" /></span><h2>{{ emptyTitle }}</h2><p>{{ emptyDescription }}</p><button v-if="rooms.length && !hiddenByFilter" class="knowledge-button inbox-empty-action" @click="emit('update:rooms', [])">Show all rooms</button></div>
    </template>
    <template #item-avatar="{ item }"><ChatAvatar v-bind="avatars.get(item.key)" :name="item.actor" /></template>
    <template v-if="selected" #detail>
      <article v-if="selected" :key="selected.key" class="inbox-desktop-detail" aria-labelledby="request-title">
        <div class="inbox-detail-content">
        <p v-if="outcome" class="inbox-outcome" :class="{ 'knowledge-success': outcome.sent }" role="status"><CircleCheck v-if="outcome.sent" :size="15" aria-hidden="true" />{{ outcome.text }}</p>
        <div class="inbox-detail-top"><span>{{ inboxCategoryLabel(selected.category) }}</span><time :datetime="selected.timestamp" :title="date(selected.timestamp)">{{ inboxRelativeTime(selected.timestamp, now) }}</time></div>
        <h2 id="request-title" ref="requestHeading" tabindex="-1">{{ selected.title }}</h2>
        <div class="inbox-detail-byline"><ChatAvatar v-bind="avatars.get(selected.key)" :name="selected.actor" /><strong>{{ selected.actor }}</strong><span aria-hidden="true">·</span><button v-if="selected.roomIdentifier" class="knowledge-text-button" @click="openRoom(selected, 'room')">{{ selected.roomName }}<ArrowUpRight :size="12" /></button><span v-else>{{ selected.roomName }}</span></div>
        <dl v-if="selectedApproval" class="inbox-approval-fields"><template v-for="(field, index) in hostApprovalFields(selectedApproval.presentation)" :key="index"><dt>{{ field.label }}</dt><dd><pre>{{ field.value }}</pre></dd></template></dl>
        <div v-else class="knowledge-prose">{{ selected.body || 'Open the original work for more context.' }}</div>
        <p v-if="selectedApproval?.detail" class="knowledge-prose inbox-approval-detail">{{ selectedApproval.detail }}</p>
        <div v-if="selected.record?.response" class="knowledge-answer" role="status"><span><CircleCheck :size="16" /> {{ selected.record.response.closed ? 'Closed' : 'Answer recorded' }}</span><p>{{ selected.record.response.body }}</p><small>{{ selected.record.response.actor.label }} · {{ date(selected.record.response.at) }}</small></div>
        <div v-else-if="selectedApproval" class="knowledge-task-action">
          <p v-if="selectedApproval.status === 'pending' && selectedApproval.presentation.denyScope === 'session_pending'" class="inbox-approval-note">Deny applies to all pending permissions for this agent.</p>
          <div v-if="selectedApproval.status === 'pending'" class="knowledge-source-row"><button class="knowledge-button" :disabled="approvalDisabled" @click="decideApproval('deny')">Deny</button><button class="knowledge-button knowledge-primary" :disabled="approvalDisabled" @click="decideApproval('allow_once')">{{ approvalState.busy === selectedApproval.id ? 'Recording…' : hostApprovalAllowLabel(selectedApproval.presentation) }}</button><button v-if="selectedApproval.presentation.alwaysAllow" class="knowledge-button" :disabled="approvalDisabled" :title="HOST_APPROVAL_ALWAYS_ALLOW_HINT" @click="decideApproval('allow_always')">{{ hostApprovalAlwaysAllowLabel(selectedApproval.presentation) }}</button></div>
          <div v-else-if="selectedApproval.retryDecision" class="knowledge-source-row"><button class="knowledge-button knowledge-primary" :disabled="approvalDisabled" @click="decideApproval(selectedApproval.retryDecision)">Retry recorded {{ selectedApproval.retryDecision === 'deny' ? 'denial' : 'approval' }}</button></div>
          <p v-else-if="selectedApproval.status === 'decision_sent' || selectedApproval.status === 'resolved'" class="knowledge-success inbox-approval-result" role="status"><CircleCheck :size="16" aria-hidden="true" />{{ hostApprovalStatusLabel(selectedApproval.status) }}</p>
          <p v-else class="inbox-approval-note inbox-approval-result" role="status">{{ hostApprovalStatusLabel(selectedApproval.status) }}.{{ selectedApproval.status === 'uncertain' ? ' Your decision will not be sent again.' : '' }}</p>
          <p v-if="approvalState.error" class="knowledge-inline-error inbox-approval-error" role="status">{{ approvalState.error }} <button class="knowledge-text-button" :disabled="approvalState.loading" @click="refreshApproval">Refresh approvals</button></p>
        </div>
        <div v-else-if="selected.joinRequest" class="knowledge-task-action" data-testid="inbox-join-request">
          <p v-if="joinDecision?.key === selected.key" class="knowledge-success inbox-approval-result" role="status"><CircleCheck :size="16" aria-hidden="true" />{{ joinDecision.label }}</p>
          <div v-else class="knowledge-source-row"><button class="knowledge-button" :disabled="sending" data-testid="inbox-join-decline" @click="decideJoinRequest('decline')">Decline</button><button class="knowledge-button knowledge-primary" :disabled="sending" data-testid="inbox-join-approve" @click="decideJoinRequest('approve')">{{ sending ? 'Recording…' : 'Approve' }}</button></div>
        </div>
        <div v-else-if="selected.approvalTask" class="knowledge-task-action" data-testid="inbox-task-approval">
          <p><strong>{{ selected.approvalTask.id }} · {{ selected.approvalTask.title }}</strong></p>
          <p v-if="selected.approvalTask.description" class="knowledge-prose">{{ selected.approvalTask.description }}</p>
          <p v-if="acceptedTaskFor(selected)" class="knowledge-success" role="status">Task accepted on the board.</p>
          <div class="knowledge-source-row"><button v-if="!acceptedTaskFor(selected) || selected.record" class="knowledge-button knowledge-primary" :disabled="sending" @click="acceptTask">{{ sending ? 'Recording…' : acceptedTaskFor(selected) ? 'Retry saving answer' : 'Accept task' }}</button><button class="knowledge-button" :disabled="sending" @click="openRoom({ ...selected, taskId: selected.approvalTask.id })">Open task<ArrowUpRight :size="14" /></button></div>
          <InboxResponse v-if="selected.record && !acceptedTaskFor(selected)" :id="`response-${selected.record.id}`" v-model="drafts[selected.key]" :recipient="selected.actor" :disabled="sending" @submit="respond" @close="closeRequest" />
        </div>
        <InboxResponse v-else-if="selected.record" :key="selected.key" :id="`response-${selected.record.id}`" v-model="drafts[selected.key]" :suggestion="selected.record.recommendation" :recipient="selected.actor" :disabled="sending" @submit="respond" @close="closeRequest" />
        <div v-else class="knowledge-task-action">
          <div class="knowledge-source-row"><button class="knowledge-button knowledge-primary" @click="openRoom(selected)">{{ actionLabel(selected) }}<ArrowUpRight :size="14" /></button><button v-if="selected.section === 'updates'" class="knowledge-button" @click="markRead([selected])"><Check :size="14" />Mark read</button></div>
          <details v-if="selected.activity?.activity.length" class="inbox-supporting"><summary>History <span>{{ selected.activity.activity.length }}</span></summary><ol class="inbox-activity"><li v-for="event in selected.activity.activity" :key="event.id"><strong>{{ event.label }}</strong><p v-if="event.description">{{ event.description }}</p><time v-if="event.timestamp" :datetime="event.timestamp">{{ date(event.timestamp) }}</time></li></ol></details>
          <details v-if="selected.attention?.kind === 'agent_attention' && selected.attention.entry.lastError" class="inbox-supporting"><summary>Technical details</summary><pre>{{ selected.attention.entry.lastError }}</pre></details>
        </div>
        <details v-if="selected.record?.unblocks || selected.record?.source_url || selected.record?.source_message_id" class="inbox-supporting"><summary>Supporting details</summary><p v-if="selected.record?.unblocks">{{ selected.record.unblocks }}</p><div class="knowledge-source-row"><button v-if="selected.record?.source_url" class="knowledge-text-button" @click="openSource(selected.record.source_url)"><Link2 :size="14" />View source</button><button v-if="selected.record?.source_message_id" class="knowledge-text-button" @click="openRoom(selected, 'source')"><MessageSquare :size="14" />Original message</button></div></details>
        </div>
      </article>
    </template>
    <template v-if="section === 'updates'" #queue-footer><button class="knowledge-text-button" :disabled="!items.length || !updatesLoaded" :title="updatesLoaded ? `Mark the ${items.length.toLocaleString()} displayed updates read${rooms.length ? ' in the selected rooms' : ''}. New activity will still appear.` : 'Available once updates load.'" @click="markRead(items)"><CheckCheck :size="14" aria-hidden="true" />Mark all read</button></template>
    <template #footer><div v-if="section === 'updates' && roomsWithMoreThreads.length" class="inbox-pagination"><button v-for="room in roomsWithMoreThreads" :key="room.roomIdentifier" class="knowledge-button" :disabled="loadingOlder" @click="loadOlder(room.roomIdentifier)">{{ loadingOlder ? 'Loading…' : `More replies · ${room.displayName}` }}</button></div></template>
  </InboxLayout>
</template>

<script setup lang="ts">
import MessageRemindersSection from "./MessageRemindersSection.vue";
import { useNow } from "../../../composables/useNow";
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ArrowUpRight, Check, CheckCheck, ChevronDown, CircleCheck, Inbox, Link2, LoaderCircle, MessageSquare, RefreshCw, TriangleAlert, X } from '@lucide/vue';
import type { DesktopAccountRoomJoinRequest, DesktopRentalRequest, DesktopRoomThreadInboxPage } from '../../../../../electron/ipc-types.js';
import { roomJoinRequests } from '../../../composables/useRoomJoinRequests';
import type { DesktopAttentionTask, DesktopNeedsYou } from '../../../../../electron/ipc-types/knowledge.js';
import type { AttentionNavigationIntent } from './room-shell/types';
import { desktopBridgeUpgradeMessage, desktopIpc } from '../../../ipc/index.js';
import { buildUniversalInbox, compareUniversalInboxItems, filterUniversalInbox, inboxCategoryLabel, inboxNavigationIntent, inboxRelativeTime, inboxSourceFailureKey, inboxSourceFailures, markInboxUpdatesRead, nextInboxSelection, stableInboxOrder, undoInboxRead, type InboxReadChange, type InboxSection, type UniversalInboxItem } from './room-inbox/universal';
import { isActionableHostApproval, type AgentAttentionItem } from './room-inbox/agent-attention';
import type { KnowledgeRecord } from '../../../../../../../shared/room-knowledge.mjs';
import { attentionRecordCategory } from './room-inbox/universal';
import type { HostApprovalSelection } from '../../../../../shared/host-approvals';
import { decideHostApproval, hostApprovalRoom, refreshHostApprovals } from './room-chat/host-approvals';
import { HOST_APPROVAL_ALWAYS_ALLOW_HINT, HOST_APPROVAL_SETTLE_MS, hostApprovalAllowLabel, hostApprovalAlwaysAllowLabel, hostApprovalFields, hostApprovalStatusLabel } from './room-chat/host-approval-presentation';
import InboxLayout from '../../../../../../../shared/ui/inbox/InboxLayout.vue';
import InboxResponse from '../../../../../../../shared/ui/inbox/InboxResponse.vue';
import ChatAvatar from '../../../../../../../shared/ui/ChatAvatar.vue';
import './room-knowledge.css';
import './room-inbox/inbox-view.css';

const props = withDefaults(defineProps<{ data: DesktopNeedsYou | null; attention?: AgentAttentionItem[]; loading: boolean; error: string; rentals?: DesktopRentalRequest[]; rentalError?: string; joinRequests?: readonly DesktopAccountRoomJoinRequest[]; rooms?: string[]; section?: InboxSection; storageKey?: string }>(), { attention: () => [], rentals: () => [], rentalError: '', joinRequests: () => [], rooms: () => [], section: 'needs-you', storageKey: 'local' });
const emit = defineEmits<{ refresh: []; openRoom: [intent: AttentionNavigationIntent]; openRental: []; 'update:section': [section: InboxSection]; 'update:rooms': [rooms: string[]]; 'threads-loaded': [room: string, page: DesktopRoomThreadInboxPage] }>();
const layout = ref<{ focusHeading(): void } | null>(null);
const query = ref('');
const requestHeading = ref<HTMLElement | null>(null);
const sourceNotice = ref<HTMLDetailsElement | null>(null);
const showNoticeButton = ref<HTMLButtonElement | null>(null);
// A dismissed notice is remembered per room filter, so switching filters never erases it.
const dismissedSourceNotices = ref<Record<string, string>>({});
const noticeScope = computed(() => JSON.stringify([...props.rooms].sort()));
// Ages advance between refreshes; the clock starts only in a mounted view.
const now = useNow(30_000);
// Loading issues follow the room filter; rental requests belong to no room.
const failedRooms = computed(() => inboxSourceFailures(props.data, props.rooms));
const rentalErrorInView = computed(() => props.rooms.length ? '' : props.rentalError);
const hasSourceFailure = computed(() => Boolean(failedRooms.value.length || unavailable.value.length || rentalErrorInView.value || props.data?.cloudUnavailable));
const sourceFailures = computed(() => [
  ...(failedRooms.value.length ? [`Couldn’t load all inbox data for ${failedRooms.value.map(room => room.displayName).sort().join(', ')}.`] : []),
  ...(unavailable.value.length ? [`Some updates are unavailable: ${unavailable.value.join('; ')}.`] : []),
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
  if (window.matchMedia?.('(max-width: 700px)').matches) void nextTick(() => requestHeading.value?.focus({ preventScroll: true }));
}
const selectedKey = ref(''); const drafts = reactive<Record<string, string>>({}); const sending = ref(false); const sendError = ref('');
const dismissals = ref<Record<string, string>>({}); const lastRead = ref<InboxReadChange[]>([]); const loadingOlder = ref(false);
let alive = true;
// An answer sent from here moves its request to Answered before the next refresh confirms it.
const sentAnswers = ref<Record<string, KnowledgeRecord>>({});
// An empty response means the board write has not yet been confirmed.
type TaskAcceptance = { response: string; task: DesktopAttentionTask };
const acceptedTasks = ref<Record<string, TaskAcceptance>>({});
const acceptanceStorageKey = (account: string) => `letagents-desktop:inbox-task-acceptances:${account}`;
function readTaskAcceptances(account: string): Record<string, TaskAcceptance> {
  try {
    const saved = JSON.parse(window.localStorage.getItem(acceptanceStorageKey(account)) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, TaskAcceptance] => {
      const value = entry[1] as TaskAcceptance | null;
      return typeof value?.response === 'string' && /^task_[1-9]\d*$/.test(value.task?.id ?? '') && typeof value.task?.title === 'string';
    }));
  } catch { return {}; }
}
function saveTaskAcceptance(account: string, key: string, value: TaskAcceptance | null) {
  try {
    const pending = readTaskAcceptances(account);
    if (value) pending[key] = value; else delete pending[key];
    window.localStorage.setItem(acceptanceStorageKey(account), JSON.stringify(pending));
  } catch { /* The current view still offers retry without storage. */ }
}
function acceptedTaskFor(item: UniversalInboxItem): TaskAcceptance | undefined {
  const accepted = acceptedTasks.value[item.key];
  return accepted?.response && (item.record || item.timestamp === accepted.task.updated_at) ? accepted : undefined;
}
const allItems = computed(() => buildUniversalInbox(props.data, props.rentals, props.attention, props.joinRequests).map(item => {
  const record = sentAnswers.value[item.key];
  if (acceptedTasks.value[item.key] && item.record && !item.record.response) item = { ...item, approvalTask: acceptedTasks.value[item.key]!.task };
  if (acceptedTaskFor(item) && !item.record && item.category === 'proposed') return { ...item, section: 'updates' as const, category: 'accepted' };
  return record && item.record && record.version > item.record.version
    ? { ...item, record, section: 'answered' as const, category: attentionRecordCategory(record), timestamp: record.response?.at || item.timestamp, fingerprint: String(record.version) } : item;
}).sort(compareUniversalInboxItems));
// Provider artwork comes from structured agent metadata, never from a display name.
const avatars = computed(() => new Map(allItems.value.map(item => {
  const attention = item.attention;
  const presence = props.data?.rooms.find(room => room.roomIdentifier === item.roomIdentifier)?.updates?.presence;
  const author = item.record?.author;
  const agent = author?.kind === 'agent' ? presence?.find(entry => entry.agentKey === author.id || entry.agentSessionId === author.id) : undefined;
  const supervised = author?.kind === 'agent' ? props.data?.agents?.find(entry => entry.roomId === item.roomIdentifier && (entry.agentKey === author.id || entry.agentSessionId === author.id)) : undefined;
  const threadMessage = item.activity?.kind === 'thread' ? item.activity.summary.latestReply || item.activity.root : undefined;
  const identity = threadMessage?.agentIdentity;
  const activityKey = item.activity?.kind === 'agent_blocked' ? item.activity.session.agentKey : identity?.agentKey;
  const activityPresence = activityKey ? presence?.find(entry => entry.agentKey === activityKey) : undefined;
  const provider = attention?.kind === 'tool_approval' ? attention.approval.presentation.provider
    : attention?.kind === 'agent_attention' ? attention.entry.provider
    : item.activity?.kind === 'agent_offline' ? item.activity.presence.runtime
    : identity?.ideLabel || activityPresence?.runtime || supervised?.provider || agent?.runtime;
  return [item.key, { agent: Boolean(provider || identity || author?.kind === 'agent'), provider,
    agentKey: activityKey || supervised?.agentKey || agent?.agentKey, avatarUrl: item.joinRequest?.avatar_url }];
})));
function selectKey(key: string) { const item = items.value.find(item => item.key === key); if (item) selectItem(item); }
// The list as last displayed. Arrivals join around the selected row instead of
// reshuffling it; a new section, room filter or account starts from the usual order.
let shown: { scope: string; items: UniversalInboxItem[] } = { scope: '', items: [] };
const items = computed(() => {
  const scope = JSON.stringify([props.storageKey, props.section, [...props.rooms].sort(), query.value]);
  const needle = query.value.trim().toLocaleLowerCase();
  const sorted = filterUniversalInbox(allItems.value, props.section, props.rooms, dismissals.value).filter(item => !needle || [item.title, item.body, item.actor, item.roomName].some(value => value.toLocaleLowerCase().includes(needle)));
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
const roomOptions = computed(() => sortedRooms.value.map(room => ({ id: room.roomIdentifier, label: room.displayName })));
const counts = computed(() => Object.fromEntries(['needs-you', 'updates', 'answered'].map(section => [section, count(section as InboxSection)])) as Record<InboxSection, number>);
const unavailable = computed(() => (props.data?.rooms ?? []).filter(room => !props.rooms.length || props.rooms.includes(room.roomIdentifier)).flatMap(room => room.updates?.unavailable.length ? [`${room.displayName} (${[...room.updates.unavailable].sort().join(', ')})`] : []).sort());
const roomsWithMoreThreads = computed(() => (props.data?.rooms ?? []).filter(room => room.updates?.threads.hasMore && (!props.rooms.length || props.rooms.includes(room.roomIdentifier))));
const hiddenByFilter = computed(() => props.rooms.length ? filterUniversalInbox(allItems.value, props.section, [], dismissals.value).length - filterUniversalInbox(allItems.value, props.section, props.rooms, dismissals.value).length : 0);
// Updates load only while the Inbox is open. Until they arrive, the Updates list holds task rows only, so its count is not shown.
const updatesLoaded = computed(() => Boolean(props.data?.updatesIncluded));
const emptyTitle = computed(() => props.loading ? 'Checking your rooms' : query.value.trim() ? 'No matching items' : hiddenByFilter.value ? 'Nothing here in the selected rooms' : props.section === 'updates' ? updatesLoaded.value ? 'No unread updates to show' : 'Updates aren’t loaded' : props.error || hasSourceFailure.value ? 'Some inbox data is unavailable' : props.section === 'answered' ? 'No answers here yet' : 'You’re clear for now');
const emptyDescription = computed(() => query.value.trim() ? 'Try another search or clear the filters.' : props.section === 'answered' ? 'Answered requests will appear here.' : props.section === 'updates' && !updatesLoaded.value ? props.loading ? 'Gathering replies, checks and agent activity.' : 'Refresh to load replies, checks and agent activity.' : props.section === 'updates' ? props.error || hasSourceFailure.value ? 'New activity will appear here. Some room data is still unavailable.' : 'Room updates will appear here as work progresses.' : 'Questions, decisions and approvals will appear when someone asks for your input.');
function count(section: InboxSection) { return filterUniversalInbox(allItems.value, section, props.rooms, dismissals.value).length; }
watch(() => selected.value?.key, () => { sendError.value = ''; });
watch([() => props.section, () => props.rooms], () => { outcome.value = null; });
// Moving to another item or section, or filtering its room out, lets the decided item go.
watch([selectedKey, () => props.section, () => props.rooms], () => {
  const item = decided.value;
  if (item && (item.key !== selectedKey.value || (props.rooms.length && !props.rooms.includes(item.roomIdentifier ?? '')))) decided.value = null;
});
watch(() => props.storageKey, () => {
  query.value = ''; dismissals.value = {}; lastRead.value = []; dismissedSourceNotices.value = {}; selectedKey.value = ''; sendError.value = ''; outcome.value = null; sentAnswers.value = {}; acceptedTasks.value = readTaskAcceptances(props.storageKey); sending.value = false; decided.value = null;
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
function markRead(updates: UniversalInboxItem[]) { const result = markInboxUpdatesRead(updates, dismissals.value); if (!result.changes.length) return; dismissals.value = result.dismissals; lastRead.value = result.changes; persistDismissals(); void nextTick(() => layout.value?.focusHeading()); }
function undoRead() { dismissals.value = undoInboxRead(lastRead.value, dismissals.value); lastRead.value = []; persistDismissals(); void nextTick(() => layout.value?.focusHeading()); }
onBeforeUnmount(() => { alive = false; clearTimeout(settleTimer); });
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
// A decided join request with no request after it stays open with its result.
const joinDecision = ref<{ key: string; label: string } | null>(null);
async function decideJoinRequest(decision: 'approve' | 'decline') {
  const item = selected.value; const request = item?.joinRequest;
  if (!item || !request || sending.value) return;
  const list = items.value;
  selectedKey.value = item.key; decided.value = item; outcome.value = null; sending.value = true; sendError.value = '';
  try {
    const result = await roomJoinRequests.decide(request, decision);
    if (!alive) return;
    if (!result.ok && result.code !== 'ROOM_JOIN_REQUEST_NOT_PENDING') { sendError.value = result.message || 'Unable to record your decision.'; decided.value = null; return; }
    const label = !result.ok ? 'Another admin already decided' : decision === 'approve' ? 'Approved' : 'Declined';
    if (!moveOnFrom(item, list, label, true)) joinDecision.value = { key: item.key, label };
    void nextTick(() => requestHeading.value?.focus({ preventScroll: true }));
  } catch (error) { if (alive) { sendError.value = error instanceof Error ? error.message : 'Unable to record your decision.'; decided.value = null; } }
  finally { if (alive) sending.value = false; }
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
  const item = selected.value; if (!item?.record || !item.roomIdentifier || sending.value || !drafts[item.key]?.trim()) return;
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
    emit('update:section', 'answered'); void nextTick(() => layout.value?.focusHeading());
  } catch (error) { if (alive) sendError.value = error instanceof Error ? error.message : 'Unable to send your response.'; }
  finally { if (alive) sending.value = false; }
}

async function acceptTask() {
  const item = selected.value;
  if (!item?.roomIdentifier || !item.approvalTask || sending.value) return;
  const account = props.storageKey;
  const acceptances = acceptedTasks.value;
  const list = items.value;
  selectedKey.value = item.key; decided.value = item;
  sending.value = true; sendError.value = '';
  try {
    const revise = desktopIpc.room.reviseKnowledge;
    if (!desktopIpc.auth?.getStatus || !desktopIpc.room.getSnapshot || (item.record && !revise)) throw new Error(desktopBridgeUpgradeMessage());
    if (!acceptedTaskFor(item)) {
      const room = item.roomIdentifier; const proposed = item.approvalTask;
      const reconcile = async () => {
        const auth = await desktopIpc.auth.getStatus();
        if (String(auth.account?.id ?? 'local') !== account) throw new Error('Return to the account that accepted this task to save its answer.');
        const snapshot = await desktopIpc.room.getSnapshot(room, { create: false });
        const task = snapshot.tasks.find(task => task.id === proposed.id);
        if (!task || task.title !== proposed.title || (task.description || '') !== (proposed.description || '')) throw new Error('Refresh to review the current task before accepting it.');
        if (task.status === 'proposed') return null;
        if (['accepted', 'assigned', 'in_progress', 'blocked', 'in_review', 'merged', 'done'].includes(task.status)) return task;
        throw new Error('The task was not accepted. Refresh to see its current state.');
      };
      // Save the attempt before the write: a lost response must remain retryable
      // even after the accepted task disappears from the attention feed.
      let task = acceptances[item.key]?.response === '' ? await reconcile() : null;
      if (!task) {
        acceptances[item.key] = { response: '', task: { ...proposed } };
        if (item.record) saveTaskAcceptance(account, item.key, acceptances[item.key]!);
        try {
          const result = await desktopIpc.room.updateTask(room, proposed.id, { status: 'accepted' });
          if (!result.task || result.task.id !== proposed.id || result.task.status !== 'accepted') throw new Error('The task was not accepted. Refresh to see its current state.');
          task = result.task;
        } catch (error) {
          task = await reconcile();
          if (!task) throw error;
        }
      }
      acceptances[item.key] = { response: `Accepted ${task.id}: ${task.title}.`, task: { ...proposed } };
      if (item.record) saveTaskAcceptance(account, item.key, acceptances[item.key]!);
    }
    if (item.record && revise) {
      // Navigation must not cancel the second half of an accepted decision.
      // Check the live main-process account, since unmounted props stop updating.
      const auth = await desktopIpc.auth.getStatus();
      if (String(auth.account?.id ?? 'local') !== account) throw new Error('Return to the account that accepted this task to save its answer.');
      const answered = await revise(item.roomIdentifier, 'attention', item.record.id, {
        expected_version: item.record.version, response: acceptances[item.key]!.response,
      });
      saveTaskAcceptance(account, item.key, null);
      if (!alive || account !== props.storageKey) return;
      sentAnswers.value = { ...sentAnswers.value, [item.key]: answered };
      delete drafts[item.key];
    }
    if (!alive || account !== props.storageKey) return;
    emit('refresh');
    if (selectedKey.value !== item.key) return;
    if (!moveOnFrom(item, list, 'Task accepted', true) && item.record) {
      decided.value = null; emit('update:section', 'answered');
    }
    void nextTick(() => requestHeading.value?.focus({ preventScroll: true }));
  } catch (error) {
    if (alive && account === props.storageKey) {
      const detail = error instanceof Error ? error.message : 'Please retry.';
      sendError.value = acceptedTaskFor(item) ? `Task accepted, but the inbox answer could not be saved. ${detail}` : detail;
    }
  } finally { if (alive && account === props.storageKey) sending.value = false; }
}
/** Close the selected request without a decision. A draft response is not sent. */
async function closeRequest() {
  const item = selected.value; if (!item?.record || !item.roomIdentifier || sending.value) return;
  sending.value = true; sendError.value = '';
  try {
    if (!desktopIpc.room.reviseKnowledge) throw new Error(desktopBridgeUpgradeMessage());
    const list = items.value;
    const closed = await desktopIpc.room.reviseKnowledge(item.roomIdentifier, 'attention', item.record.id, { expected_version: item.record.version, close: true });
    if (!alive) return;
    delete drafts[item.key];
    if (closed?.response) sentAnswers.value = { ...sentAnswers.value, [item.key]: closed };
    emit('refresh');
    if (selectedKey.value !== item.key) return; // Moved on while it was closing.
    if (moveOnFrom(item, list, 'Closed', true)) { void nextTick(() => requestHeading.value?.focus({ preventScroll: true })); return; }
    emit('update:section', 'answered'); void nextTick(() => layout.value?.focusHeading());
  } catch (error) { if (alive) sendError.value = error instanceof Error ? error.message : 'Unable to close this request.'; }
  finally { if (alive) sending.value = false; }
}
</script>
