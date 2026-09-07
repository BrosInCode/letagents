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
    @contextmenu="openContextMenu"
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
        @info="emit('info', message)"
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
        <GitHubEventCard
          v-if="githubEvent"
          :event="githubEvent"
          :taskLinkEnabled="Boolean(githubEvent.taskId && taskReferenceIds?.has(githubEvent.taskId))"
          @openTask="emit('openTask', $event)"
        />
        <AgentThinkingCard
          v-else-if="thinkingCard"
          :card="thinkingCard"
          compact
          kicker="Work update"
        />
        <LongMessageContent
          v-else-if="message.text"
          :text="visibleText"
          :html="renderedContent"
          :messageId="message.id"
          @taskReferenceClick="emit('openTask', $event)"
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
  <Teleport to="body">
    <div
      v-if="contextMenuOpen"
      ref="contextMenuRef"
      class="web-message-context-menu"
      :style="{ left: `${contextMenuPosition.x}px`, top: `${contextMenuPosition.y}px` }"
      role="menu"
      aria-label="Message actions"
      data-testid="web-message-context-menu"
      @contextmenu.prevent.stop
      @keydown="handleMenuKeydown"
    >
      <button type="button" role="menuitem" @click="copyMessageFromMenu">Copy message</button>
      <button type="button" role="menuitem" @click="replyFromMenu">Reply</button>
      <div class="web-message-context-menu-separator" role="separator" />
      <button type="button" role="menuitem" @click="messageInfoFromMenu">Message info</button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
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
  messageDisplayText,
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
  taskReferenceIds?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  reply: [message: RoomMessage]
  info: [message: RoomMessage]
  scrollToReply: [messageId: string]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  openTask: [taskId: string]
}>()

const reasoningOpen = ref(false)

// Custom message menu: the browser default is intentionally replaced on
// message rows only (Slack/Discord pattern); the rest of the page keeps it.
const contextMenuOpen = ref(false)
const contextMenuPosition = ref({ x: 0, y: 0 })
const contextMenuRef = ref<HTMLElement | null>(null)
let contextMenuRestoreFocus: HTMLElement | null = null

// Native context menus stay useful on these targets (open link in new tab,
// copy selection, media controls), so the message menu defers to them.
const NATIVE_MENU_TARGETS = 'a[href], button, input, textarea, select, [contenteditable="true"], img, video, audio'

function openContextMenu(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest(NATIVE_MENU_TARGETS)) return
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && target && selection.containsNode(target, true)) return
  event.preventDefault()
  contextMenuRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  contextMenuPosition.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 170),
  }
  contextMenuOpen.value = true
  void nextTick(() => {
    contextMenuRef.value?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  })
}

function closeContextMenu(restoreFocus = false) {
  if (!contextMenuOpen.value) return
  contextMenuOpen.value = false
  if (restoreFocus && contextMenuRestoreFocus?.isConnected) contextMenuRestoreFocus.focus()
  contextMenuRestoreFocus = null
}

async function copyMessageFromMenu() {
  closeContextMenu(true)
  try {
    await navigator.clipboard.writeText(visibleText.value)
  } catch {
    // Clipboard may be unavailable; text remains selectable.
  }
}

function replyFromMenu() {
  closeContextMenu()
  emit('reply', props.message)
}

function messageInfoFromMenu() {
  closeContextMenu()
  emit('info', props.message)
}

function handleMenuKeydown(event: KeyboardEvent) {
  const items = Array.from(contextMenuRef.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
  if (items.length === 0) return
  const activeIndex = items.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    items[(activeIndex + 1) % items.length].focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    items[(activeIndex - 1 + items.length) % items.length].focus()
  } else if (event.key === 'Home') {
    event.preventDefault()
    items[0].focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    items[items.length - 1].focus()
  } else if (event.key === 'Tab') {
    closeContextMenu(true)
  }
}

function handleMenuDismiss(event: Event) {
  if (!contextMenuOpen.value) return
  if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
  // Presses inside the menu are item activations, not dismissals.
  if (event.type === 'pointerdown' && event.target instanceof Node && contextMenuRef.value?.contains(event.target)) return
  closeContextMenu(event.type === 'keydown')
}

onMounted(() => {
  document.addEventListener('pointerdown', handleMenuDismiss, true)
  document.addEventListener('keydown', handleMenuDismiss, true)
  window.addEventListener('blur', handleMenuDismiss)
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handleMenuDismiss, true)
  document.removeEventListener('keydown', handleMenuDismiss, true)
  window.removeEventListener('blur', handleMenuDismiss)
})
const identity = computed(() => resolveAgentIdentity(props.message.sender, props.message.agent_identity))
const displayName = computed(() => identity.value.displayName || 'anonymous')
const isSystem = computed(() => ['letagents', 'system'].includes((props.message.sender || '').toLowerCase()))
const isAmbientSystem = computed(() =>
  isAmbientSystemMessage(props.message.sender, visibleText.value)
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
  || 'Open the current work stream'
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

const visibleText = computed(() => messageDisplayText(props.message))
const formattedTime = computed(() => formatMessageTime(props.message.timestamp))
const renderedContent = computed(() => renderMessageContent(
  isAmbientSystem.value
    ? stripStatusPrefix(visibleText.value)
    : visibleText.value,
  props.taskReferenceIds,
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
.message-bubble :deep(.md-content) h1,
.message-bubble :deep(.md-content) h2,
.message-bubble :deep(.md-content) h3,
.message-bubble :deep(.md-content) h4,
.message-bubble :deep(.md-content) h5,
.message-bubble :deep(.md-content) h6 {
  margin: 1em 0 0.48em;
  color: var(--text, #fafafa);
  font-size: 1em;
  font-weight: 780;
  line-height: 1.3;
  letter-spacing: -0.012em;
}
.message-bubble :deep(.md-content) h1:first-child,
.message-bubble :deep(.md-content) h2:first-child,
.message-bubble :deep(.md-content) h3:first-child,
.message-bubble :deep(.md-content) h4:first-child,
.message-bubble :deep(.md-content) h5:first-child,
.message-bubble :deep(.md-content) h6:first-child { margin-top: 0; }
.message-bubble :deep(.md-content) h1 { font-size: 1.18em; }
.message-bubble :deep(.md-content) h2 { font-size: 1.1em; }
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
.message-bubble :deep(.md-content) hr {
  height: 1px;
  margin: 1em 0;
  border: 0;
  background: var(--line, #27272a);
}
.message-bubble :deep(.md-content) del { color: var(--text-tertiary, #71717a); }
.message-bubble :deep(.md-content) .markdown-task-checkbox {
  margin: 0 0.48em 0 -1.18em;
  accent-color: var(--green, #22c55e);
  vertical-align: -0.08em;
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

<style>
.web-message-context-menu {
  position: fixed;
  z-index: 9998;
  display: grid;
  min-width: 172px;
  padding: 5px;
  border: 1px solid var(--border, #27272a);
  border-radius: 10px;
  background: var(--surface, #18181b);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.4);
}
.web-message-context-menu button {
  padding: 7px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text, #fafafa);
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
}
.web-message-context-menu button:hover,
.web-message-context-menu button:focus-visible { background: rgba(255, 255, 255, 0.08); outline: none; }
.web-message-context-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--border, #27272a);
}
</style>
