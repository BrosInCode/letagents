<template>
  <section class="my-work-view" aria-label="My work" data-testid="my-work-view">
    <header class="my-work-toolbar">
      <div class="my-work-filters">
        <label v-if="trackerOptions.length" class="my-work-filter">
          <span>Tracker</span>
          <select v-model="filters.tracker" data-testid="my-work-filter-tracker">
            <option v-for="option in trackerOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </label>
        <label class="my-work-filter">
          <span>Room</span>
          <select v-model="filters.roomId" data-testid="my-work-filter-room">
            <option value="">All rooms</option>
            <option v-for="option in roomOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
          </select>
        </label>
        <label class="my-work-filter my-work-filter-check">
          <input v-model="filters.needsMe" type="checkbox" data-testid="my-work-filter-needs-me">
          <span>Needs me</span>
        </label>
      </div>
      <button type="button" class="ghost-button" :disabled="loading" data-testid="my-work-refresh" @click="reload()">
        {{ loading ? "Refreshing…" : "Refresh" }}
      </button>
    </header>

    <p v-if="error" class="my-work-error" role="alert">{{ error }}</p>
    <p v-if="page && !page.has_connections" class="my-work-hint" data-testid="my-work-zero-connector">
      Cards assigned to you or your agents. Connect Jira or Linear in Settings → Ticket trackers to add your tickets.
    </p>

    <p v-if="!loading && page && !cards.length" class="my-work-empty" data-testid="my-work-empty">
      {{ nextCursor
        ? "Nothing in the cards read so far. Load more to look further."
        : filters.needsMe ? "Nothing needs you right now." : "No work is assigned to you." }}
    </p>

    <table v-if="cards.length" class="my-work-table" data-testid="my-work-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column.id" scope="col" :data-column="column.id">{{ column.label }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="card in cards" :key="myWorkCardKey(card)">
          <tr
            class="my-work-row"
            tabindex="0"
            :aria-expanded="selectedKey === myWorkCardKey(card)"
            :data-needs-me="card.needs_me"
            data-testid="my-work-row"
            @click="toggle(card)"
            @keydown.enter.prevent="toggle(card)"
            @keydown.space.prevent="toggle(card)"
          >
            <td data-column="ticket">
              <div class="my-work-ticket">
                <span v-if="card.needs_me" class="my-work-needs-me-dot" :title="card.needs_me_reasons.map(needsMeLabel).join('. ')" aria-label="Needs you"></span>
                <template v-if="ticketRefParts(card.external_ref)">
                  <span class="desktop-task-provider-chip">{{ ticketRefParts(card.external_ref)!.providerLabel }}</span>
                  <strong>{{ card.key }}</strong>
                </template>
                <strong v-else>{{ shortTaskId(card.task_id) }}</strong>
              </div>
              <div class="my-work-title">{{ card.title }}</div>
              <small class="my-work-muted">{{ card.room_name }}</small>
            </td>
            <td v-if="page?.has_connections" data-column="ticket-state">
              <span v-if="card.ticket_state" class="desktop-task-ticket-state" :data-ticket-state="card.ticket_state">{{ ticketStateLabel(card.ticket_state) }}</span>
              <span v-else class="my-work-muted">—</span>
            </td>
            <td data-column="agent">
              <span class="desktop-task-status-badge" :data-status="card.work_state">{{ readableStatus(card.work_state) }}</span>
              <div v-if="card.agent" class="my-work-agent">{{ compactPerson(card.agent.label) || card.agent.label }}</div>
              <small v-if="card.agent?.status_text" class="my-work-muted my-work-status">{{ card.agent.status_text }}</small>
              <small v-if="card.threads.count" class="my-work-muted">
                {{ card.threads.count }} {{ card.threads.count === 1 ? "thread message" : "thread messages" }}<template v-if="card.threads.last_activity_at"> · {{ relativeTime(card.threads.last_activity_at, now) }}</template>
              </small>
            </td>
            <td data-column="pr">
              <template v-if="primaryPullRequest(card)">
                <div>{{ pullRequestLabel(primaryPullRequest(card)!) }} · {{ pullRequestStateLabel(primaryPullRequest(card)!) }}</div>
                <small v-if="reviewSummaryLabel(primaryPullRequest(card)!)" class="my-work-muted">{{ reviewSummaryLabel(primaryPullRequest(card)!) }}</small>
                <small v-if="checkSummaryLabel(primaryPullRequest(card)!)" class="my-work-muted">{{ checkSummaryLabel(primaryPullRequest(card)!) }}</small>
              </template>
              <span v-else class="my-work-muted">—</span>
            </td>
          </tr>
          <tr v-if="selectedKey === myWorkCardKey(card)" class="my-work-detail-row">
            <td :colspan="columns.length">
              <TicketDetailPanel
                :card="card"
                :has-connections="Boolean(page?.has_connections)"
                @close="selectedKey = null"
                @open-card="emit('open-card', $event.room_id, $event.task_id)"
                @open-thread="(target, threadRootId) => emit('open-thread', target.room_id, threadRootId)"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <button v-if="nextCursor" type="button" class="ghost-button my-work-more" :disabled="loading" data-testid="my-work-more" @click="loadMore()">
      {{ loading ? "Loading…" : "Load more" }}
    </button>
  </section>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, reactive, ref, toRaw, watch } from "vue";
