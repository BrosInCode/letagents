<template>
  <div class="message" :class="{ 'system-message': isSystem }">
    <div class="message-avatar" :style="{ '--sender-color': senderColor }" />
    <div class="message-body">
      <div class="message-meta">
        <div class="message-sender">
          <strong>{{ displayName }}</strong>
          <span v-if="identity.ownerAttribution" class="message-sender-subtitle">
            {{ identity.ownerAttribution }}
          </span>
        </div>
        <div class="message-meta-tail">
          <span v-if="provenanceBadge" class="provenance-badge" :class="provenanceBadge.class">
            {{ provenanceBadge.label }}
          </span>
          <span v-if="props.message.agent_prompt_kind" class="prompt-injection-badge">
            Prompt injected
          </span>
          <span v-if="identity.ideLabel" class="agent-runtime-badge" :class="ideBadgeClass">
            {{ identity.ideLabel }}
          </span>
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
import { type RoomMessage, parseAgentIdentity, isHumanSender, getSenderColor } from '@/composables/useRoom'

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

const provenanceBadge = computed(() => {
  if (isSystem.value) return { label: 'system', class: 'system' }
  if (isHumanSender(props.message.sender, props.message.source)) return { label: 'human', class: 'human' }
  if (props.message.source === 'agent') return { label: 'agent', class: 'agent' }
  return null
})

const ideBadgeClass = computed(() => {
  const ide = (identity.value.ideLabel || '').toLowerCase()
  const known = ['codex', 'antigravity', 'claude', 'cursor']
  return known.includes(ide) ? `ide-${ide}` : 'ide-default'
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

const renderedContent = computed(() => {
  const text = props.message.text || ''
  // Simple markdown-like rendering (basic)
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
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
.message-meta strong { font-size: 0.82rem; font-weight: 700; }
.message-sender-subtitle { font-size: 0.68rem; color: var(--muted, #71717a); }

.message-meta-tail {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
}
.message-meta time { font-size: 0.68rem; color: var(--muted, #71717a); }

.message-bubble {
  border-left: 2px solid color-mix(in srgb, var(--sender-color, #71717a) 40%, transparent);
  padding: 2px 0 2px 12px;
  max-width: min(100%, 780px);
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

.agent-runtime-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
.agent-runtime-badge.ide-codex { background: rgba(34,197,94,0.08); color: #22c55e; }
.agent-runtime-badge.ide-antigravity { background: rgba(96,165,250,0.08); color: #60a5fa; }
.agent-runtime-badge.ide-claude { background: rgba(251,146,60,0.08); color: #fb923c; }
.agent-runtime-badge.ide-cursor { background: rgba(168,85,247,0.08); color: #a855f7; }
.agent-runtime-badge.ide-default { background: var(--surface, #18181b); color: var(--muted, #71717a); }

.system-message .message-avatar::before { opacity: 0.4; }
.system-message .message-bubble { opacity: 0.6; border-left-color: var(--line, #27272a); }
</style>
