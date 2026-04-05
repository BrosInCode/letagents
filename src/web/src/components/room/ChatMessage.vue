<template>
  <div class="message" :class="{ 'system-message': isSystem }">
    <div class="message-avatar" :style="{ '--sender-color': senderColor }" />
    <div class="message-body">
      <div class="message-meta">
        <div class="message-sender">
          <div class="message-sender-row">
            <strong>{{ displayName }}</strong>
            <span v-if="ideLabel" class="ide-icon" :class="ideBadgeClass" :title="ideLabel">
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
          <span v-if="identity.ownerAttribution" class="message-sender-subtitle">
            {{ identity.ownerAttribution }}
          </span>
        </div>
        <div class="message-meta-tail">
          <span v-if="provenanceBadge" class="provenance-badge" :class="provenanceBadge.class">
            {{ provenanceBadge.label }}
          </span>
          <span v-if="inlinePromptInjection" class="prompt-injection-badge">
            Prompt injected
          </span>
          <time>{{ formattedTime }}</time>
        </div>
      </div>
      <div class="message-bubble" :class="{ 'github-message-bubble': githubEvent }" :style="{ '--sender-color': senderColor }">
        <GitHubEventCard v-if="githubEvent" :event="githubEvent" />
        <div v-else class="md-content" v-html="renderedContent" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import GitHubEventCard from './GitHubEventCard.vue'
import { parseGitHubEventPresentation } from './githubEventMessage'
import { type RoomMessage, parseAgentIdentity, isHumanSender, getSenderColor, hasInlinePromptInjection } from '@/composables/useRoom'

const props = defineProps<{
  message: RoomMessage
}>()

const identity = computed(() => parseAgentIdentity(props.message.sender))
const displayName = computed(() => identity.value.displayName || 'anonymous')
const isSystem = computed(() => {
  const s = (props.message.sender || '').toLowerCase()
  return s === 'letagents' || s === 'system'
})
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source))
const inlinePromptInjection = computed(() => hasInlinePromptInjection(props.message))
const githubEvent = computed(() => parseGitHubEventPresentation(props.message))

// Prefer the rich agent_identity from the API, fall back to sender-string parsing
const ideLabel = computed(() => {
  const fromApi = props.message.agent_identity?.ide_label
  if (fromApi && fromApi !== 'Agent') return fromApi
  const fromParsed = identity.value.ideLabel
  if (fromParsed && fromParsed !== 'Agent') return fromParsed
  return null
})

const ideNormalized = computed(() => (ideLabel.value || '').toLowerCase())

const ideBadgeClass = computed(() => {
  const ide = ideNormalized.value
  const known = ['codex', 'antigravity', 'claude', 'cursor']
  return known.includes(ide) ? `ide-${ide}` : 'ide-default'
})

const provenanceBadge = computed(() => {
  if (isSystem.value) return { label: 'system', class: 'system' }
  if (isHumanSender(props.message.sender, props.message.source)) return { label: 'human', class: 'human' }
  if (props.message.source === 'github') return { label: 'github', class: 'github' }
  if (props.message.source === 'agent') return { label: 'agent', class: 'agent' }
  return null
})

const formattedTime = computed(() => {
  try {
    const d = new Date(props.message.timestamp)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
})

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const renderedContent = computed(() => {
  const text = props.message.text || ''
  // Simple markdown-like rendering (basic)
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
  display: flex;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line, #27272a);
  opacity: 0;
  transform: translateY(6px);
  animation: msg-in 200ms ease forwards;
}
.message:last-child { border-bottom: none; }
@keyframes msg-in { to { opacity: 1; transform: none; } }

.message-avatar {
  display: flex;
  align-items: flex-start;
  padding-top: 5px;
}
.message-avatar::before {
  content: '';
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sender-color, #71717a);
}

.message-body { flex: 1; min-width: 0; }

.message-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 4px;
  line-height: 1;
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
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
  border-left: 2px solid color-mix(in srgb, var(--sender-color, #71717a) 40%, transparent);
  padding: 2px 0 2px 12px;
  max-width: min(100%, 780px);
}

.message-bubble.github-message-bubble {
  border-left: none;
  padding-left: 0;
}

.message-bubble :deep(.md-content) { line-height: 1.6; font-size: 0.88rem; word-break: break-word; }
.message-bubble :deep(.md-content) p { margin: 0 0 0.4em; }
.message-bubble :deep(.md-content) p:last-child { margin-bottom: 0; }
.message-bubble :deep(.md-content) code {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--surface, #18181b);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}
.message-bubble :deep(.md-content) a {
  color: #60a5fa;
  text-decoration: none;
  word-break: break-all;
}
.message-bubble :deep(.md-content) a:hover {
  text-decoration: underline;
}

.provenance-badge {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.provenance-badge.human { background: rgba(251,146,60,0.1); color: #fb923c; }
.provenance-badge.agent { background: rgba(96,165,250,0.1); color: #60a5fa; }
.provenance-badge.github { background: rgba(167,139,250,0.14); color: #c4b5fd; }
.provenance-badge.system { background: var(--surface, #18181b); color: var(--muted, #71717a); }

.prompt-injection-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.16);
  color: #7dd3fc;
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.prompt-injection-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
}

.system-message .message-avatar::before { opacity: 0.4; }
.system-message .message-bubble { opacity: 0.6; border-left-color: var(--line, #27272a); }
</style>
