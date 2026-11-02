<template>
  <div class="person-work-layer">
    <button class="person-work-scrim" type="button" aria-label="Close work panel" @click="emit('close', $event.detail === 0)"></button>
    <aside ref="panelElement" class="person-work-panel" role="dialog" aria-modal="true" aria-labelledby="person-work-title" tabindex="-1">
      <header class="person-work-header">
        <span class="person-work-avatar" aria-hidden="true">
          <img v-if="target.avatarUrl" :src="target.avatarUrl" alt="" />
          <span v-else>{{ initials }}</span>
        </span>
        <div class="person-work-identity">
          <p v-if="isViewer" class="person-work-eyebrow">Your work</p>
          <h2 id="person-work-title">{{ target.displayName || target.login }}</h2>
          <p class="person-work-login">@{{ target.login }}<span v-if="repositoryLabel"> · {{ repositoryLabel }}</span></p>
        </div>
        <button class="person-work-close" type="button" aria-label="Close work panel" @click="emit('close', $event.detail === 0)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg></button>
      </header>

      <div class="person-work-body">
        <p v-if="loading" class="person-work-status" role="status">Loading pull requests…</p>
        <div v-else-if="error" class="person-work-error" role="alert"><p>{{ error }}</p><button type="button" @click="loadWork">Try again</button></div>
        <p v-if="actionError" class="person-work-error" role="alert">{{ actionError }}</p>
        <p v-if="truncated" class="person-work-status" role="note">{{ truncationNotice }}</p>
        <p v-if="tasksUnavailable" class="person-work-status" role="status">Board task links are currently unavailable.</p>
        <p v-if="!loading && !error && !work.openPrs.length" class="person-work-status">No open pull requests recorded in the last {{ PERSON_WORK_LOOKBACK_DAYS }} days.</p>

        <DisclosurePanel v-for="section in visibleSections" :key="section.key" class="person-work-section"
          :open="openSections[section.key]" @toggle="openSections[section.key] = !openSections[section.key]">
          <template #summary><h3>{{ section.title }} <span class="person-work-count">{{ section.rows.length }}</span></h3></template>
          <ul class="person-work-list">
            <li v-for="row in section.rows" :key="row.prUrl" class="person-work-row">
              <a class="person-work-pr" :href="row.prUrl" @click.prevent="openPullRequest(row)">
                <span class="person-work-pr-title">{{ row.title || 'Untitled pull request' }}</span>
                <span v-if="row.prNumber !== null" class="person-work-pr-number">#{{ row.prNumber }}</span>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
              </a>
              <p class="person-work-row-meta">
                <span v-if="section.key !== 'open' && section.key !== 'draft'">{{ stateLabel(row.state) }}</span>
                <span v-if="row.note">{{ row.note }}</span>
                <time :datetime="row.updatedAt">{{ formatRelativeTime(row.updatedAt) }}</time>
              </p>
              <div v-for="task in tasksByPr.get(row.prUrl) || []" :key="task.id" class="person-work-task">
                <a v-if="ticketLink(task)" :href="ticketLink(task)" class="person-work-ticket" @click.prevent="openTicket(task)">
                  {{ ticketRefParts(task.externalRef)?.providerLabel }} {{ ticketRefParts(task.externalRef)?.key }}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
                </a>
                <button v-else type="button" class="person-work-board" @click="emit('open-task', task.id)">
                  <span>{{ task.id.replace(/^task_/, 'T') }}</span> {{ task.title }}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                </button>
              </div>
            </li>
          </ul>
        </DisclosurePanel>
      </div>
      <footer class="person-work-footer"><span>Recorded GitHub activity · last {{ PERSON_WORK_LOOKBACK_DAYS }} days</span><button type="button" :disabled="loading" @click="loadWork">Refresh</button></footer>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch } from "vue";
import { trapFocusInDialog } from "./modal-focus";
import type { PersonTarget } from "../../../domain/person-target";
import {
  buildPersonWork,
  personWorkTasks,
  loadRoomEventsOfType,
  PERSON_WORK_EVENT_LIMIT,
  PERSON_WORK_LOOKBACK_DAYS,
  PERSON_WORK_PAGE_LIMIT,
  type PersonWorkEvent,
  type PersonWorkRow,
  type PersonWorkTask,
} from "../../../domain/person-work";
import type { PersonWorkServices } from "../../../domain/person-work-services";
import { loginInitials } from "../../../domain/initials";
import { formatRelativeTime } from "../../../domain/time";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import DisclosurePanel from "../../../../../../../shared/ui/DisclosurePanel.vue";
import { safeWorkUrl } from "../../../../../../../shared/ui/my-work/model";
import { ticketRefParts } from "./room-board/ticket-ref";

