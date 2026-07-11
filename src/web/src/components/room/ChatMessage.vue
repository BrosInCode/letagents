<template>
  <div
    class="message"
    :class="{
      'system-message': isSystem,
      'ambient-system-message': isAmbientSystem,
      'thinking-message': Boolean(thinkingCard),
      'reply-message': Boolean(message.reply_to),
      'has-thread': hasThread,
    }"
    :data-msg-id="message.id"
  >
    <div class="message-avatar" :style="{ '--sender-color': senderColor }" />
    <div class="message-body">
      <MessageMeta
        :display-name="displayName"
        :owner-attribution="identity.ownerAttribution"
        :ide-label="ideLabel"
        :provenance-badge="provenanceBadge"
        :inline-prompt-injection="inlinePromptInjection"
        :formatted-time="formattedTime"
        @reply="emit('reply', message)"
      />
      <div
        class="message-bubble"
        :class="{
          'github-message-bubble': githubEvent,
          'thinking-message-bubble': thinkingCard,
        }"
        :style="{ '--sender-color': senderColor }"
      >
        <ReplyPreview
          v-if="message.reply_to"
          :message-id="message.reply_to.id"
          :display-name="replyDisplayName"
          :preview-text="replyPreviewText"
          @scroll-to-reply="emit('scrollToReply', $event)"
        />
        <ReasoningAnchor
          v-if="reasoningSession"
          :title="reasoningTitle"
          :summary="reasoningSummary"
          @open="reasoningOpen = true"
        />
        <GitHubEventCard v-if="githubEvent" :event="githubEvent" />
        <AgentThinkingCard
          v-else-if="thinkingCard"
          :card="thinkingCard"
          compact
          kicker="Thinking update"
        />
        <LongMessageContent
          v-else-if="message.text"
          :text="message.text || ''"
          :html="renderedContent"
          :messageId="message.id"
        />
        <MessageAttachments
          v-if="attachments.length"
          :message-id="message.id"
          :attachments="attachments"
          @open-image-viewer="emit('openImageViewer', $event)"
        />
        <StalePromptActions
          v-if="showStalePromptToggle"
          :muted="stalePromptMuted"
          @toggle="handleToggleStalePromptMute"
        />
      </div>
      <ThreadMarker
        v-if="hasThread"
        :latest-id="threadLatestId"
        :label="threadLabel"
        :latest-display-name="threadLatestDisplayName"
        :latest-preview="threadLatestPreview"
        :action-label="threadActionLabel"
        @scroll-to-reply="emit('scrollToReply', $event)"
      />
    </div>
    <ReasoningTraceModal
      :open="reasoningOpen"
      :roomIdentifier="roomIdentifier"
      :session="reasoningSession || null"
      @close="reasoningOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import AgentThinkingCard from './AgentThinkingCard.vue'
import GitHubEventCard from './GitHubEventCard.vue'
import LongMessageContent from './LongMessageContent.vue'
import ReasoningTraceModal from './ReasoningTraceModal.vue'
import MessageAttachments from './chat-message/MessageAttachments.vue'
import MessageMeta from './chat-message/MessageMeta.vue'
import ReasoningAnchor from './chat-message/ReasoningAnchor.vue'
import ReplyPreview from './chat-message/ReplyPreview.vue'
import StalePromptActions from './chat-message/StalePromptActions.vue'
import ThreadMarker from './chat-message/ThreadMarker.vue'
import {
  formatMessageTime,
  isAmbientSystemMessage,
  renderMessageContent,
  stripStatusPrefix,
} from './chat-message/formatting'
import { isCurrentStalePrompt, stalePromptTaskIdFor } from './chat-message/stalePrompt'
import type { MessageThreadSummary, ProvenanceBadge } from './chat-message/types'
import { parseGitHubEventPresentation } from './githubEventMessage'
import { buildAgentThinkingEntry } from './agentThinking'
import {
  type RoomMessage,
  type RoomReasoningSession,
  type StalePromptTaskState,
  parseAgentIdentity,
  resolveAgentIdentity,
  isHumanSender,
  getSenderColor,
  hasInlinePromptInjection,
  getReplyPreviewText,
} from '@/composables/useRoom'

