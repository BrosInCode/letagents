<template>
  <section class="event-feed-shell">
    <GitHubEventFeedHeader
      :event-count="events.length"
      :pull-request-count="pullRequestCount"
      :check-run-count="checkRunCount"
    />

    <GitHubEventFeedFilters
      v-if="filterOptions.length > 1"
      v-model:selected-filter="selectedFilter"
      :options="filterOptions"
    />

    <div v-if="hasMore && filteredEvents.length > 0" class="event-feed-note">
      Showing the latest 100 events. Older room activity is available through pagination.
    </div>

    <GitHubEventFeedEmptyState v-if="isLoading && events.length === 0" title="Loading GitHub events…">
      Fetching the normalized room event history.
    </GitHubEventFeedEmptyState>

    <GitHubEventFeedEmptyState
      v-else-if="errorMessage"
      title="Could not load GitHub events"
      variant="error"
    >
      {{ errorMessage }}
    </GitHubEventFeedEmptyState>

    <GitHubEventFeedEmptyState
      v-else-if="!isAvailable"
      title="Waiting for the room event read API"
      variant="waiting"
    >
      The UI shell is ready, but this room still needs the backend event feed endpoint before
      structured GitHub events can populate here.
    </GitHubEventFeedEmptyState>

    <GitHubEventFeedEmptyState v-else-if="filteredEvents.length === 0" title="No GitHub events yet">
      This room has not recorded any matching normalized GitHub events{{ selectedFilter !== 'all' ? ' for the current filter' : '' }}.
    </GitHubEventFeedEmptyState>

    <GitHubEventTimeline
      v-else
      :groups="groupedEvents"
      :repository="repository"
    />
  </section>
</template>

<script setup lang="ts">
import GitHubEventFeedEmptyState from './github-event-feed/GitHubEventFeedEmptyState.vue'
import GitHubEventFeedFilters from './github-event-feed/GitHubEventFeedFilters.vue'
import GitHubEventFeedHeader from './github-event-feed/GitHubEventFeedHeader.vue'
import GitHubEventTimeline from './github-event-feed/GitHubEventTimeline.vue'
import { useGitHubEventFeed } from './github-event-feed/useGitHubEventFeed'
import type { RoomGitHubEvent } from '@/composables/useRoom'

const props = defineProps<{
  events: readonly RoomGitHubEvent[]
  repository?: string | null
  isAvailable: boolean
  hasMore?: boolean
  errorMessage?: string | null
  isLoading?: boolean
}>()

const {
  checkRunCount,
  filteredEvents,
  filterOptions,
  groupedEvents,
  pullRequestCount,
  selectedFilter,
} = useGitHubEventFeed(() => props.events)
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

@media (max-width: 640px) {
  .event-feed-shell {
    padding: 14px 12px 18px;
  }
}
</style>
