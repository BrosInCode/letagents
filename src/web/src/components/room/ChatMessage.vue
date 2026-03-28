<template>
  <article
    class="message"
    :class="{
      'system-message': isSystem,
      'search-dim': searchQuery && !isSearchMatch,
      'search-match': searchQuery && isSearchMatch,
    }"
    :data-msg-id="message.id"
  >
    <div class="message-avatar" :style="{ '--sender-color': senderColor }" aria-hidden="true" />
    <div class="message-body">
      <div class="message-meta">
        <div class="message-sender">
          <strong>{{ displayName }}</strong>
          <span v-if="identity.ownerAttribution" class="message-sender-subtitle">
            {{ identity.ownerAttribution }}
          </span>
        </div>
        <div class="message-meta-tail">
          <span v-if="identity.ideLabel" class="agent-runtime-badge" :class="ideBadgeClass">
            <span class="ide-icon-wrap" v-html="ideBadgeIcon" />
            {{ identity.ideLabel }}
          </span>
          <span v-if="showProvenanceBadge" class="provenance-badge" :class="provenance">
            {{ provenance }}
          </span>
          <time :datetime="message.timestamp">{{ formattedTime }}</time>
        </div>
      </div>
      <div class="message-bubble" :style="{ '--sender-color': senderColor }">
        <div class="md-content" v-html="renderedContent" />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  type RoomMessage,
  parseAgentIdentity,
  isHumanSender,
  getSenderColor,
  getSenderProvenance,
  formatTimestamp,
} from '@/composables/useRoom'

const props = defineProps<{
  message: RoomMessage
  searchQuery?: string
}>()

const identity = computed(() => parseAgentIdentity(props.message.sender))
const displayName = computed(() => identity.value.displayName || 'anonymous')
const isSystem = computed(() => {
  const s = (props.message.sender || '').toLowerCase()
  return s === 'letagents' || s === 'system'
})
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source))
const provenance = computed(() => getSenderProvenance(props.message.sender, props.message.source))

// Hide provenance badge when owner attribution is shown (matches legacy behavior)
const showProvenanceBadge = computed(() => {
  if (provenance.value === 'agent' && identity.value.ownerAttribution) return false
  return true
})

const isSearchMatch = computed(() => {
  if (!props.searchQuery) return false
  const q = props.searchQuery.toLowerCase()
  const text = (props.message.text || '').toLowerCase()
  const sender = (props.message.sender || '').toLowerCase()
  return text.includes(q) || sender.includes(q)
})

const IDE_ICONS: Record<string, string> = {
  codex: '<svg class="ide-icon" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  antigravity: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  claude: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
  cursor: '<svg class="ide-icon" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
}

const ideBadgeClass = computed(() => {
  const ide = (identity.value.ideLabel || '').toLowerCase()
  const known = ['codex', 'antigravity', 'claude', 'cursor']
  return known.includes(ide) ? `ide-${ide}` : 'ide-default'
})

const ideBadgeIcon = computed(() => {
  const ide = (identity.value.ideLabel || '').toLowerCase()
  return IDE_ICONS[ide] || '<svg class="ide-icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
})

const formattedTime = computed(() => formatTimestamp(props.message.timestamp))

const renderedContent = computed(() => {
  const text = props.message.text || ''
  // Use marked if available globally, otherwise fallback to basic rendering
  if (typeof (window as any).marked !== 'undefined') {
    try {
      let html = (window as any).marked.parse(text, { breaks: true, gfm: true })
      if (props.searchQuery && isSearchMatch.value) {
        html = highlightSearch(html, props.searchQuery)
      }
      return html
    } catch {
      return escapeAndFormat(text)
    }
  }
  return escapeAndFormat(text)
})

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAndFormat(text: string): string {
  let html = escapeHtml(text)
  // Basic markdown-like formatting
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const langLabel = lang ? `<span class="code-lang-label">${lang}</span>` : ''
    return `<pre>${langLabel}<code>${code}</code></pre>`
  })
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  html = html.replace(/\n/g, '<br>')
  return html
}

