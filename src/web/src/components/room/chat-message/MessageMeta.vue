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
      <button
        v-if="canReact"
        class="reply-action react-action"
        type="button"
        aria-label="Add reaction"
        title="Add reaction"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen ?? false"
        @click="emit('react', $event)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 11v1a10 10 0 1 1-9-10" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
          <path d="M9 9h.01M15 9h.01" />
          <path d="M16 5h6M19 2v6" />
        </svg>
      </button>
      <button class="reply-action" type="button" aria-label="Copy message" title="Copy message" @click="emit('copy')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9h11v11H9zM5 15H3V3h12v2" /></svg>
      </button>
      <button v-if="canPin" class="reply-action" type="button" :aria-label="pinned ? 'Unpin message' : 'Pin message'" :title="pinned ? 'Unpin message' : 'Pin message'" :aria-pressed="pinned" :disabled="pinPending" @click="emit('pin')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3 21 8M17 4 9 12 5 13 11 19 12 15 20 7M2 22 8 16" /></svg>
      </button>
      <button class="reply-action" type="button" aria-label="Reply to message" title="Reply" @click="emit('reply')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6.5 4.5L2.5 8l4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M3 8h5.5c2.485 0 4.5 2.015 4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button v-if="canOpenThread" class="reply-action" type="button" aria-label="Reply in thread" title="Reply in thread" @click="emit('thread')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4h16v12H9l-5 4z" /></svg>
      </button>
      <button class="reply-action info-action" type="button" aria-label="Message info" title="Message info" @click="emit('info')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>
          <path d="M8 7v4M8 5h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
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
      <span v-if="pinned" class="message-pin-marker" role="img" aria-label="Pinned message" title="Pinned message"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3 21 8M17 4 9 12 5 13 11 19 12 15 20 7M2 22 8 16" /></svg></span>
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
  canOpenThread?: boolean
  canReact?: boolean
  pickerOpen?: boolean
  canPin?: boolean
  pinPending?: boolean
  pinned?: boolean
}>()

const emit = defineEmits<{
  pin: []
  copy: []
  reply: []
  thread: []
  info: []
  /** The click that asked for the reaction picker; its target is the anchor. */
  react: [event: MouseEvent]
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

.message-sender { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.message-sender-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  flex-wrap: wrap;
  line-height: 1.3;
}
.message-meta strong { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
.message-sender-subtitle { font-size: 0.72rem; color: var(--muted, #71717a); }

.message-meta-tail {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 0;
  max-width: 100%;
  flex-wrap: wrap;
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
    width: 44px;
    height: 44px;
    opacity: 1;
    pointer-events: auto;
    transform: none;
  }
}
.reply-action:hover,
.reply-action:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  color: var(--text, #fafafa);
  outline: 2px solid var(--blue-text);
  outline-offset: 2px;
}
.message-meta time { order: -1; margin-right: 5px; font-size: 0.68rem; color: var(--muted, #71717a); }

.provenance-badge {
  display: none;
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
  .message-meta time { order: -1; margin-right: 5px; font-size: 0.62rem; }
  .provenance-badge { padding: 2px 6px; font-size: 0.58rem; }
  .prompt-injection-badge { font-size: 0.58rem; }
  .reply-action { width: 44px; height: 44px; opacity: 1; pointer-events: auto; transform: none; }
}
</style>
