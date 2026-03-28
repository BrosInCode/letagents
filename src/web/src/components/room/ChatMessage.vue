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
  padding: 12px 0;
  opacity: 0;
  transform: translateY(6px);
  animation: msg-in 200ms ease forwards;
}
@keyframes msg-in { to { opacity: 1; transform: none; } }

.message-avatar {
  display: flex;
  align-items: flex-start;
  padding-top: 10px;
}
.message-avatar::before {
  content: '';
  display: block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--sender-color, #71717a);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--sender-color, #71717a) 18%, transparent);
}

.message-body { flex: 1; min-width: 0; }

.message-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
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
  padding: 14px 16px;
  max-width: min(100%, 780px);
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--sender-color, #71717a) 22%, rgba(255, 255, 255, 0.06));
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--sender-color, #71717a) 10%, rgba(255, 255, 255, 0.02)), rgba(255, 255, 255, 0.02)),
    rgba(19, 19, 21, 0.94);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 10px 28px rgba(0, 0, 0, 0.18);
}

.message-bubble :deep(.md-content) { line-height: 1.65; font-size: 0.88rem; word-break: break-word; color: rgba(255,255,255,0.92); }
.message-bubble :deep(.md-content) p { margin: 0 0 0.4em; }
.message-bubble :deep(.md-content) p:last-child { margin-bottom: 0; }
.message-bubble :deep(.md-content) code {
  padding: 3px 7px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.84em;
}

.provenance-badge {
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 0.62rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.provenance-badge.human { background: rgba(251,146,60,0.1); color: #fb923c; }
.provenance-badge.agent { background: rgba(96,165,250,0.1); color: #60a5fa; }
.provenance-badge.system { background: var(--surface, #18181b); color: var(--muted, #71717a); }

.agent-runtime-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 999px;
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

.system-message .message-avatar::before { opacity: 0.35; box-shadow: none; }
.system-message .message-bubble {
  opacity: 0.78;
  border-color: rgba(255, 255, 255, 0.05);
  background: rgba(17, 17, 18, 0.9);
}
</style>
