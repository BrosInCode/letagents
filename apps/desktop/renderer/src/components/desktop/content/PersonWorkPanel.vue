<template>
  <Teleport to="body">
    <button
      class="person-work-scrim"
      type="button"
      aria-label="Close work panel"
      @click="emit('close')"
    ></button>
    <aside
      ref="panelElement"
      class="person-work-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="person-work-title"
      tabindex="-1"
    >
      <header class="person-work-header">
        <span class="person-work-avatar" aria-hidden="true">
          <img v-if="target.avatarUrl" :src="target.avatarUrl" alt="" />
          <span v-else>{{ initials }}</span>
        </span>
        <div class="person-work-identity">
          <p v-if="isViewer" class="person-work-eyebrow">Your work</p>
          <h2 id="person-work-title">{{ target.displayName || target.login }}</h2>
          <p class="person-work-login">@{{ target.login }} in this room</p>
        </div>
        <button class="person-work-close" type="button" @click="emit('close')">Close</button>
      </header>

      <div class="person-work-body">
        <p v-if="loading" class="person-work-status" role="status">Loading GitHub work...</p>
        <div v-else-if="error" class="person-work-error" role="alert">
          <p>{{ error }}</p>
          <button type="button" @click="loadWork">Try again</button>
        </div>
        <p v-if="actionError" class="person-work-error" role="alert">{{ actionError }}</p>
        <p v-if="truncated" class="person-work-status" role="note">{{ truncationNotice }}</p>

        <section
          v-for="section in sections"
          :key="section.key"
          class="person-work-section"
          :aria-labelledby="`person-work-section-${section.key}`"
        >
          <h3 :id="`person-work-section-${section.key}`">
            {{ section.title }}
            <span class="person-work-count">{{ section.rows.length }}</span>
          </h3>
          <ul v-if="section.rows.length" class="person-work-list">
            <li v-for="row in section.rows" :key="`${section.key}:${row.prUrl}`" class="person-work-row">
              <p class="person-work-row-title">
                <span v-if="row.prNumber !== null" class="person-work-number">#{{ row.prNumber }}</span>
                {{ row.title || "Untitled pull request" }}
              </p>
              <p class="person-work-row-meta">
                <span
                  v-if="stateLabel(row.state)"
                  class="person-work-state"
                  :data-state="row.state"
                >{{ stateLabel(row.state) }}</span>
                <span v-if="row.note">{{ row.note }}</span>
                <time :datetime="row.updatedAt">{{ formatRelativeTime(row.updatedAt) }}</time>
              </p>
              <div class="person-work-row-actions">
                <button type="button" @click="openPullRequest(row)">Open on GitHub</button>
              </div>
            </li>
          </ul>
          <p v-else-if="!loading && !error" class="person-work-empty">{{ section.empty }}</p>
        </section>
      </div>
    </aside>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { PersonTarget } from "../../../domain/person-target";
import {
  buildPersonWork,
  loadRoomEventsOfType,
  PERSON_WORK_EVENT_LIMIT,
  PERSON_WORK_LOOKBACK_DAYS,
  PERSON_WORK_PAGE_LIMIT,
  type PersonWorkEvent,
  type PersonWorkRow,
} from "../../../domain/person-work";
import { loginInitials } from "../../../domain/initials";
import { formatRelativeTime } from "../../../domain/time";
import { safeUserVisibleErrorDetail } from "../../../domain/user-visible-error";
import { desktopIpc } from "../../../ipc/index.js";

type PersonWorkEventType = "pull_request" | "pull_request_review";

const DAY_MS = 24 * 60 * 60 * 1000;

const props = defineProps<{
  target: PersonTarget;
  roomId: string;
  viewerLogin: string | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const panelElement = ref<HTMLElement | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const actionError = ref<string | null>(null);
const truncated = ref(false);
const truncationNotice = `Showing the latest ${PERSON_WORK_EVENT_LIMIT} events for each type.`;
const events = ref<PersonWorkEvent[]>([]);
const loadedAt = ref(new Date());
let requestToken = 0;
let previousFocus: HTMLElement | null = null;

const work = computed(() => buildPersonWork(events.value, props.target.login, loadedAt.value));
const initials = computed(() => loginInitials(props.target.login));
const isViewer = computed(() => {
  const viewer = (props.viewerLogin ?? "").trim().toLowerCase();
  return viewer.length > 0 && viewer === props.target.login.trim().toLowerCase();
});

const sections = computed(() => [
  {
    key: "open",
    title: "Open pull requests",
    rows: work.value.openPrs,
    empty: "No open pull requests in this room",
  },
  {
    key: "review",
    title: "Waiting for review",
    rows: work.value.needsTheirReview,
    empty: "No pull requests waiting for review in this room",
  },
  {
    key: "reviewed",
    title: "Reviews given",
    rows: work.value.reviewed,
    empty: "No reviews given in this room",
  },
  {
    key: "merged",
    title: "Merged in the last 24 hours",
    rows: work.value.mergedRecently,
    empty: "No pull requests merged in the last 24 hours",
  },
]);

watch(() => props.roomId, () => {
  void loadWork();
});

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.addEventListener("keydown", handleKeydown, true);
  panelElement.value?.focus({ preventScroll: true });
  void loadWork();
});