type PersonWorkEventType = "pull_request" | "pull_request_review";

const DAY_MS = 24 * 60 * 60 * 1000;

const props = defineProps<{
  target: PersonTarget;
  roomId: string;
  viewerLogin: string | null;
  tasks?: PersonWorkTask[];
  tasksUnavailable?: boolean;
  services: PersonWorkServices;
}>();

const services = props.services;

const emit = defineEmits<{
  close: [instant?: boolean];
  "open-task": [taskId: string];
}>();

const panelElement = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const truncated = ref(false);
const truncationNotice = `Showing the latest ${PERSON_WORK_EVENT_LIMIT} events for each type.`;
const events = ref<PersonWorkEvent[]>([]);
const loadedAt = ref(new Date());
const eventRoomId = ref<string | null>(null);
const repositoryLabel = computed(() => {
  const repository = events.value.map(event => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//i.exec(event.githubObjectUrl || "")?.[1]).find(Boolean);
  const scope = eventRoomId.value || props.roomId;
  return repository || (scope.startsWith("github.com/") ? scope.slice(11) : "");
});
const tickets = ref<Record<string, Awaited<ReturnType<PersonWorkServices["getTicket"]>>>>({});
let ticketRequest = 0;
const openSections = reactive<Record<string, boolean>>({ open: true, draft: true, review: true, reviewed: false, merged: false });
let requestToken = 0;
let previousFocus: HTMLElement | null = null;

const work = computed(() => buildPersonWork(events.value, props.target.login, loadedAt.value));
const initials = computed(() => loginInitials(props.target.login));
const isViewer = computed(() => {
  const viewer = (props.viewerLogin ?? "").trim().toLowerCase();
  return viewer.length > 0 && viewer === props.target.login.trim().toLowerCase();
});

const sections = computed(() => [
  { key: "open", title: "Open PRs", rows: work.value.openPrs.filter(row => row.state === "open") },
  { key: "draft", title: "Draft PRs", rows: work.value.openPrs.filter(row => row.state === "draft") },
  { key: "review", title: isViewer.value ? "Needs your review" : "Needs their review", rows: work.value.needsTheirReview },
  { key: "reviewed", title: "Reviews given", rows: work.value.reviewed },
  { key: "merged", title: "Merged in the last 24 hours", rows: work.value.mergedRecently },
]);
const visibleSections = computed(() => sections.value.filter(section => section.rows.length));
const tasksByPr = computed(() => new Map(sections.value.flatMap(section => section.rows).map(row => [
  row.prUrl, props.tasksUnavailable ? [] : personWorkTasks(row, events.value, props.tasks || [], props.roomId),
])));
const linkedTickets = computed(() => [...new Map([...tasksByPr.value.values()].flat()
  .filter(task => task.externalRef && task.ticketState).map(task => [task.id, task])).values()]);
// Board snapshots replace task objects even when their ticket identities are unchanged.
// Watch those identities so ordinary refreshes keep links (and keyboard focus) in place.
watch(() => JSON.stringify([props.roomId, linkedTickets.value.map(task => [task.id, task.externalRef]).sort()]), async () => {
  const tasks = linkedTickets.value;
  const request = ++ticketRequest;
  const roomId = props.roomId;
  tickets.value = {};
  const loaded = await Promise.all(tasks.map(async task => {
    try { return [task.id, await services.getTicket(roomId, task.id)] as const; }
    catch { return [task.id, null] as const; }
  }));
  if (request === ticketRequest && roomId === props.roomId) tickets.value = Object.fromEntries(loaded);
});
function ticketLink(task: PersonWorkTask): string | undefined {
  const ticket = tickets.value[task.id];
  return ticket && ticket.externalRef === task.externalRef ? safeWorkUrl(ticket.url) : undefined;
}
async function openTicket(task: PersonWorkTask): Promise<void> {
  const url = ticketLink(task);
  if (!url) return;
  actionError.value = null;
  try { await services.openExternalUrl(url); }
  catch { actionError.value = "The ticket could not be opened."; }
}

watch(() => [props.roomId, props.target.login], () => {
  void loadWork();
});

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.addEventListener("keydown", handleKeydown, true);
  panelElement.value?.focus({ preventScroll: true });
  void loadWork();
});

