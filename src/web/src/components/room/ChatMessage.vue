<template>
  <div
    class="message"
    :class="{
      'system-message': isSystem,
      'reply-message': Boolean(message.reply_to),
      'has-thread': hasThread,
    }"
    :data-msg-id="message.id"
  >
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
          <button class="reply-action" type="button" aria-label="Reply to message" title="Reply" @click="emit('reply', message)">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6.5 4.5L2.5 8l4 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M3 8h5.5c2.485 0 4.5 2.015 4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
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
        <button
          v-if="message.reply_to"
          class="reply-preview"
          type="button"
          @click="emit('scrollToReply', message.reply_to.id)"
        >
          <span class="reply-preview-label">Replying to {{ replyDisplayName }}</span>
          <span class="reply-preview-text">{{ replyPreviewText }}</span>
        </button>
        <GitHubEventCard v-if="githubEvent" :event="githubEvent" />
        <LongMessageContent
          v-else-if="message.text"
          :text="message.text || ''"
          :html="renderedContent"
          :messageId="message.id"
        />
        <div v-if="attachments.length" class="message-attachments">
          <a
            v-for="attachment in attachments"
            :key="attachmentKey(attachment)"
            class="message-attachment"
            :href="attachmentHref(attachment)"
            :download="attachmentName(attachment)"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img
              v-if="isImageAttachment(attachment)"
              class="message-attachment-image"
              :src="attachmentHref(attachment)"
              :alt="attachmentName(attachment)"
            >
            <span v-else class="message-attachment-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                <path d="M9 2.5v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
              </svg>
            </span>
            <span class="message-attachment-copy">
              <strong>{{ attachmentName(attachment) }}</strong>
              <span>{{ attachmentMeta(attachment) }}</span>
            </span>
          </a>
        </div>
      </div>
      <button
        v-if="hasThread"
        class="thread-marker"
        type="button"
        :aria-label="threadActionLabel"
        @click="emit('scrollToReply', threadLatestId)"
      >
        <span class="thread-marker-label">{{ threadLabel }}</span>
        <span v-if="threadLatestPreview" class="thread-marker-preview">
          {{ threadLatestDisplayName }}: {{ threadLatestPreview }}
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import GitHubEventCard from './GitHubEventCard.vue'
import LongMessageContent from './LongMessageContent.vue'
import { parseGitHubEventPresentation } from './githubEventMessage'
import { type RoomMessage, type RoomMessageAttachment, parseAgentIdentity, isHumanSender, getSenderColor, hasInlinePromptInjection, getReplyPreviewText } from '@/composables/useRoom'

interface MessageThreadSummary {
  count: number
  latest: RoomMessage | null
}

const props = defineProps<{
  message: RoomMessage
  thread?: MessageThreadSummary | null
}>()
const emit = defineEmits<{
  reply: [message: RoomMessage]
  scrollToReply: [messageId: string]
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
const attachments = computed(() => props.message.attachments || [])

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

const replyDisplayName = computed(() => {
  const reply = props.message.reply_to
  if (!reply) return 'unknown'
  return parseAgentIdentity(reply.sender).displayName || reply.sender || 'unknown'
})

const replyPreviewText = computed(() => getReplyPreviewText(props.message.reply_to))
const hasThread = computed(() => Boolean(props.thread?.count && props.thread.count > 0))

const threadLabel = computed(() => {
  const count = props.thread?.count || 0
  return count === 1 ? '1 reply' : `${count} replies`
})

const threadLatestId = computed(() => props.thread?.latest?.id || props.message.id)

const threadLatestDisplayName = computed(() => {
  const sender = props.thread?.latest?.sender
  if (!sender) return 'Latest'
  return parseAgentIdentity(sender).displayName || sender
})

const threadLatestPreview = computed(() => getReplyPreviewText(props.thread?.latest))
const threadActionLabel = computed(() => `Open ${threadLabel.value}`)

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

function attachmentName(attachment: RoomMessageAttachment): string {
  return attachment.file_name || attachment.filename || attachment.name || 'attachment'
}

function attachmentMimeType(attachment: RoomMessageAttachment): string {
  return attachment.mime_type || attachment.content_type || 'application/octet-stream'
}

function attachmentSize(attachment: RoomMessageAttachment): number {
  return Number(attachment.size_bytes ?? attachment.byte_size ?? 0)
}

function attachmentHref(attachment: RoomMessageAttachment): string {
  if (attachment.url) return attachment.url
  if (attachment.download_url) return attachment.download_url
  if (attachment.data_url) return attachment.data_url
  if (attachment.content_base64) {
    return `data:${attachmentMimeType(attachment)};base64,${attachment.content_base64}`
  }
  return '#'
}

function isImageAttachment(attachment: RoomMessageAttachment): boolean {
  return attachmentMimeType(attachment).startsWith('image/') && attachmentHref(attachment) !== '#'
}

function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  const precision = size >= 10 || unitIndex === 0 ? 0 : 1
  return `${size.toFixed(precision)} ${units[unitIndex]}`
}

