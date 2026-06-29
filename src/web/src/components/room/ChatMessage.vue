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
      <MessageMeta
        :display-name="displayName"
        :owner-attribution="identity.ownerAttribution"
        :ide-label="ideLabel"
        :provenance-badge="provenanceBadge"
        :inline-prompt-injection="inlinePromptInjection"
        :formatted-time="formattedTime"
        @reply="emit('reply', message)"
      />
      <div class="message-bubble" :class="{ 'github-message-bubble': githubEvent }" :style="{ '--sender-color': senderColor }">
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
          :messageReferences="messageReferences"
          @scrollToMessageReference="emit('scrollToReply', $event)"
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
import { formatMessageTime, renderMessageContent } from './chat-message/formatting'
import { isCurrentStalePrompt, stalePromptTaskIdFor } from './chat-message/stalePrompt'
import type { MessageThreadSummary, ProvenanceBadge } from './chat-message/types'
import { parseGitHubEventPresentation } from './githubEventMessage'
import { buildAgentThinkingEntry } from './agentThinking'
import {
  type RoomMessage,
  type RoomReasoningSession,
  type StalePromptTaskState,
  parseAgentIdentity,
  isHumanSender,
  getSenderColor,
  hasInlinePromptInjection,
  getReplyPreviewText,
} from '@/composables/useRoom'

const props = defineProps<{
  message: RoomMessage
  roomIdentifier?: string
  messageReferences?: ReadonlyMap<string, RoomMessage>
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
const identity = computed(() => parseAgentIdentity(props.message.sender))
const displayName = computed(() => identity.value.displayName || 'anonymous')
const isSystem = computed(() => ['letagents', 'system'].includes((props.message.sender || '').toLowerCase()))
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
  if (props.message.source === 'agent') return { label: 'agent', className: 'agent' }
  return null
})

const formattedTime = computed(() => formatMessageTime(props.message.timestamp))
const renderedContent = computed(() => renderMessageContent(props.message.text || '', {
  resolveMessageReference: (messageId) => props.messageReferences?.get(messageId) || null,
}))
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

.message.jump-target .message-bubble {
  border-left-color: color-mix(in srgb, var(--sender-color, #71717a) 85%, white 15%);
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

.system-message .message-avatar::before { opacity: 0.4; }
.system-message .message-bubble { opacity: 0.6; border-left-color: var(--line, #27272a); }

@media (max-width: 768px) {
  .message { gap: 8px; padding: 8px 0; }
  .message-bubble { max-width: 100%; padding-left: 10px; }
  .message-bubble :deep(.md-content) { font-size: 0.84rem; }
}
</style>