// The panel is teleported to body. Leaving a kept-alive room view must close it.
onDeactivated(() => emit("close", true));

onBeforeUnmount(() => {
  requestToken += 1;
  ticketRequest += 1;
  document.removeEventListener("keydown", handleKeydown, true);
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
});

async function loadWork(): Promise<void> {
  const token = ++requestToken;
  const roomId = props.roomId;
  loading.value = true;
  error.value = null;
  actionError.value = null;
  truncated.value = false;
  events.value = [];
  eventRoomId.value = null;
  try {
    const since = new Date(Date.now() - PERSON_WORK_LOOKBACK_DAYS * DAY_MS).toISOString();
    const [pullRequests, reviews] = await Promise.all([
      loadEventsOfType(roomId, "pull_request", since),
      loadEventsOfType(roomId, "pull_request_review", since),
    ]);
    if (token !== requestToken) return;
    loadedAt.value = new Date();
    truncated.value = pullRequests.truncated || reviews.truncated;
    events.value = [...pullRequests.events, ...reviews.events];
    eventRoomId.value = pullRequests.roomId || reviews.roomId;
  } catch (caught) {
    if (token !== requestToken) return;
    error.value = safeUserVisibleErrorDetail(caught, "GitHub work could not be loaded.");
  } finally {
    if (token === requestToken) loading.value = false;
  }
}

async function loadEventsOfType(
  roomId: string,
  eventType: PersonWorkEventType,
  since: string,
): Promise<{ events: PersonWorkEvent[]; truncated: boolean; roomId: string | null }> {
  let sourceRoomId: string | null = null;
  const result = await loadRoomEventsOfType(
    async ({ after }) => {
      const page = await services.getEvents(roomId, {
        limit: PERSON_WORK_PAGE_LIMIT, eventType, since, after,
      });
      sourceRoomId = page.githubRoomIdentifier || page.roomIdentifier;
      return page;
    },
    { maxEvents: PERSON_WORK_EVENT_LIMIT },
  );
  // Preserve the server’s actual event scope, which may be the parent repository.
  return {
    events: result.events.map((event) => ({ ...event, roomId: sourceRoomId })),
    roomId: sourceRoomId,
    truncated: result.truncated,
  };
}

async function openPullRequest(row: PersonWorkRow): Promise<void> {
  actionError.value = null;
  try {
    await services.openExternalUrl(row.prUrl);
  } catch {
    actionError.value = "The pull request could not be opened.";
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Tab") {
    trapFocusInDialog(event, panelElement.value);
    return;
  }
  if (event.key !== "Escape") return;
  event.preventDefault();
  // One Escape press must not also close an inspector behind the panel.
  event.stopPropagation();
  emit("close", true);
}

function stateLabel(state: string): string {
  switch (state) {
    case "open": return "Open";
    case "draft": return "Draft";
    case "merged": return "Merged";
    case "closed": return "Closed";
    default: return "";
  }
}
</script>

