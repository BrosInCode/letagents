<template>
  <section class="event-feed-shell">
    <header class="event-feed-hero">
      <div class="event-feed-copy">
        <p class="event-feed-eyebrow">Normalized GitHub timeline</p>
        <h3>Room events</h3>
        <p>
          A structured event view for PRs, reviews, checks, and repo changes.
          Shared by agents and the web UI via the room events API.
        </p>
      </div>

      <div class="event-feed-summary">
        <div class="summary-pill">
          <span class="summary-label">Events</span>
          <strong>{{ events.length }}</strong>
        </div>
        <div class="summary-pill">
          <span class="summary-label">Pull requests</span>
          <strong>{{ pullRequestCount }}</strong>
        </div>
        <div class="summary-pill">
          <span class="summary-label">Checks</span>
          <strong>{{ checkRunCount }}</strong>
        </div>
      </div>
    </header>

    <div v-if="filterOptions.length > 1" class="event-feed-filters" role="tablist" aria-label="GitHub event filters">
      <button
        v-for="option in filterOptions"
        :key="option.value"
        class="filter-chip"
        :aria-selected="selectedFilter === option.value"
        type="button"
        @click="selectedFilter = option.value"
      >
        <span>{{ option.label }}</span>
        <strong>{{ option.count }}</strong>
      </button>
    </div>

    <div v-if="hasMore && filteredEvents.length > 0" class="event-feed-note">
      Showing the latest 100 events. Older room activity is available through pagination.
    </div>

    <div v-if="isLoading && events.length === 0" class="event-feed-empty">
      <div class="event-feed-empty-card">
        <h4>Loading GitHub events…</h4>
        <p>Fetching the normalized room event history.</p>
      </div>
    </div>

    <div v-else-if="errorMessage" class="event-feed-empty">
      <div class="event-feed-empty-card error">
        <h4>Could not load GitHub events</h4>
        <p>{{ errorMessage }}</p>
      </div>
    </div>

    <div v-else-if="!isAvailable" class="event-feed-empty">
      <div class="event-feed-empty-card waiting">
        <h4>Waiting for the room event read API</h4>
        <p>
          The UI shell is ready, but this room still needs the backend event feed endpoint before
          structured GitHub events can populate here.
        </p>
      </div>
    </div>

    <div v-else-if="filteredEvents.length === 0" class="event-feed-empty">
      <div class="event-feed-empty-card">
        <h4>No GitHub events yet</h4>
        <p>
          This room has not recorded any matching normalized GitHub events{{ selectedFilter !== 'all' ? ' for the current filter' : '' }}.
        </p>
      </div>
    </div>

    <div v-else class="event-feed-list">
      <section
        v-for="group in groupedEvents"
        :key="group.key"
        class="event-day-group"
      >
        <div class="event-day-heading">
          <span class="event-day-label">{{ group.label }}</span>
          <span class="event-day-count">{{ group.events.length }}</span>
        </div>

        <div
          v-for="event in group.events"
          :key="event.id"
          class="event-row"
        >
          <div class="event-rail" aria-hidden="true">
            <span class="event-dot" />
          </div>

          <div class="event-meta">
            <span class="event-time">{{ formatEventTime(event.created_at) }}</span>
            <span v-if="event.actor_login" class="event-actor">{{ event.actor_login }}</span>
            <span class="event-type">{{ labelForType(event.event_type) }}</span>
          </div>

          <GitHubEventCard :event="presentGitHubRoomEvent(event, { repository })" />
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import GitHubEventCard from './GitHubEventCard.vue'
import { presentGitHubRoomEvent } from './githubEventMessage'
import type { RoomGitHubEvent } from '@/composables/useRoom'

type EventFilter = 'all' | RoomGitHubEvent['event_type']

const props = defineProps<{
  events: readonly RoomGitHubEvent[]
  repository?: string | null
  isAvailable: boolean
  hasMore?: boolean
  errorMessage?: string | null
  isLoading?: boolean
}>()

const selectedFilter = ref<EventFilter>('all')