function attachmentMeta(attachment: RoomMessageAttachment): string {
  return [attachmentMimeType(attachment), formatAttachmentSize(attachmentSize(attachment))]
    .filter(Boolean)
    .join(' · ')
}

function attachmentKey(attachment: RoomMessageAttachment): string {
  return attachment.id || `${attachmentName(attachment)}-${attachmentSize(attachment)}-${attachmentMimeType(attachment)}`
}

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
    .replace(/(^|[\s(])@([A-Za-z0-9._-]+)/g, '$1<span class="mention-token">@$2</span>')
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
  .message:hover .reply-action,
  .message:focus-within .reply-action {
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

.reply-message .message-bubble {
  border-left-style: dashed;
}

.message-attachments {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.message-attachment {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  max-width: min(100%, 420px);
  padding: 8px;
  border: 1px solid var(--line, #27272a);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  color: inherit;
  text-decoration: none;
  transition: border-color 150ms ease, background 150ms ease;
}
.message-attachment:hover,
.message-attachment:focus-visible {
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 45%, var(--line-strong, #3f3f46));
  background: color-mix(in srgb, var(--surface, #18181b) 92%, var(--sender-color, #71717a) 8%);
  outline: none;
}
.message-attachment-image,
.message-attachment-icon {
  width: 54px;
  height: 54px;
  border-radius: 6px;
  border: 1px solid var(--line, #27272a);
  background: var(--bg-0, #09090b);
}
.message-attachment-image {
  object-fit: cover;
}
.message-attachment-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--muted, #a1a1aa);
}
.message-attachment-icon svg {
  width: 22px;
  height: 22px;
}
.message-attachment-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.message-attachment-copy strong,
.message-attachment-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-attachment-copy strong {
  color: var(--text, #fafafa);
  font-size: 0.8rem;
}
.message-attachment-copy span {
  color: var(--muted, #a1a1aa);
  font-size: 0.72rem;
}

.reply-preview {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-left: 2px solid color-mix(in srgb, var(--sender-color, #71717a) 50%, transparent);
  background: color-mix(in srgb, var(--surface, #18181b) 82%, transparent);
  border-radius: 0 8px 8px 0;
  width: 100%;
  text-align: left;
  border-top: none;
  border-right: none;
  border-bottom: none;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.reply-preview-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text, #fafafa);
}

.reply-preview-text {
  font-size: 0.78rem;
  color: var(--muted, #a1a1aa);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply-preview:hover,
.reply-preview:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 94%, var(--sender-color, #71717a) 6%);
  border-left-color: var(--sender-color, #71717a);
  outline: none;
}
.message.jump-target .message-bubble {
  border-left-color: color-mix(in srgb, var(--sender-color, #71717a) 85%, white 15%);
}

.thread-marker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(100%, 780px);
  margin-top: 8px;
  margin-left: 14px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--sender-color, #71717a) 26%, var(--line, #27272a));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface, #18181b) 72%, transparent);
  color: var(--muted, #a1a1aa);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.thread-marker::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--sender-color, #71717a);
}

.thread-marker-label {
  flex: 0 0 auto;
  color: var(--text, #fafafa);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0;
  white-space: nowrap;
}

.thread-marker-preview {
  min-width: 0;
  overflow: hidden;
  color: var(--muted, #a1a1aa);
  font-size: 0.74rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-marker:hover,
.thread-marker:focus-visible {
  background: color-mix(in srgb, var(--surface, #18181b) 90%, var(--sender-color, #71717a) 10%);
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 60%, var(--line, #27272a));
  color: var(--text, #fafafa);
  outline: none;
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
.message-bubble :deep(.md-content) .mention-token {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(125, 211, 252, 0.14);
  color: #7dd3fc;
  font-weight: 600;
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

@media (max-width: 768px) {
  .message { gap: 8px; padding: 8px 0; }
  .message-meta { gap: 4px; }
  .message-meta strong { font-size: 0.78rem; }
  .message-meta time { font-size: 0.62rem; }
  .message-bubble { max-width: 100%; padding-left: 10px; }
  .message-bubble :deep(.md-content) { font-size: 0.84rem; }
  .provenance-badge { padding: 2px 6px; font-size: 0.58rem; }
  .prompt-injection-badge { font-size: 0.58rem; padding: 2px 8px; }
  .reply-preview { padding: 6px 8px; margin-bottom: 6px; }
  .thread-marker {
    align-items: flex-start;
    flex-direction: column;
    gap: 4px;
    margin-left: 12px;
    padding: 6px 8px;
  }
  .thread-marker::before { display: none; }
  .thread-marker-preview {
    width: 100%;
  }
}
</style>