const props = defineProps<{
  message: RoomMessage
  roomIdentifier?: string
  thread?: MessageThreadSummary | null
  stalePromptTaskStates?: Readonly<Record<string, StalePromptTaskState>>
  reasoningSession?: RoomReasoningSession | null
}>()
const emit = defineEmits<{
  reply: [message: RoomMessage]
  scrollToReply: [messageId: string]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
}>()

const reasoningOpen = ref(false)
const identity = computed(() => resolveAgentIdentity(props.message.sender, props.message.agent_identity))
const displayName = computed(() => identity.value.displayName || 'anonymous')
const isSystem = computed(() => ['letagents', 'system'].includes((props.message.sender || '').toLowerCase()))
const isAmbientSystem = computed(() =>
  isAmbientSystemMessage(props.message.sender, props.message.text || '')
)
const senderColor = computed(() => getSenderColor(props.message.sender, props.message.source))
const inlinePromptInjection = computed(() => hasInlinePromptInjection(props.message))
const githubEvent = computed(() => parseGitHubEventPresentation(props.message))
const thinkingCard = computed(() => buildAgentThinkingEntry(props.message))
const attachments = computed(() => props.message.attachments || [])

const stalePromptTaskId = computed(() => stalePromptTaskIdFor(props.message))
const stalePromptTaskState = computed(() =>
  stalePromptTaskId.value
    ? props.stalePromptTaskStates?.[stalePromptTaskId.value] ?? null
    : null
)
const stalePromptMuted = computed(() => Boolean(stalePromptTaskState.value?.muted))
const showStalePromptToggle = computed(() =>
  Boolean(
    stalePromptTaskId.value
    && stalePromptTaskState.value?.isStale
    && isCurrentStalePrompt(stalePromptTaskState.value, props.message.timestamp),
  )
)

function handleToggleStalePromptMute() {
  if (!stalePromptTaskId.value || !showStalePromptToggle.value) return
  emit('toggleStalePromptMute', {
    taskId: stalePromptTaskId.value,
    muted: !stalePromptMuted.value,
    promptTimestamp: props.message.timestamp,
  })
}

