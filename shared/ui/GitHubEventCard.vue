<template>
  <article class="github-event-card" :class="{ 'is-preview': compact }" :data-tone="event.tone" :data-kind="event.kind" :data-status="event.statusLabel">
    <div class="github-event-header">
      <svg class="github-event-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="event.kind === 'pull-request'">
          <circle cx="4" cy="3" r="1.5" /><circle cx="4" cy="13" r="1.5" /><circle cx="12" cy="13" r="1.5" />
          <path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2" />
        </template>
        <template v-else-if="event.kind === 'issue'">
          <circle cx="8" cy="8" r="5.5" /><path d="M8 5v3M8 11h.01" />
        </template>
        <template v-else-if="event.kind === 'review' || event.kind === 'comment'">
          <path d="M3 3h10v8H8l-3 2v-2H3z" />
          <path v-if="event.kind === 'review'" d="m5.5 7 1.5 1.5 3.5-3" />
          <path v-else d="M5.5 6h5M5.5 8h3" />
        </template>
        <template v-else-if="event.kind === 'check'">
          <rect x="2.5" y="2.5" width="11" height="11" rx="3" />
          <path v-if="/^(success|passed)$/i.test(event.statusLabel || '')" d="m5 8 2 2 4-4" />
          <path v-else-if="event.tone === 'rose'" d="m5.5 5.5 5 5m0-5-5 5" />
          <path v-else d="M8 5v3l2 1" />
        </template>
        <path v-else-if="event.kind === 'repository'" d="M2.5 4h4l1.5 2h5.5v6.5h-11z" />
        <template v-else><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3M8 11h.01" /></template>
      </svg>
      <span class="github-event-kind">{{ event.kindLabel }}</span>
      <span v-if="event.statusLabel" class="github-event-status">{{ statusLabel }}</span>
    </div>

    <div class="github-event-content">
      <p class="github-event-title">{{ title }}</p>
      <p v-if="description" class="github-event-description">{{ description }}</p>
    </div>

    <div v-if="event.repository || event.taskId" class="github-event-context">
      <span v-if="event.repository" class="github-event-repository">{{ event.repository }}</span>
      <span v-if="event.repository && event.taskId" class="github-event-separator" aria-hidden="true">·</span>
      <button
        v-if="event.taskId && taskLinkEnabled"
        type="button"
        class="github-event-task"
        :title="`Open ${event.taskId} on the Board`"
        :data-task-reference-id="event.taskId"
        @click="emit('openTask', event.taskId)"
      >{{ event.taskId }}</button>
      <span v-else-if="event.taskId" class="github-event-task">{{ event.taskId }}</span>
    </div>

    <div v-if="event.url" class="github-event-actions">
      <slot name="actions" />
      <a class="github-event-action" :href="event.url" target="_blank" rel="noopener noreferrer">
        {{ event.urlLabel }}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11 11 5M5 5h6v6" /></svg>
      </a>
      <button v-if="showEventLink && !compact" type="button" class="github-event-action is-secondary" @click="emit('openEvent', event.url)">
        View in Events
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  event: {
    kind: string;
    tone: string;
    kindLabel: string;
    statusLabel: string | null;
    headline: string;
    detail: string | null;
    repository: string | null;
    taskId: string | null;
    url: string | null;
    urlLabel: string;
  };
  compact?: boolean;
  taskLinkEnabled?: boolean;
  showEventLink?: boolean;
}>();

const emit = defineEmits<{
  openTask: [taskId: string];
  openEvent: [url: string];
}>();

// PR/issue details carry the artifact title; other events carry supporting text.
const titleFirst = computed(() => Boolean(props.event.detail) && ['pull-request', 'issue'].includes(props.event.kind));
const title = computed(() => titleFirst.value ? props.event.detail : props.event.headline);
const description = computed(() => titleFirst.value ? props.event.headline : props.event.detail);
const statusLabel = computed(() => {
  const label = props.event.statusLabel || '';
  return label.charAt(0).toUpperCase() + label.slice(1);
});
</script>

<style scoped>
.github-event-card {
  --event-accent: var(--text-secondary);
  container-type: inline-size;
  display: grid;
  gap: 10px;
  width: 100%;
  max-width: 560px;
  min-width: 0;
  box-sizing: border-box;
  padding: 14px 16px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg, 12px);
  background: var(--bg-card);
  color: var(--text);
  font-family: var(--font-sans);
}
.github-event-card[data-tone="violet"] { --event-accent: var(--task-assigned); }
.github-event-card[data-tone="emerald"] { --event-accent: var(--green-text); }
.github-event-card[data-tone="rose"] { --event-accent: var(--red-text); }
.github-event-card[data-tone="amber"] { --event-accent: var(--amber-text); }
.github-event-card[data-tone="sky"] { --event-accent: var(--blue-text); }
.github-event-header { display: flex; align-items: center; gap: 8px; min-width: 0; }
.github-event-icon { width: 16px; height: 16px; flex: none; color: var(--event-accent); }
.github-event-kind { color: var(--text-secondary); font-size: 12px; font-weight: 500; line-height: 1.5; }
.github-event-status {
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--event-accent) 10%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.github-event-content { display: grid; gap: 4px; min-width: 0; }
.github-event-title { margin: 0; color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.github-event-description { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; white-space: pre-line; overflow-wrap: anywhere; }
.github-event-context { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.github-event-repository { overflow-wrap: anywhere; }
.github-event-task { display: inline-flex; align-items: center; min-height: 24px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; color: var(--text-secondary); font: inherit; font-family: var(--font-mono); }
button.github-event-task { cursor: pointer; }
.github-event-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding-top: 8px; border-top: 1px solid var(--border); }
.github-event-action,
.github-event-actions :deep(.pull-request-changes-button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-height: 32px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font: 500 12px/1.5 var(--font-sans);
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.github-event-action:first-child,
.github-event-actions :deep(.pull-request-changes-button) { border-color: var(--border); background: var(--accent-dim); color: var(--text); }
@container (min-width: 420px) {
  .github-event-action.is-secondary { margin-left: auto; }
}
.github-event-action svg { width: 14px; height: 14px; flex: none; }
@media (hover: hover) and (pointer: fine) {
  .github-event-action:hover,
  .github-event-actions :deep(.pull-request-changes-button:hover),
  button.github-event-task:hover { background: var(--accent-hover); color: var(--text); text-decoration: none; }
}
.github-event-action:active,
.github-event-actions :deep(.pull-request-changes-button:active),
button.github-event-task:active { background: var(--accent-active); color: var(--text); transition: none; }
.github-event-action:focus-visible,
.github-event-actions :deep(.pull-request-changes-button:focus-visible),
button.github-event-task:focus-visible { outline: 2px solid var(--blue-text); outline-offset: 2px; }
.github-event-card.is-preview { margin-top: 6px; gap: 8px; padding: 12px 14px 8px; }
@media (pointer: coarse) {
  .github-event-action,
  .github-event-actions :deep(.pull-request-changes-button),
  button.github-event-task { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .github-event-action,
  .github-event-actions :deep(.pull-request-changes-button) { transition: none; }
}
@media (prefers-contrast: more) {
  .github-event-card { border-color: var(--text-secondary); }
  .github-event-status { outline: 1px solid var(--event-accent); }
}
</style>
