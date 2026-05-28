<template>
  <div class="event-feed-list">
    <section
      v-for="group in groups"
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
</template>

<script setup lang="ts">
import GitHubEventCard from '../GitHubEventCard.vue'
import { presentGitHubRoomEvent } from '../githubEventMessage'
import { labelForType } from './labels'
import { formatEventTime } from './time'
import type { GitHubEventGroup } from './types'

defineProps<{
  groups: readonly GitHubEventGroup[]
  repository?: string | null
}>()
</script>

<style scoped>
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
