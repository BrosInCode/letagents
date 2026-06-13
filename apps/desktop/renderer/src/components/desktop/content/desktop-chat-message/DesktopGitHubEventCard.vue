<template>
  <div class="desktop-github-event" :data-tone="event.tone" :data-kind="event.kind">
    <div class="desktop-github-event-icon" aria-hidden="true">
      <svg v-if="event.kind === 'pull-request'" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="4" r="2" stroke="currentColor" stroke-width="1.3" />
        <circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.3" />
        <path d="M5.5 5.5l5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        <path d="M11 7V4h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg v-else-if="event.kind === 'issue'" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" />
        <line x1="8" y1="5" x2="8" y2="9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
      </svg>
      <svg v-else-if="event.kind === 'review'" viewBox="0 0 16 16" fill="none">
        <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H8l-3 2v-2H4.5A1.5 1.5 0 0 1 3 9.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        <path d="M6 7.8l1.2 1.2L10 6.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <svg v-else-if="event.kind === 'comment'" viewBox="0 0 16 16" fill="none">
        <path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H8l-3 2v-2H4.5A1.5 1.5 0 0 1 3 9.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
        <line x1="5.5" y1="6.5" x2="10.5" y2="6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
        <line x1="5.5" y1="8.8" x2="9.5" y2="8.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      <svg v-else-if="event.kind === 'check'" viewBox="0 0 16 16" fill="none">
        <rect x="2.5" y="2.5" width="11" height="11" rx="3" stroke="currentColor" stroke-width="1.3" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
      <svg v-else-if="event.kind === 'repository'" viewBox="0 0 16 16" fill="none">
        <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h2l1 1h4A1.5 1.5 0 0 1 13 6.5v4A1.5 1.5 0 0 1 11.5 12h-7A1.5 1.5 0 0 1 3 10.5v-5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
      </svg>
      <svg v-else viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" />
        <path d="M8 5.2v2.8M8 10.7h.01" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </div>
    <div class="desktop-github-event-content">
      <div class="desktop-github-event-chips">
        <span class="desktop-github-chip is-brand">GitHub</span>
        <span class="desktop-github-chip">{{ event.kindLabel }}</span>
        <span v-if="event.statusLabel" class="desktop-github-chip is-status">{{ event.statusLabel }}</span>
        <span v-if="event.repository" class="desktop-github-chip is-repo">{{ event.repository }}</span>
        <span v-if="event.taskId" class="desktop-github-chip is-task">{{ event.taskId }}</span>
      </div>
      <strong>{{ event.headline }}</strong>
      <p v-if="event.detail">{{ event.detail }}</p>
      <div class="desktop-github-event-actions">
        <a v-if="event.url" class="desktop-github-event-link" :href="event.url" target="_blank" rel="noopener noreferrer">
          {{ event.urlLabel }}
        </a>
        <button
          v-if="event.url"
          type="button"
          class="desktop-github-event-link is-secondary"
          @click="$emit('open-event', event.url)"
        >
          View in Events
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { GitHubEventPresentation } from "./types";

defineProps<{
  event: GitHubEventPresentation;
}>();

defineEmits<{
  "open-event": [url: string];
}>();
</script>