function highlightSearch(html: string, query: string): string {
  const parts = html.split(/(<[^>]+>)/)
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${safeQuery})`, 'gi')
  return parts.map(part => {
    if (part.startsWith('<')) return part
    return part.replace(re, '<span class="search-highlight">$1</span>')
  }).join('')
}
</script>

<style scoped>
.message {
  display: flex; gap: 12px;
  padding: 10px 0; margin: 0;
  border-bottom: 1px solid var(--line);
  opacity: 0; transform: translateY(6px);
  animation: msg-in 200ms ease forwards;
}
.message:last-child { border-bottom: none; }
@keyframes msg-in { to { opacity: 1; transform: none; } }

.message.search-dim { opacity: 0.15; transition: opacity 0.2s; }
.message.search-match {
  border-left: 3px solid #818cf8;
  padding-left: 8px;
  transition: border-color 0.2s, opacity 0.2s;
}

.message-avatar {
  display: flex; align-items: flex-start; padding-top: 5px;
  width: auto; height: auto; background: none;
}
.message-avatar::before {
  content: ''; display: block;
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--sender-color, var(--sender-default));
}

.message-body { flex: 1; min-width: 0; }

.message-meta {
  display: flex; align-items: baseline; flex-wrap: wrap;
  gap: 6px; margin-bottom: 4px; line-height: 1;
}
.message-sender { display: flex; flex-direction: column; gap: 1px; }
.message-meta strong { font-size: 0.82rem; font-weight: 700; }
.message-sender-subtitle { font-size: 0.68rem; color: var(--muted); }
.message-meta-tail {
  display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
}
.message-meta time { font-size: 0.68rem; color: var(--muted); }

.message-bubble {
  border-left: 2px solid color-mix(in srgb, var(--sender-color, var(--sender-default)) 40%, transparent);
  padding: 2px 0 2px 12px;
  max-width: min(100%, 780px);
}

.message-bubble :deep(.md-content) { line-height: 1.6; font-size: 0.88rem; word-break: break-word; }
.message-bubble :deep(.md-content p) { margin: 0 0 0.4em; }
.message-bubble :deep(.md-content p:last-child) { margin-bottom: 0; }
.message-bubble :deep(.md-content code) {
  padding: 2px 5px; border-radius: 4px;
  background: var(--surface); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.84em;
}
.message-bubble :deep(.md-content pre) {
  position: relative; padding: 12px; border-radius: 8px;
  background: var(--bg-2); margin: 6px 0; overflow-x: auto;
}
.message-bubble :deep(.md-content pre code) { padding: 0; background: none; font-size: 0.82em; }
.message-bubble :deep(.md-content pre code.hljs) { background: transparent; padding: 0; font-size: 0.82em; }
.message-bubble :deep(.code-lang-label) {
  position: absolute; top: 6px; right: 10px;
  font-size: 0.68em; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--muted); opacity: 0.6; font-family: 'Inter', sans-serif;
  pointer-events: none;
}
.message-bubble :deep(.md-content ul), .message-bubble :deep(.md-content ol) { margin: 4px 0; padding-left: 1.4em; }
.message-bubble :deep(.md-content a) { color: #60a5fa; text-decoration: none; }
.message-bubble :deep(.md-content a:hover) { text-decoration: underline; }
.message-bubble :deep(.md-content blockquote) {
  margin: 6px 0; padding: 2px 10px;
  border-left: 2px solid var(--line); color: var(--muted);
}
.message-bubble :deep(.md-content strong) { font-weight: 700; }
.message-bubble :deep(.search-highlight) {
  background: rgba(250, 204, 21, 0.35); border-radius: 2px; padding: 0 1px;
}

.provenance-badge {
  padding: 3px 10px; border-radius: 4px;
  font-size: 0.62rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.provenance-badge.human { background: rgba(251,146,60,0.1); color: #fb923c; }
.provenance-badge.agent { background: rgba(96,165,250,0.1); color: #60a5fa; }
.provenance-badge.system { background: var(--surface); color: var(--muted); }

.agent-runtime-badge {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px; border-radius: 4px;
  font-size: 0.62rem; font-weight: 700; letter-spacing: 0.02em;
  white-space: nowrap;
}
.ide-icon-wrap { display: inline-flex; align-items: center; }
.ide-icon-wrap :deep(.ide-icon) {
  width: 12px; height: 12px; fill: none;
  stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round;
}
.agent-runtime-badge.ide-codex { background: rgba(34,197,94,0.08); color: #22c55e; }
.agent-runtime-badge.ide-antigravity { background: rgba(96,165,250,0.08); color: #60a5fa; }
.agent-runtime-badge.ide-claude { background: rgba(251,146,60,0.08); color: #fb923c; }
.agent-runtime-badge.ide-cursor { background: rgba(168,85,247,0.08); color: #a855f7; }
.agent-runtime-badge.ide-default { background: var(--surface); color: var(--muted); }

.system-message .message-avatar::before { opacity: 0.4; }
.system-message .message-bubble { opacity: 0.6; border-left-color: var(--line); }

@media (max-width: 640px) {
  .message-meta-tail { width: 100%; margin-left: 0; }
}
</style>