import type { MyWorkCard, MyWorkPage } from "../../../../../../../shared/ticket-connectors.mjs";
import { desktopBridgeUpgradeMessage, desktopIpc } from "../../../ipc/index.js";
import { useNow } from "../../../composables/useNow";
import { reuseUnchanged } from "../../../domain/reuse-unchanged";
import TicketDetailPanel from "./my-work/TicketDetailPanel.vue";
import {
  checkSummaryLabel,
  myWorkCardKey,
  myWorkColumns,
  myWorkRefreshDelay,
  myWorkRoomOptions,
  myWorkTrackerOptions,
  needsMeLabel,
  primaryPullRequest,
  pullRequestLabel,
  pullRequestStateLabel,
  reviewSummaryLabel,
  roomsWithChangedTasks,
  type MyWorkFilters,
} from "./my-work/my-work-presentation";
import { compactPerson, readableStatus, relativeTime, shortTaskId } from "./room-board/formatters";
import { ticketRefParts, ticketStateLabel } from "./room-board/ticket-ref";

const PAGE_SIZE = 50;

const props = defineProps<{
  /** Per room, when its cards last changed (account activity stream); a moved stamp re-reads the page. */
  tasksChangedAt: Readonly<Record<string, string | null>>;
  /** Whether the account activity stream is open. */
  connected: boolean;
}>();

const emit = defineEmits<{
  "open-card": [roomId: string, taskId: string];
  "open-thread": [roomId: string, threadRootId: string];
}>();