onBeforeUnmount(() => {
  requestToken += 1;
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
): Promise<{ events: PersonWorkEvent[]; truncated: boolean }> {
  const result = await loadRoomEventsOfType(
    ({ after }) => desktopIpc.room.getGitHubEvents(roomId, {
      limit: PERSON_WORK_PAGE_LIMIT,
      eventType,
      since,
      after,
    }),
    { maxEvents: PERSON_WORK_EVENT_LIMIT },
  );
  // Every event belongs to the panel room. The events route does not name a room per event.
  return {
    events: result.events.map((event) => ({ ...event, roomId })),
    truncated: result.truncated,
  };
}

async function openPullRequest(row: PersonWorkRow): Promise<void> {
  actionError.value = null;
  try {
    await desktopIpc.app.openExternalUrl(row.prUrl);
  } catch {
    actionError.value = "The pull request could not be opened.";
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  emit("close");
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
.person-work-scrim {
  position: fixed;
  z-index: 120;
  inset: 0;
  padding: 0;
  border: 0;
  background: var(--overlay-scrim);
}

.person-work-panel {
  position: fixed;
  z-index: 121;
  top: 12px;
  right: 12px;
  bottom: 12px;
  width: min(500px, calc(100vw - 24px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border: 1px solid var(--border-strong);
  border-radius: 17px;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 24px 72px light-dark(rgba(0, 0, 0, 0.12), rgba(0, 0, 0, 0.48));
  overflow: hidden;
}

.person-work-panel:focus { outline: none; }

.person-work-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border);
}

.person-work-avatar {
  display: grid;
  place-items: center;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 650;
  overflow: hidden;
}

.person-work-avatar img { width: 100%; height: 100%; object-fit: cover; }

.person-work-identity { min-width: 0; flex: 1 1 auto; }
.person-work-identity h2 { margin: 0; font-size: 1rem; font-weight: 650; overflow-wrap: anywhere; }
.person-work-eyebrow,
.person-work-login { margin: 0; color: var(--text-tertiary); font-size: 0.74rem; }

.person-work-close,
.person-work-row-actions button,
.person-work-error button {
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.person-work-close:focus-visible,
.person-work-row-actions button:focus-visible,
.person-work-error button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

.person-work-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 18px 18px;
}

.person-work-status,
.person-work-empty { margin: 0; padding: 12px 0; color: var(--text-secondary); font-size: 0.8rem; line-height: 1.45; }

.person-work-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 12px 0 0;
  color: var(--red);
  font-size: 0.8rem;
}

.person-work-error p { margin: 0; }

.person-work-section { padding-top: 14px; }

.person-work-section h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-weight: 650;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.person-work-count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  text-align: center;
  font-size: 0.7rem;
  letter-spacing: 0;
}

.person-work-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }

.person-work-row {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-subtle);
}

.person-work-row p { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.person-work-row-title { color: var(--text); font-size: 0.82rem; font-weight: 600; line-height: 1.35; }
.person-work-number { color: var(--text-tertiary); font-weight: 500; }

.person-work-row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  color: var(--text-secondary);
  font-size: 0.72rem;
  line-height: 1.4;
}

.person-work-state {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-secondary);
  font-weight: 600;
}

.person-work-state[data-state="open"] { color: var(--green); border-color: var(--green); }
.person-work-state[data-state="merged"] { color: var(--blue); border-color: var(--blue); }
.person-work-state[data-state="draft"] { color: var(--amber); border-color: var(--amber); }
.person-work-state[data-state="closed"] { color: var(--red); border-color: var(--red); }

.person-work-row-actions { display: flex; flex-wrap: wrap; gap: 6px; }

@media (max-width: 559px) {
  .person-work-panel {
    top: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    border: 0;
    border-radius: 0;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
  }
}

@media (prefers-reduced-motion: reduce) {
  .person-work-panel { transition: none; }
}
</style>