const eventTypeLabels: Record<string, string> = {
  pull_request: 'Pull requests',
  pull_request_review: 'Reviews',
  issue: 'Issues',
  issue_comment: 'Comments',
  check_run: 'Checks',
  repository: 'Repository',
  installation: 'Installations',
  installation_repositories: 'Repo access',
}

const pullRequestCount = computed(() =>
  props.events.filter((event) => event.event_type === 'pull_request').length
)

const checkRunCount = computed(() =>
  props.events.filter((event) => event.event_type === 'check_run').length
)

const filterOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const event of props.events) {
    counts.set(event.event_type, (counts.get(event.event_type) || 0) + 1)
  }

  return [
    { value: 'all' as const, label: 'All', count: props.events.length },
    ...Array.from(counts.entries()).map(([value, count]) => ({
      value: value as RoomGitHubEvent['event_type'],
      label: labelForType(value),
      count,
    })),
  ]
})

watch(filterOptions, (options) => {
  if (options.some((option) => option.value === selectedFilter.value)) return
  selectedFilter.value = 'all'
})

const filteredEvents = computed(() => {
  if (selectedFilter.value === 'all') return props.events
  return props.events.filter((event) => event.event_type === selectedFilter.value)
})

const groupedEvents = computed(() => {
  const groups = new Map<string, { key: string; label: string; events: RoomGitHubEvent[] }>()

  for (const event of filteredEvents.value) {
    const key = event.created_at.slice(0, 10)
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: formatEventDay(event.created_at),
        events: [],
      })
    }
    groups.get(key)!.events.push(event)
  }

  return Array.from(groups.values())
})

function labelForType(value: string): string {
  return eventTypeLabels[value] || value.replace(/_/g, ' ')
}

function formatEventTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatEventDay(timestamp: string): string {
  const value = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)

  const valueKey = value.toDateString()
  if (valueKey === today.toDateString()) return 'Today'
  if (valueKey === yesterday.toDateString()) return 'Yesterday'

  return value.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
</script>

