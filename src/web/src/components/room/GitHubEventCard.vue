<template>
  <article class="github-event-card" :class="[`tone-${event.tone}`, `kind-${event.kind}`]">
    <div class="github-event-icon" aria-hidden="true">
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

    <div class="github-event-content">
      <div class="github-event-chips">
        <span class="github-chip github-chip-brand">GitHub</span>
        <span class="github-chip github-chip-kind">{{ event.kindLabel }}</span>
        <span v-if="event.statusLabel" class="github-chip github-chip-status">{{ event.statusLabel }}</span>
        <span v-if="event.repository" class="github-chip github-chip-repo">{{ event.repository }}</span>
        <span v-if="event.taskId" class="github-chip github-chip-task">{{ event.taskId }}</span>
      </div>

      <p class="github-event-headline">{{ event.headline }}</p>
      <p v-if="event.detail" class="github-event-detail">{{ event.detail }}</p>

      <a
        v-if="event.url"
        class="github-event-link"
        :href="event.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ event.urlLabel }}
      </a>
    </div>
  </article>
</template>

<script setup lang="ts">
import type { GitHubEventPresentation } from './githubEventMessage'

defineProps<{
  event: GitHubEventPresentation
}>()
</script>

<style scoped>
.github-event-card {
  --event-accent: var(--text-tertiary);
  --event-accent-soft: color-mix(in srgb, var(--event-accent) 18%, transparent);
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr);
  gap: 12px;
  padding: 14px 15px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--event-accent) 28%, var(--border));
  background:
    linear-gradient(155deg, color-mix(in srgb, var(--event-accent) 11%, var(--bg-card)) 0%, var(--bg-card) 58%, var(--bg-subtle) 100%);
  box-shadow:
    inset 0 1px 0 var(--accent-dim),
    0 18px 40px -34px var(--event-accent-soft);
}

.github-event-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  color: var(--event-accent);
  background: color-mix(in srgb, var(--event-accent) 18%, var(--bg-subtle));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--event-accent) 28%, transparent);
}

.github-event-icon svg {
  width: 18px;
  height: 18px;
}

.github-event-content {
  min-width: 0;
  display: grid;
  gap: 8px;
}

.github-event-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.github-chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--accent-dim);
  color: var(--text-secondary);
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
}

.github-chip-brand {
  color: var(--event-accent);
  border-color: color-mix(in srgb, var(--event-accent) 32%, transparent);
  background: color-mix(in srgb, var(--event-accent) 14%, var(--bg-subtle));
}

.github-chip-status {
  background: color-mix(in srgb, var(--event-accent) 16%, var(--accent-dim));
}

.github-chip-task {
  color: var(--amber);
  border-color: var(--amber-dim);
}

.github-event-headline {
  margin: 0;
  color: var(--text);
  font-size: 0.95rem;
  font-weight: 700;
  line-height: 1.35;
}

.github-event-detail {
  margin: 0;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.55;
  word-break: break-word;
}

.github-event-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--event-accent) 34%, transparent);
  background: color-mix(in srgb, var(--event-accent) 15%, var(--bg-subtle));
  color: var(--text);
  font-size: 0.78rem;
  font-weight: 700;
  text-decoration: none;
}

.github-event-link:hover {
  text-decoration: none;
  filter: brightness(1.06);
}

.tone-violet {
  --event-accent: #a78bfa;
  --event-accent-soft: rgba(167, 139, 250, 0.26);
}

.tone-amber {
  --event-accent: #f59e0b;
  --event-accent-soft: rgba(245, 158, 11, 0.28);
}

.tone-emerald {
  --event-accent: #34d399;
  --event-accent-soft: rgba(52, 211, 153, 0.28);
}

.tone-rose {
  --event-accent: #fb7185;
  --event-accent-soft: rgba(251, 113, 133, 0.28);
}

.tone-sky {
  --event-accent: #38bdf8;
  --event-accent-soft: rgba(56, 189, 248, 0.28);
}

.tone-slate {
  --event-accent: var(--text-tertiary);
  --event-accent-soft: color-mix(in srgb, var(--event-accent) 24%, transparent);
}

@media (max-width: 640px) {
  .github-event-card {
    grid-template-columns: 1fr;
  }

  .github-event-icon {
    width: 32px;
    height: 32px;
  }
}
</style>
