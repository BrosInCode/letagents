<template>
  <section class="room-tab-page desktop-events-panel" data-testid="room-events-view">
    <div class="desktop-events-toolbar">
      <div class="desktop-events-heading">
        <span>Events</span>
        <strong>GitHub events</strong>
      </div>

      <label class="desktop-events-search" for="room-events-search">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
        </svg>
        <span class="sr-only">Search GitHub events</span>
        <input
          id="room-events-search"
          v-model="searchQuery"
          type="search"
          placeholder="Search events"
        />
      </label>

      <div class="desktop-events-toolbar-actions">
        <span v-if="currentBranch" class="desktop-events-branch-chip" title="Local Git branch">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4.5 3.25v8M4.5 11.75a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM11.5 4.25H9.75A2.75 2.75 0 0 0 7 7v2.75" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
          </svg>
          {{ currentBranch }}
        </span>

        <div class="desktop-events-overflow" @pointerdown.stop @keydown.escape.stop="overflowOpen = false">
          <button
            type="button"
            class="desktop-events-overflow-button"
            aria-label="Events actions"
            aria-haspopup="menu"
            :aria-expanded="overflowOpen"
            @click.stop="overflowOpen = !overflowOpen"
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 8h.01M8 8h.01M12 8h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            </svg>
          </button>
          <div v-if="overflowOpen" class="desktop-events-overflow-menu" role="menu">
            <button type="button" role="menuitem" :disabled="loading" @click="refreshFromMenu">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M13 3v3.5H9.5M3 13V9.5h3.5M12.25 7A4.4 4.4 0 0 0 4.8 4.6L3 6.4M3.75 9a4.4 4.4 0 0 0 7.45 2.4L13 9.6" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div class="desktop-events-filters" aria-label="GitHub event filters">
        <button
          v-for="option in filterOptions"
          :key="option.id"
          type="button"
          class="desktop-events-filter"
          :data-active="selectedFilter === option.id"
          @click="selectedFilter = option.id"
        >
          {{ option.label }}
          <small v-if="option.count > 0">{{ option.count }}</small>
        </button>
      </div>
    </div>

    <div
      v-if="linkedTaskId"
      class="desktop-events-task-filter"
      data-testid="room-events-task-filter"
    >
      <span>Showing events linked to {{ linkedTaskId }}</span>
      <button type="button" @click="emit('clearTaskFilter')">Clear</button>
    </div>

    <div v-if="loading && events.length === 0" class="desktop-events-skeleton" aria-label="Loading GitHub events">
      <span v-for="index in 6" :key="index"></span>
    </div>

    <div v-else-if="error" class="desktop-events-state" data-tone="danger" role="alert">
      <strong>Could not load GitHub events.</strong>
      <span>{{ error }}</span>
      <button type="button" @click="emit('refresh')">Retry</button>
    </div>

    <div v-else-if="showSetupState" class="desktop-events-state">
      <strong>No GitHub repository connected.</strong>
      <span>Connect GitHub to see PRs, checks, reviews, comments, and linked tasks here.</span>
      <button type="button" :disabled="githubBusy || githubLoading" @click="emit('installGithub')">
        {{ githubBusy ? "Opening..." : "Set up GitHub" }}
      </button>
      <small v-if="githubError">{{ githubError }}</small>
    </div>

    <div v-else-if="events.length === 0" class="desktop-events-state">
      <strong>No GitHub events yet.</strong>
      <span>New pull requests, checks, reviews, and comments will appear here.</span>
    </div>

    <div v-else-if="visibleEvents.length === 0" class="desktop-events-state">
      <strong>No matching events.</strong>
      <span>Try another filter or clear search.</span>
      <button type="button" @click="clearFilters">Clear filters</button>
    </div>

    <div v-else class="desktop-events-timeline">
      <div
        v-if="hiddenLowSignalCount > 0"
        class="desktop-events-low-signal"
      >
        <span>{{ hiddenLowSignalCount }} successful or skipped check{{ hiddenLowSignalCount === 1 ? "" : "s" }} hidden</span>
        <button type="button" @click="showLowSignal = true">Show</button>
      </div>

      <section
        v-for="group in groupedEvents"
        :key="group.key"
        class="desktop-events-group"
      >
        <header class="desktop-events-group-header">
          <div>
            <h3>{{ group.title }}</h3>
            <p v-if="group.subtitle">{{ group.subtitle }}</p>
          </div>
          <span>{{ group.events.length }}</span>
        </header>

        <button
          v-for="entry in group.entries"
          :key="entry.key"
          type="button"
          class="desktop-events-row"
          :data-tone="entry.event.tone"
          :data-actionable="entry.event.isActionable"
          :data-rollup="entry.hiddenCount > 0"
          @click="selectedEventId = entry.event.id"
        >
          <RoomEventIcon :kind="entry.event.kind" :tone="entry.event.tone" />
          <span class="desktop-events-row-main">
            <strong>{{ entry.event.title }}</strong>
            <span>
              <template v-if="entry.event.actor">{{ entry.event.actor }}</template>
              <template v-if="entry.event.actor && entry.event.stateLabel"> · </template>
              <template v-if="entry.event.stateLabel">{{ entry.event.stateLabel }}</template>
              <template v-if="entry.event.linkedTaskId"> · {{ entry.event.linkedTaskId }}</template>
              <template v-if="entry.hiddenCount > 0"> · {{ entry.hiddenCount }} similar update{{ entry.hiddenCount === 1 ? "" : "s" }} hidden</template>
            </span>
          </span>
          <span class="desktop-events-row-meta">
            <small v-if="isCurrentBranchEvent(entry.event, currentBranch)">Current branch</small>
            <small v-if="entry.hiddenCount > 0" class="desktop-events-row-rollup">+{{ entry.hiddenCount }}</small>
            <time :datetime="entry.event.createdAt">{{ relativeTime(entry.event.createdAt) }}</time>
          </span>
        </button>
      </section>

      <div class="desktop-events-pagination">
        <button
          v-if="hasMore"
          type="button"
          :disabled="loadingOlder"
          @click="emit('loadOlder')"
        >
          {{ loadingOlder ? "Loading..." : "Load older" }}
        </button>
        <p v-if="loadedOlderWithoutMatches">Older events loaded, but none match this filter.</p>
      </div>
    </div>

    <Transition name="desktop-events-detail-slide" appear>
      <div
        v-if="selectedEvent"
        class="desktop-events-detail-backdrop"
        role="dialog"
        aria-modal="true"
        :aria-label="`GitHub event details for ${selectedEvent.title}`"
        @click.self="closeSelectedEvent"
      >
        <aside class="desktop-events-detail">
          <button
            type="button"
            class="desktop-events-detail-close"
            aria-label="Close GitHub event details"
            @click="closeSelectedEvent"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
            </svg>
          </button>

          <header class="desktop-events-detail-hero">
            <RoomEventIcon :kind="selectedEvent.kind" :tone="selectedEvent.tone" />
            <div>
              <span>{{ selectedEvent.objectLabel || "GitHub event" }}</span>
              <h3>{{ selectedEvent.title }}</h3>
              <p v-if="selectedEvent.repository">{{ selectedEvent.repository }}</p>
            </div>
          </header>

          <div class="desktop-events-detail-chips" aria-label="Event summary">
            <span v-if="selectedEvent.stateLabel" :data-tone="selectedEvent.tone">
              {{ selectedEvent.stateLabel }}
            </span>
            <span v-if="selectedEvent.actor">by {{ selectedEvent.actor }}</span>
            <time :datetime="selectedEvent.createdAt">{{ absoluteTime(selectedEvent.createdAt) }}</time>
          </div>

          <section v-if="selectedEvent.bodyText" class="desktop-events-detail-note">
            <span>{{ bodyLabel(selectedEvent) }}</span>
            <div
              class="desktop-events-detail-markdown desktop-long-message-html"
              v-html="renderEventMarkdown(selectedEvent.bodyText)"
            />
          </section>

          <section class="desktop-events-detail-section">
            <h4>Context</h4>
            <dl class="desktop-events-detail-list">
              <div v-if="selectedEvent.branchRef">
                <dt>Branch</dt>
                <dd>{{ selectedEvent.branchRef }}</dd>
              </div>
              <div v-if="selectedEvent.commitSha">
                <dt>Commit</dt>
                <dd><code>{{ shortSha(selectedEvent.commitSha) }}</code></dd>
              </div>
              <div v-if="selectedEvent.sourceLabel">
                <dt>{{ selectedEvent.kind === "check" ? "App" : "Source" }}</dt>
                <dd>{{ selectedEvent.sourceLabel }}</dd>
              </div>
              <div>
                <dt>Task</dt>
                <dd>
                  <button
                    v-if="selectedEvent.linkedTaskId"
                    type="button"
                    @click="openLinkedTask(selectedEvent.linkedTaskId)"
                  >
                    {{ selectedEvent.linkedTaskId }}
                  </button>
                  <span v-else>Not linked</span>
                </dd>
              </div>
              <div>
                <dt>Event ID</dt>
                <dd><code>{{ compactId(selectedEvent.id) }}</code></dd>
              </div>
            </dl>
          </section>

          <div class="desktop-events-detail-actions">
            <a
              v-if="selectedEvent.url"
              :href="selectedEvent.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open on GitHub
            </a>
            <button type="button" :disabled="!selectedEvent.url" @click="copyEventUrl(selectedEvent)">
              Copy URL
            </button>
            <button type="button" @click="copyEventId(selectedEvent)">Copy event ID</button>
          </div>
        </aside>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopGitHubEventsPage,
  DesktopGitHubRoomEvent,
} from "../../../../../electron/ipc-types";
import { renderDesktopMarkdown } from "./formatting/markdown";
import RoomEventIcon from "./room-events/RoomEventIcon.vue";
import {
  buildDesktopGitHubEventFilterOptions,
  filterDesktopGitHubEventPresentations,
  groupDesktopGitHubEvents,
  isCurrentBranchEvent,
  presentDesktopGitHubEvent,
  type DesktopGitHubEventFilter,
  type DesktopGitHubEventPresentation,
} from "./room-events/presenter";