<style scoped>
.person-work-layer { position: fixed; z-index: 120; inset: 0; overflow: clip; }
.person-work-enter-active { transition: opacity 240ms ease; }
.person-work-leave-active { transition: opacity 160ms ease; pointer-events: none; }
.person-work-enter-active .person-work-panel { transition: transform 240ms cubic-bezier(.22, 1, .36, 1); }
.person-work-leave-active .person-work-panel { transition: transform 160ms cubic-bezier(.22, 1, .36, 1); }
.person-work-enter-from, .person-work-leave-to { opacity: 0; }
.person-work-enter-from .person-work-panel { transform: translateX(20px); }
.person-work-leave-to .person-work-panel { transform: translateX(12px); }
.person-work-scrim { position: fixed; z-index: 120; inset: 0; padding: 0; border: 0; background: var(--overlay-scrim); }
.person-work-panel { position: fixed; z-index: 121; inset: 12px 12px 12px auto; width: min(540px, calc(100vw - 24px)); display: flex; flex-direction: column; box-sizing: border-box; border: 1px solid var(--border-strong); border-radius: 17px; background: var(--bg); color: var(--text); box-shadow: 0 24px 72px light-dark(#0000001f, #0000007a); overflow: hidden; }
.person-work-panel:focus { outline: none; }
.person-work-header { display: flex; align-items: center; gap: 12px; padding: 24px; border-bottom: 1px solid var(--border); }
.person-work-avatar { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; background: var(--bg-subtle); color: var(--text-secondary); font-size: .78rem; overflow: hidden; }
.person-work-avatar img { width: 100%; height: 100%; object-fit: cover; }
.person-work-identity { min-width: 0; flex: 1; }
.person-work-identity h2 { margin: 0 0 4px; font-size: 1rem; font-weight: 650; overflow-wrap: anywhere; }
.person-work-eyebrow, .person-work-login { margin: 0; color: var(--text-tertiary); font-size: .76rem; overflow-wrap: anywhere; }
.person-work-close { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 36px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.person-work-body { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; padding: 16px; }
.person-work-status { margin: 0; padding: 12px 8px; color: var(--text-secondary); font-size: .8rem; line-height: 1.5; }
.person-work-error { margin: 0; padding: 12px 8px; color: var(--red); font-size: .8rem; }
.person-work-error p { margin: 0 0 8px; }
.person-work-section { margin-bottom: 20px; --disclosure-padding: 12px 8px; }
.person-work-section:last-child { margin-bottom: 0; }
.person-work-section h3 { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--text-secondary); font-size: .78rem; font-weight: 550; }
.person-work-count { color: var(--text-tertiary); font-size: .72rem; font-variant-numeric: tabular-nums; }
.person-work-list { margin: 0; padding: 0; list-style: none; }
.person-work-row { position: relative; isolation: isolate; min-width: 0; padding: 15px 8px 14px; }
.person-work-row::before { content: ""; position: absolute; z-index: -1; inset: 6px 0; border-radius: 6px; background: transparent; transition: background-color 140ms ease; pointer-events: none; }
.person-work-pr { display: flex; align-items: baseline; gap: 10px; color: var(--text); text-decoration: none; font-size: .88rem; font-weight: 550; line-height: 1.45; }
.person-work-pr-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.person-work-pr-number { flex: 0 0 auto; color: var(--text-secondary); font-size: .88rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.person-work-pr svg { flex-shrink: 0; color: var(--text-tertiary); }
.person-work-row-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 6px 0 0; color: var(--text-tertiary); font-size: .72rem; line-height: 1.5; }
.person-work-task { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; min-width: 0; }
.person-work-ticket, .person-work-board { display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 0; border: 0; background: transparent; color: var(--text-secondary); text-align: left; font: inherit; font-size: .74rem; line-height: 1.5; text-decoration: none; cursor: pointer; overflow-wrap: anywhere; }
.person-work-board span { flex-shrink: 0; color: var(--text-tertiary); }
.person-work-task svg { flex-shrink: 0; }
.person-work-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 24px; border-top: 1px solid var(--border); color: var(--text-tertiary); font-size: .7rem; }
.person-work-footer button, .person-work-error button { padding: 5px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; cursor: pointer; }
.person-work-footer button:disabled { opacity: .5; cursor: default; }
.person-work-close { transition: background-color 140ms ease, transform 120ms ease; }
.person-work-close:active:not(:focus-visible) { transform: scale(.95); }
.person-work-footer button, .person-work-error button, .person-work-ticket, .person-work-board { transition: background-color 140ms ease, color 140ms ease; }
.person-work-pr svg, .person-work-pr-number { transition: color 140ms ease; }
a:focus-visible, button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; border-radius: 3px; }
@media (hover: hover) and (pointer: fine) {
  .person-work-row:hover::before { background: var(--bg-subtle); }
  .person-work-pr:hover svg, .person-work-pr:hover .person-work-pr-number, .person-work-ticket:hover, .person-work-board:hover { color: var(--text); }
  .person-work-pr:hover, .person-work-ticket:hover, .person-work-board:hover { text-decoration: underline; text-underline-offset: 3px; }
  .person-work-close:hover, .person-work-footer button:hover:not(:disabled) { background: var(--bg-subtle); }
}
@media (prefers-reduced-motion: reduce) {
  .person-work-enter-active, .person-work-leave-active { transition-duration: 80ms; }
  .person-work-enter-active .person-work-panel, .person-work-leave-active .person-work-panel { transition: none; transform: none; }
  .person-work-close { transition: background-color 140ms ease; }
  .person-work-close:active:not(:focus-visible) { transform: none; }
}
@media (max-width: 559px) { .person-work-panel { inset: 0; width: 100%; border: 0; border-radius: 0; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); } .person-work-header { padding: 20px; } .person-work-footer { padding: 12px 20px; } }
</style>
