<template>
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
        <strong>{{ eventCount }}</strong>
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
</template>

<script setup lang="ts">
defineProps<{
  eventCount: number
  pullRequestCount: number
  checkRunCount: number
}>()
</script>

<style scoped>
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

@media (max-width: 900px) {
  .event-feed-hero {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .event-feed-hero {
    padding: 16px;
  }
}
</style>