const props = defineProps<{
  roomIdentifier: string;
  eventsPage: DesktopGitHubEventsPage | null;
  repository: string | null;
  currentBranch: string | null;
  githubConnected: boolean;
  githubLoading: boolean;
  githubBusy: boolean;
  githubError: string | null;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
  linkedTaskId: string | null;
  selectedEventId: string | null;
  loadedOlderWithoutMatches: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
  loadOlder: [];
  installGithub: [];
  clearTaskFilter: [];
  openTask: [taskId: string];
  closeSelectedEvent: [];
}>();

const selectedFilter = ref<DesktopGitHubEventFilter>("actionable");
const searchQuery = ref("");
const showLowSignal = ref(false);
const overflowOpen = ref(false);
const selectedEventId = ref<string | null>(null);

const events = computed<DesktopGitHubRoomEvent[]>(() => props.eventsPage?.events || []);
const presentations = computed<DesktopGitHubEventPresentation[]>(() =>
  events.value.map((event) => presentDesktopGitHubEvent(event, props.repository))
);
const filterOptions = computed(() => buildDesktopGitHubEventFilterOptions(presentations.value));
const filteredEvents = computed(() =>
  filterDesktopGitHubEventPresentations(presentations.value, {
    filter: selectedFilter.value,
    searchQuery: searchQuery.value,
    currentBranch: props.currentBranch,
    linkedTaskId: props.linkedTaskId,
  })
);
const hiddenLowSignalCount = computed(() =>
  selectedFilter.value === "all" && !showLowSignal.value
    ? filteredEvents.value.filter((event) => event.isLowSignal).length
    : 0
);
const visibleEvents = computed(() =>
  selectedFilter.value === "all" && !showLowSignal.value
    ? filteredEvents.value.filter((event) => !event.isLowSignal)
    : filteredEvents.value
);
const groupedEvents = computed(() => groupDesktopGitHubEvents(visibleEvents.value));
const hasMore = computed(() => Boolean(props.eventsPage?.hasMore));
const showSetupState = computed(() =>
  !props.githubConnected && !props.githubLoading && events.value.length === 0
);
const selectedEvent = computed(() =>
  presentations.value.find((event) => event.id === selectedEventId.value) || null
);