const now = useNow(30_000);
const page = ref<MyWorkPage | null>(null);
const cards = ref<MyWorkCard[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const selectedKey = ref<string | null>(null);
const filters = reactive<MyWorkFilters>({ tracker: "", roomId: "", needsMe: false });

const columns = computed(() => myWorkColumns(page.value));
const trackerOptions = computed(() => myWorkTrackerOptions(page.value));
// Rooms seen in any read stay in the list, so a room filter can switch to another room directly.
const knownRooms = reactive(new Map<string, string>());
watch(cards, (list) => { for (const card of list) knownRooms.set(card.room_id, card.room_name); });
const roomOptions = computed(() => myWorkRoomOptions(
  [...knownRooms].map(([room_id, room_name]) => ({ room_id, room_name })),
  filters.roomId,
));

let generation = 0;
let lastReadAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerDueAt = 0;

function query(cursor: string | null, limit: number) {
  return {
    cursor,
    limit,
    tracker: filters.tracker || null,
    roomId: filters.roomId || null,
    needsMe: filters.needsMe,
  };
}

/** Reads the first page again, as many cards as are loaded (at most 100). */
async function reload(): Promise<void> {
  const current = ++generation;
  loading.value = true;
  lastReadAt = Date.now();
  try {
    const read = desktopIpc.room?.getMyWork;
    if (!read) throw new Error(desktopBridgeUpgradeMessage());
    const next = await read(query(null, Math.min(Math.max(cards.value.length, PAGE_SIZE), 100)));
    if (current !== generation) return;
    page.value = next;
    // A read that found nothing new keeps every row, so the table does not re-render.
    cards.value = reuseUnchanged(toRaw(cards.value), next.cards);
    nextCursor.value = next.next_cursor;
    error.value = "";
    if (selectedKey.value && !next.cards.some((card) => myWorkCardKey(card) === selectedKey.value)) selectedKey.value = null;
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : "My work could not be loaded.";
  } finally {
    if (current === generation) loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  const cursor = nextCursor.value;
  const read = desktopIpc.room?.getMyWork;
  if (!cursor || !read || loading.value) return;
  const current = ++generation;
  loading.value = true;
  try {
    const next = await read(query(cursor, PAGE_SIZE));
    if (current !== generation) return;
    const seen = new Set(cards.value.map(myWorkCardKey));
    cards.value = [...cards.value, ...next.cards.filter((card) => !seen.has(myWorkCardKey(card)))];
    nextCursor.value = next.next_cursor;
    error.value = "";
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : "More work could not be loaded.";
  } finally {
    if (current === generation) loading.value = false;
  }
}

function toggle(card: MyWorkCard): void {
  const key = myWorkCardKey(card);
  selectedKey.value = selectedKey.value === key ? null : key;
}

/**
 * One re-read for a burst of changes: soon when a changed room holds a loaded
 * card, else after the long gap. A sooner need moves a waiting timer earlier.
 */
function scheduleReload(changedRooms: readonly string[]): void {
  const loadedRooms = new Set(cards.value.map((card) => card.room_id));
  const wait = myWorkRefreshDelay(changedRooms, loadedRooms, lastReadAt, Date.now());
  const dueAt = Date.now() + wait;
  if (timer && timerDueAt <= dueAt) return;
  if (timer) clearTimeout(timer);
  timerDueAt = dueAt;
  timer = setTimeout(() => {
    timer = null;
    void reload();
  }, wait);
}

// The page exists only while it is open, so changes are read only then.
watch(() => props.tasksChangedAt, (stamps, previous) => {
  const changed = roomsWithChangedTasks(stamps, previous);
  if (changed.length) scheduleReload(changed);
});
// A stream that reconnects may have missed changes in rooms with loaded cards.
watch(() => props.connected, (connected, was) => {
  if (connected && was === false) scheduleReload(cards.value.map((card) => card.room_id));
});
watch(() => [filters.tracker, filters.roomId, filters.needsMe], () => {
  cards.value = [];
  nextCursor.value = null;
  selectedKey.value = null;
  void reload();
});

void reload();

onScopeDispose(() => { if (timer) clearTimeout(timer); });
</script>

<style scoped>
.my-work-view { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; overflow: auto; min-height: 0; }
.my-work-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.my-work-filters { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.my-work-filter { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
.my-work-filter-check { cursor: pointer; }
.my-work-hint, .my-work-empty { margin: 0; color: var(--text-secondary); font-size: 13px; }
.my-work-error { margin: 0; color: var(--danger, #f85149); font-size: 13px; }
.my-work-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.my-work-table th { padding: 6px 8px; text-align: left; font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border-strong); }
.my-work-table td { padding: 8px; vertical-align: top; border-bottom: 1px solid var(--border-subtle, var(--border-strong)); }
.my-work-table td small { display: block; }
.my-work-row { cursor: pointer; }
.my-work-row:hover, .my-work-row[aria-expanded="true"] { background: var(--surface-hover, rgba(127, 127, 127, 0.08)); }
.my-work-row:focus-visible { outline: 2px solid var(--accent, #58a6ff); outline-offset: -2px; }
.my-work-ticket { display: inline-flex; align-items: center; gap: 6px; }
.my-work-title { margin-top: 2px; }
.my-work-muted { color: var(--text-secondary); }
.my-work-status { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.my-work-agent { margin-top: 4px; }
.my-work-needs-me-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--warning, #d29922); flex: none; }
.my-work-detail-row > td { padding: 0; }
.my-work-more { align-self: center; }
</style>