const ideLabel = computed(() => {
  const fromApi = props.message.agent_identity?.ide_label
  if (fromApi && fromApi !== 'Agent') return fromApi
  const fromParsed = identity.value.ideLabel
  if (fromParsed && fromParsed !== 'Agent') return fromParsed
  return null
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

const reasoningTitle = computed(() =>
  props.reasoningSession?.title
  || props.reasoningSession?.summary
  || 'Open the current reasoning stream'
)
const reasoningSummary = computed(() =>
  props.reasoningSession?.latest_payload?.checking
  || props.reasoningSession?.latest_payload?.next_action
  || props.reasoningSession?.checking
  || props.reasoningSession?.next_action
  || props.reasoningSession?.goal
  || props.reasoningSession?.summary
  || null
)

const provenanceBadge = computed<ProvenanceBadge | null>(() => {
  if (isSystem.value) return { label: 'system', className: 'system' }
  if (isHumanSender(props.message.sender, props.message.source)) return { label: 'human', className: 'human' }
  if (props.message.source === 'github') return { label: 'github', className: 'github' }
  if (props.message.source === 'agent' && !identity.value.ownerAttribution) {
    return { label: 'agent', className: 'agent' }
  }
  return null
})

const formattedTime = computed(() => formatMessageTime(props.message.timestamp))
const renderedContent = computed(() => renderMessageContent(
  isAmbientSystem.value
    ? stripStatusPrefix(props.message.text || '')
    : props.message.text || ''
))
</script>

<style scoped>
.message {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 0;
}

.message-avatar {
  display: flex;
  align-items: flex-start;
  padding-top: 4px;
}
.message-avatar::before {
  content: '';
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sender-color, #71717a);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sender-color, #71717a) 14%, transparent);
}

.message-body {
  flex: 0 1 72ch;
  width: min(100%, 72ch);
  min-width: 0;
}

.message-bubble {
  --message-surface: color-mix(in srgb, var(--surface, #18181b) 96%, var(--sender-color, #71717a) 4%);
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  padding: 11px 15px 12px;
  border: none;
  border-radius: 16px 16px 16px 6px;
  background: var(--message-surface);
  color: color-mix(in srgb, var(--text, #fafafa) 94%, transparent);
  box-shadow:
    inset 0 1px color-mix(in srgb, white 5%, transparent),
    0 1px 2px color-mix(in srgb, black 22%, transparent);
}

.message-bubble.github-message-bubble {
  width: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.message-bubble.thinking-message-bubble {
  width: min(100%, 68ch);
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.reply-message .message-bubble {
  border-bottom-left-radius: 10px;
}

.message.jump-target .message-bubble {
  border-color: color-mix(in srgb, var(--sender-color, #71717a) 72%, white 12%);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--sender-color, #71717a) 13%, transparent);
}

.message-bubble :deep(.md-content) {
  font-size: 0.96rem;
  line-height: 1.62;
  overflow-wrap: anywhere;
  word-break: normal;
}
.message-bubble :deep(.md-content) p { margin: 0 0 0.64em; }
.message-bubble :deep(.md-content) p:last-child { margin-bottom: 0; }
.message-bubble :deep(.md-content) ul,
.message-bubble :deep(.md-content) ol { margin: 0.35em 0 0.8em; padding-left: 1.35em; }
.message-bubble :deep(.md-content) li + li { margin-top: 0.28em; }
.message-bubble :deep(.md-content) blockquote {
  margin: 0.65em 0;
  padding-left: 0.9em;
  border-left: 2px solid color-mix(in srgb, var(--sender-color, #71717a) 42%, transparent);
  color: var(--text-secondary, #a1a1aa);
}
.message-bubble :deep(.md-content) pre {
  max-width: 100%;
  margin: 0.75em 0;
  padding: 12px 14px;
  overflow-x: auto;
  border: 1px solid var(--line, #27272a);
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-0, #09090b) 84%, transparent);
  line-height: 1.55;
}
.message-bubble :deep(.md-content) code {
  padding: 0.15em 0.38em;
  border-radius: 5px;
  background: color-mix(in srgb, var(--surface, #18181b) 88%, transparent);
  font-family: var(--font-mono, 'SF Mono', 'Fira Code', monospace);
  font-size: 0.86em;
}
.message-bubble :deep(.md-content) pre code {
  padding: 0;
  background: transparent;
  font-size: 0.82rem;
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

.system-message .message-avatar::before { opacity: 0.4; }
.system-message .message-bubble { opacity: 0.76; }

.ambient-system-message {
  gap: 9px;
  padding: 6px 0;
}

.ambient-system-message .message-avatar {
  padding-top: 5px;
}

.ambient-system-message .message-avatar::before {
  width: 6px;
  height: 6px;
  box-shadow: none;
  opacity: 0.45;
}

.ambient-system-message .message-body {
  flex-basis: 72ch;
  width: min(100%, 72ch);
}

.ambient-system-message :deep(.message-meta) {
  margin-bottom: 2px;
  opacity: 0.68;
}

.ambient-system-message :deep(.message-meta strong) {
  font-size: 0.72rem;
  font-weight: 600;
}

.ambient-system-message :deep(.message-sender-subtitle),
.ambient-system-message :deep(.provenance-badge) {
  display: none;
}

.ambient-system-message .message-bubble {
  width: 100%;
  padding: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--muted, #a1a1aa);
  opacity: 1;
  box-shadow: none;
}

.ambient-system-message .message-bubble :deep(.md-content) {
  font-size: 0.8rem;
  line-height: 1.5;
}

@media (max-width: 768px) {
  .message { gap: 10px; padding: 10px 0; }
  .message-avatar::before {
    width: 8px;
    height: 8px;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--sender-color, #71717a) 16%, transparent);
  }
  .message-bubble { padding: 10px 13px 11px; border-radius: 14px 14px 14px 5px; }
  .message-bubble :deep(.md-content) { font-size: 1rem; line-height: 1.6; }
  .message-bubble.thinking-message-bubble,
  .ambient-system-message .message-bubble { padding: 0; border-radius: 0; }
}
</style>
