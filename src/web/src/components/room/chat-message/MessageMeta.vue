<template>
  <div class="message-meta">
    <div class="message-sender">
      <div class="message-sender-row">
        <strong>{{ displayName }}</strong>
        <IdeBadge v-if="ideLabel" :label="ideLabel" />
      </div>
      <span v-if="ownerAttribution" class="message-sender-subtitle">
        {{ ownerAttribution }}
      </span>
    </div>
    <div class="message-meta-tail">
      <button class="reply-action" type="button" aria-label="Reply to message" title="Reply" @click="emit('reply')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6.5 4.5L2.5 8l4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3 8h5.5c2.485 0 4.5 2.015 4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <span v-if="provenanceBadge" class="provenance-badge" :class="provenanceBadge.className">
        {{ provenanceBadge.label }}
      </span>
      <span
        v-if="inlinePromptInjection"
        class="prompt-injection-badge"
        title="A room prompt is attached for worker agents"
      >
        Worker prompt
      </span>
      <time>{{ formattedTime }}</time>
    </div>
  </div>
</template>

<script setup lang="ts">
import IdeBadge from './IdeBadge.vue'
import type { ProvenanceBadge } from './types'

defineProps<{
  displayName: string
  ownerAttribution?: string | null
  ideLabel?: string | null
  provenanceBadge?: ProvenanceBadge | null
  inlinePromptInjection: boolean
  formattedTime: string
}>()

const emit = defineEmits<{
  reply: []
}>()
</script>

<style scoped>
.message-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 7px;
  line-height: 1;
}

.message-sender { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; }
.message-sender-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.message-meta strong { font-size: 0.84rem; font-weight: 700; letter-spacing: -0.01em; }
.message-sender-subtitle { font-size: 0.72rem; color: var(--muted, #71717a); }

.message-meta-tail {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}
.reply-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--muted, #71717a);
  cursor: pointer;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  transform: translateY(2px);
  transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.reply-action svg {
  width: 14px;
  height: 14px;
}
@media (hover: hover) and (pointer: fine) {
  :global(.message:hover) .reply-action,
  :global(.message:focus-within) .reply-action {
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
}
@media (hover: none), (pointer: coarse) {
  .reply-action {
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
}
.reply-action:hover,
.reply-action:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  color: var(--text, #fafafa);
  outline: none;
}
.message-meta time { font-size: 0.68rem; color: var(--muted, #71717a); }

.provenance-badge {
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

@media (prefers-reduced-motion: reduce) {
  .reply-action { transition: none; }
}
.provenance-badge.human { background: rgba(251,146,60,0.1); color: #fb923c; }
.provenance-badge.agent { background: rgba(96,165,250,0.1); color: #60a5fa; }
.provenance-badge.github { background: rgba(167,139,250,0.14); color: #c4b5fd; }
.provenance-badge.system { background: var(--surface, #18181b); color: var(--muted, #71717a); }

.prompt-injection-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0;
  background: transparent;
  color: var(--muted, #71717a);
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.prompt-injection-badge::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}

@media (max-width: 768px) {
  .message-meta { gap: 4px; }
  .message-meta strong { font-size: 0.78rem; }
  .message-meta time { font-size: 0.62rem; }
  .provenance-badge { padding: 2px 6px; font-size: 0.58rem; }
  .prompt-injection-badge { font-size: 0.58rem; }
}
</style>