watch(() => props.linkedTaskId, (taskId) => {
  if (taskId) selectedFilter.value = "all";
});

watch(() => props.selectedEventId, (eventId) => {
  if (eventId) selectedEventId.value = eventId;
});

watch(selectedFilter, (filter) => {
  if (filter !== "all") showLowSignal.value = false;
});

onMounted(() => {
  document.addEventListener("pointerdown", closeOverflowOnOutsidePointer);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", closeOverflowOnOutsidePointer);
});

function refreshFromMenu(): void {
  overflowOpen.value = false;
  emit("refresh");
}

function clearFilters(): void {
  selectedFilter.value = "actionable";
  searchQuery.value = "";
  showLowSignal.value = false;
  emit("clearTaskFilter");
}

function openLinkedTask(taskId: string): void {
  closeSelectedEvent();
  emit("openTask", taskId);
}

function closeSelectedEvent(): void {
  selectedEventId.value = null;
  emit("closeSelectedEvent");
}

async function copyEventUrl(event: DesktopGitHubEventPresentation): Promise<void> {
  if (!event.url) return;
  await navigator.clipboard.writeText(event.url).catch(() => undefined);
}

async function copyEventId(event: DesktopGitHubEventPresentation): Promise<void> {
  await navigator.clipboard.writeText(event.id).catch(() => undefined);
}

function relativeTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const diffMs = time - Date.now();
  const absMs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, unitMs] of units) {
    if (absMs >= unitMs) return formatter.format(Math.round(diffMs / unitMs), unit);
  }
  return "now";
}

function absoluteTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(time);
}

function bodyLabel(event: DesktopGitHubEventPresentation): string {
  if (event.kind === "review") return "Review";
  if (event.kind === "comment") return "Comment";
  if (event.kind === "pull-request" || event.kind === "issue") return "Description";
  return "Notes";
}

function renderEventMarkdown(value: string): string {
  return renderDesktopMarkdown(value, { block: true, mentions: false });
}

function shortSha(value: string): string {
  const normalized = value.trim();
  return normalized.length > 12 ? normalized.slice(0, 12) : normalized;
}

function compactId(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 22) return normalized;
  return `${normalized.slice(0, 12)}...${normalized.slice(-6)}`;
}

function closeOverflowOnOutsidePointer(event: PointerEvent): void {
  if (!overflowOpen.value) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest(".desktop-events-overflow")) return;
  overflowOpen.value = false;
}
</script>