<style scoped>
.event-feed-shell {
  height: 100%;
  overflow-y: auto;
  padding: 18px 20px 22px;
  background:
    radial-gradient(circle at top right, rgba(56, 189, 248, 0.06), transparent 28%),
    var(--bg, #0a0a0a);
}

.event-feed-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(240px, 0.95fr);
  gap: 14px;
  padding: 18px;
  border-radius: 20px;
  border: 1px solid var(--border-strong, rgba(255, 255, 255, 0.12));
  background: var(--bg-card, #141414);
  box-shadow: inset 0 1px 0 var(--accent-dim, rgba(255, 255, 255, 0.04));
}

.event-feed-copy {
  display: grid;
  gap: 8px;
}

.event-feed-eyebrow {
  margin: 0;
  color: #7dd3fc;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.event-feed-copy h3 {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1.25rem;
  font-weight: 800;
  letter-spacing: -0.03em;
}

.event-feed-copy p {
  margin: 0;
  max-width: 54ch;
  color: var(--text-secondary, #a1a1aa);
  line-height: 1.65;
}

.event-feed-summary {
  display: grid;
  gap: 10px;
}

.summary-pill {
  display: grid;
  gap: 4px;
  padding: 14px 15px;
  border-radius: 16px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  background: var(--bg-subtle, #111111);
}

.summary-label {
  color: var(--text-tertiary, #71717a);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.summary-pill strong {
  color: var(--text, #fafafa);
  font-size: 1.25rem;
  font-weight: 800;
}

.event-feed-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.event-feed-note {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--blue-dim, rgba(59, 130, 246, 0.1));
  background: var(--accent-dim, rgba(255, 255, 255, 0.04));
  color: var(--blue, #3b82f6);
  font-size: 0.78rem;
  line-height: 1.5;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.06));
  background: var(--bg-subtle, #111111);
  color: var(--text-secondary, #a1a1aa);
  cursor: pointer;
  transition: transform 160ms ease, border-color 160ms ease, color 160ms ease;
}

.filter-chip strong {
  color: var(--text, #fafafa);
  font-size: 0.74rem;
}

.filter-chip[aria-selected='true'] {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(135deg, #7dd3fc 0%, #c4b5fd 100%);
}

.filter-chip[aria-selected='true'] strong {
  color: inherit;
}

.filter-chip:hover {
  transform: translateY(-1px);
  border-color: var(--border-accent, rgba(255, 255, 255, 0.18));
}

.event-feed-empty {
  display: grid;
  place-items: center;
  min-height: 320px;
  padding: 24px 0;
}

.event-feed-empty-card {
  max-width: 420px;
  padding: 26px 24px;
  border-radius: 18px;
  border: 1px dashed var(--border-strong, rgba(255, 255, 255, 0.12));
  background: var(--bg-card, #141414);
  text-align: center;
}

.event-feed-empty-card.waiting {
  border-style: solid;
  border-color: var(--blue-dim, rgba(59, 130, 246, 0.1));
}

.event-feed-empty-card.error {
  border-style: solid;
  border-color: var(--red-dim, rgba(239, 68, 68, 0.1));
  background: var(--red-dim, rgba(239, 68, 68, 0.1));
}

.event-feed-empty-card h4 {
  margin: 0 0 8px;
  color: var(--text, #fafafa);
  font-size: 0.98rem;
  font-weight: 700;
}

.event-feed-empty-card p {
  margin: 0;
  color: var(--text-tertiary, #71717a);
  line-height: 1.6;
}

.event-feed-list {
  display: grid;
  gap: 18px;
  margin-top: 18px;
}

.event-day-group {
  display: grid;
  gap: 12px;
}

.event-day-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.event-day-label {
  color: var(--text, #fafafa);
  font-size: 0.74rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.event-day-count {
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-dim, rgba(255, 255, 255, 0.04));
  color: var(--text-tertiary, #71717a);
  font-size: 0.72rem;
  font-weight: 700;
}

.event-row {
  display: grid;
  grid-template-columns: 18px minmax(0, 120px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.event-rail {
  position: relative;
  display: flex;
  justify-content: center;
  min-height: 100%;
}

.event-rail::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: -18px;
  width: 1px;
  background: linear-gradient(180deg, var(--border-accent, rgba(255, 255, 255, 0.18)), var(--accent-dim, rgba(255, 255, 255, 0.04)));
}

.event-day-group:last-child .event-row:last-child .event-rail::before {
  bottom: 10px;
}

.event-dot {
  position: relative;
  top: 14px;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: linear-gradient(135deg, #7dd3fc 0%, #c4b5fd 100%);
  box-shadow: 0 0 0 4px var(--accent-dim, rgba(255, 255, 255, 0.04));
}

.event-meta {
  display: grid;
  gap: 6px;
  padding-top: 10px;
  color: var(--text-tertiary, #71717a);
  font-size: 0.74rem;
}

.event-time {
  color: var(--text, #fafafa);
  font-weight: 700;
}

.event-actor,
.event-type {
  display: inline-flex;
  width: fit-content;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--accent-dim, rgba(255, 255, 255, 0.04));
}

@media (max-width: 900px) {
  .event-feed-hero {
    grid-template-columns: 1fr;
  }

  .event-row {
    grid-template-columns: 18px minmax(0, 1fr);
  }

  .event-meta {
    grid-column: 2;
    grid-row: 1;
    grid-auto-flow: column;
    justify-content: start;
    align-items: center;
    padding-top: 0;
    margin-bottom: -4px;
  }

  .event-row :deep(.github-event-card) {
    grid-column: 2;
  }
}

@media (max-width: 640px) {
  .event-feed-shell {
    padding: 14px 12px 18px;
  }

  .event-feed-hero {
    padding: 16px;
  }

  .event-row {
    grid-template-columns: 1fr;
    gap: 10px;
  }

  .event-rail {
    display: none;
  }

  .event-meta {
    grid-column: auto;
    grid-row: auto;
    grid-auto-flow: row;
    gap: 5px;
    margin-bottom: 0;
  }

  .event-row :deep(.github-event-card) {
    grid-column: auto;
  }
}
</style>
