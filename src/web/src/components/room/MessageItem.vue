<template>
  <div class="message" :class="{ 'system-message': isSystem, 'search-match': searchMatch, 'search-dim': searchDim }">
    <div class="message-avatar" :style="{ '--sender-color': senderColor }" />
    <div class="message-body">
      <div class="message-meta">
        <div class="message-sender">
          <div class="message-sender-row">
            <strong>{{ senderName }}</strong>
            <span v-if="ideBadge" class="ide-icon" :class="`ide-${ideNormalized}`" :title="ideBadge">
              <svg v-if="ideNormalized === 'codex'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="12" height="12" rx="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
                <path d="M6 6l2 2-2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="9.5" y1="10" x2="11" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <svg v-else-if="ideNormalized === 'antigravity'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2L13 14H3L8 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
                <line x1="5.5" y1="10" x2="10.5" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
              </svg>
              <svg v-else-if="ideNormalized === 'claude'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.4" fill="none"/>
                <circle cx="8" cy="8" r="2" fill="currentColor"/>
              </svg>
              <svg v-else-if="ideNormalized === 'cursor'" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 3l8 5-8 5V3z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
              </svg>
              <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.3" fill="none"/>
                <circle cx="8" cy="5.5" r="1" fill="currentColor"/>
                <line x1="8" y1="7.5" x2="8" y2="11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              </svg>
            </span>
          </div>
          <span v-if="senderSubtitle" class="message-sender-subtitle">{{ senderSubtitle }}</span>
        </div>
        <div class="message-meta-tail">
          <span v-if="provenanceLabel" :class="['provenance-badge', provenanceType]">{{ provenanceLabel }}</span>
          <time>{{ formattedTime }}</time>
        </div>
      </div>
      <div class="message-bubble" :style="{ '--sender-color': senderColor }">
        <div class="md-content" v-html="renderedContent" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface MessageData {
  id: string
  sender: string
  text: string
  source?: string | null
  timestamp: string
  senderColor?: string
  senderSubtitle?: string
  ideBadge?: string
}

const props = withDefaults(defineProps<{
  message: MessageData
  searchMatch?: boolean
  searchDim?: boolean
}>(), {
  searchMatch: false,
  searchDim: false,
})

const senderName = computed(() => props.message.sender || 'Unknown')
const senderSubtitle = computed(() => props.message.senderSubtitle || '')
const senderColor = computed(() => props.message.senderColor || 'var(--sender-default, #71717a)')
const isSystem = computed(() => props.message.source === null || props.message.source === 'system')
const provenanceType = computed(() => props.message.source || 'system')
const provenanceLabel = computed(() => {
  if (!props.message.source) return ''
  return props.message.source
})
const ideBadge = computed(() => props.message.ideBadge || '')
const ideNormalized = computed(() => (ideBadge.value || '').toLowerCase())

const formattedTime = computed(() => {
  try {
    const d = new Date(props.message.timestamp)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
})

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const renderedContent = computed(() => {
  // Basic text rendering — will use marked.js in the actual Room page
  const text = props.message.text || ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Linkify URLs — sanitize href to prevent attribute injection
    .replace(/(https?:\/\/[^\s<"']+)/g, (_match, url) => {
      const safeHref = escapeAttr(url)
      return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${url}</a>`
    })
    .replace(/\n/g, '<br>')
})
</script>

<style scoped>
.message {
  display: flex; gap: 12px;
  padding: 10px 0; margin: 0;
  border-bottom: 1px solid var(--line, #27272a);
  opacity: 0; transform: translateY(6px);
  animation: msg-in 200ms ease forwards;
}
.message:last-child { border-bottom: none; }
@keyframes msg-in { to { opacity: 1; transform: none; } }

.message-avatar {
  display: flex; align-items: flex-start; padding-top: 5px;
  width: auto; height: auto;
}
.message-avatar::before {
  content: ""; display: block;
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--sender-color, var(--sender-default, #71717a));
}

.message-body { flex: 1; min-width: 0; }

.message-meta {
  display: flex; align-items: baseline; flex-wrap: wrap;
  gap: 6px; margin-bottom: 4px; line-height: 1;
}
.message-sender { display: flex; flex-direction: column; gap: 1px; }
.message-sender-row {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.message-meta strong { font-size: 0.82rem; font-weight: 700; }
.message-sender-subtitle { font-size: 0.68rem; color: var(--muted, #71717a); }
.message-meta-tail {
  display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
}
.message-meta time { font-size: 0.68rem; color: var(--muted, #71717a); }

/* ── IDE icon inline next to name ── */
.ide-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3px;
  transition: opacity 0.15s ease;
}
.ide-icon svg {
  width: 12px;
  height: 12px;
}
.ide-icon:hover { opacity: 0.8; }

.ide-icon.ide-codex  { color: #22c55e; }
.ide-icon.ide-antigravity { color: #60a5fa; }
.ide-icon.ide-claude { color: #fb923c; }
.ide-icon.ide-cursor { color: #a855f7; }
.ide-icon.ide-default { color: var(--muted, #71717a); }

.message-bubble {
  border-left: 2px solid color-mix(in srgb, var(--sender-color, var(--sender-default, #71717a)) 40%, transparent);
  padding: 2px 0 2px 12px;
  max-width: min(100%, 780px);
}
.md-content { line-height: 1.6; font-size: 0.88rem; word-break: break-word; }
.md-content :deep(a) { color: #60a5fa; text-decoration: none; word-break: break-all; }
.md-content :deep(a:hover) { text-decoration: underline; }
.md-content :deep(code) {
  padding: 2px 5px; border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

/* Provenance badges */
.provenance-badge {
  padding: 3px 10px; border-radius: 4px;
  font-size: 0.62rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.provenance-badge.human { background: rgba(251,146,60,0.1); color: #fb923c; }
.provenance-badge.agent { background: rgba(96,165,250,0.1); color: #60a5fa; }
.provenance-badge.system { background: var(--surface, #18181b); color: var(--muted, #71717a); }
.provenance-badge.browser { background: rgba(251,146,60,0.1); color: #fb923c; }

/* System messages */
.system-message .message-avatar::before { background: var(--muted, #71717a); opacity: 0.4; }
.system-message .message-bubble { opacity: 0.6; border-left-color: var(--line, #27272a); }

/* Search states */
.search-dim { opacity: 0.15; transition: opacity 0.2s; }
.search-match { border-left: 3px solid var(--accent, #818cf8); padding-left: 8px; }
</style>
