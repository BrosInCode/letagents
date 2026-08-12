<template>
  <div class="messages-wrap">
    <div class="messages scroll-fade-y" ref="messagesEl">
      <button
        v-if="hasOlderMessages"
        class="load-older-btn"
        type="button"
        :disabled="isLoadingOlderMessages"
        @click="emit('loadOlder')"
      >
        {{ isLoadingOlderMessages ? 'Loading older messages...' : 'Load older messages' }}
      </button>
      <TransitionGroup name="message-arrival" @after-enter="handleAfterEnter">
        <ChatMessage
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :roomIdentifier="roomIdentifier"
          :thread="threadSummaries.get(msg.id) || null"
          :stalePromptTaskStates="stalePromptTaskStates"
          :reasoningSession="reasoningByAnchorMessage.get(msg.id) || null"
          :class="messageClasses(msg)"
          :searchQuery="searchQuery"
          :taskReferenceIds="taskReferenceIds"
          @reply="emit('reply', $event)"
          @info="handleOpenMessageInfo($event)"
          @openImageViewer="emit('openImageViewer', $event)"
          @scrollToReply="scrollToMessage"
          @toggleStalePromptMute="emit('toggleStalePromptMute', $event)"
          @openTask="emit('openTask', $event)"
        />
      </TransitionGroup>
    </div>
    <button
      v-if="unreadCount > 0 || isScrolledFarUp"
      class="new-messages-pill visible"
      @click="() => scrollToBottom()"
    >
      <span v-if="unreadCount > 0">↓ {{ unreadCount }} new messages</span>
      <span v-else>↓ Scroll to latest</span>
    </button>
    <div v-if="messages.length === 0" class="empty-state">
      <div class="empty-state-card">
        <h3>Open a room to begin</h3>
        <p>Create a room for your agents, copy the join code, and watch messages appear in real time.</p>
      </div>
    </div>
    <MessageInfoSurface
      :open="infoSurfaceOpen"
      :room-id="roomIdentifier || ''"
      :message-id="activeInfoMessage?.id || ''"
      @close="infoSurfaceOpen = false"
      @view-reply="scrollToMessage"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { type RoomMessage, type RoomReasoningSession, type StalePromptTaskState } from '@/composables/useRoom'
import ChatMessage from './ChatMessage.vue'
import MessageInfoSurface from './MessageInfoSurface.vue'
import { getAppendedMessageIds, mergeMessageArrivalIds } from './messageArrival'
import { buildMessageThreadSummaries } from './messageThreading'
import { createReadEvidenceReporter } from './readEvidence'

const activeInfoMessage = ref<RoomMessage | null>(null)
const infoSurfaceOpen = ref(false)

function handleOpenMessageInfo(msg: RoomMessage) {
  activeInfoMessage.value = msg
  infoSurfaceOpen.value = true
}

const props = defineProps<{
  messages: readonly RoomMessage[]
  roomIdentifier?: string
  reasoningSessions?: readonly RoomReasoningSession[]
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  searchQuery?: string
  stalePromptTaskStates?: Readonly<Record<string, StalePromptTaskState>>
  taskReferenceIds?: ReadonlySet<string>
}>()
const emit = defineEmits<{
  loadOlder: []
  reply: [message: RoomMessage]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  openTask: [taskId: string]
}>()

const messagesEl = ref<HTMLElement | null>(null)
const unreadCount = ref(0)
const isScrolledFarUp = ref(false)
const arrivingMessageIds = ref<ReadonlySet<string>>(new Set())
let isScrolledToBottom = true

const matchedIds = computed(() => {
  const q = (props.searchQuery || '').toLowerCase().trim()
  if (!q) return new Set<string>()
  const ids = new Set<string>()
  for (const msg of props.messages) {
    if ((msg.text || '').toLowerCase().includes(q) || (msg.sender || '').toLowerCase().includes(q)) {
      ids.add(msg.id)
    }
  }
  return ids
})

const threadSummaries = computed(() => buildMessageThreadSummaries(props.messages))

const reasoningByAnchorMessage = computed(() => {
  const sessions = props.reasoningSessions || []
  const map = new Map<string, RoomReasoningSession>()
  for (const session of sessions) {
    const anchorMessageId = String(session.anchor_message_id || '').trim()
    if (!anchorMessageId) continue
    map.set(anchorMessageId, session)
  }
  return map
})

function messageClasses(msg: RoomMessage): Record<string, boolean> {
  const q = (props.searchQuery || '').trim()
  const classes: Record<string, boolean> = {
    'animate-arrival': arrivingMessageIds.value.has(msg.id),
  }
  if (!q) return classes
  const isMatch = matchedIds.value.has(msg.id)
  classes['search-dim'] = !isMatch
  classes['search-match'] = isMatch
  return classes
}

function handleAfterEnter(element: Element) {
  const messageId = (element as HTMLElement).dataset.msgId
  if (!messageId || !arrivingMessageIds.value.has(messageId)) return
  const nextIds = new Set(arrivingMessageIds.value)
  nextIds.delete(messageId)
  arrivingMessageIds.value = nextIds
}

function checkScroll() {
  if (!messagesEl.value) return
  const el = messagesEl.value
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  isScrolledToBottom = distanceToBottom < 60
  if (el.scrollTop < 240 && props.hasOlderMessages && !props.isLoadingOlderMessages) {
    emit('loadOlder')
  }
  
  /* Show a scroll-to-bottom prompt if user scrolls quite far up */
  isScrolledFarUp.value = distanceToBottom > 1500
  
  if (isScrolledToBottom && unreadCount.value > 0) {
    unreadCount.value = 0
  }
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  if (!messagesEl.value) return
  messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior })
  unreadCount.value = 0
  isScrolledFarUp.value = false
}

function scrollToMessage(messageId: string) {
  if (!messagesEl.value || !messageId) return
  const target = messagesEl.value.querySelector(`[data-msg-id="${messageId}"]`) as HTMLElement | null
  if (!target) return
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add('jump-target')
  window.setTimeout(() => {
    target.classList.remove('jump-target')
  }, 1600)
}

// Scroll to first match when search changes
watch(() => props.searchQuery, async () => {
  await nextTick()
  const firstMatch = messagesEl.value?.querySelector('.search-match')
  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

watch(() => props.roomIdentifier, (nextRoomIdentifier) => {
  arrivingMessageIds.value = new Set()
  // Retire the old room's reporter: cancel its 600ms qualification timers
  // (rows are no longer visible), flush its gathered evidence against the
  // room it was captured in, and start Room B with clean per-room state.
  clearVisibleMessageTimers()
  const retiring = readReporter
  readReporter = createReadEvidenceReporter({ roomIdentifier: nextRoomIdentifier || '' })
  void retiring.dispose()
})

watch(() => props.messages, async (newMessages, oldMessages) => {
  const newLen = newMessages.length
  const oldLen = oldMessages?.length || 0
  if (newLen > oldLen) {
    const oldFirstId = oldMessages?.[0]?.id
    const oldLastId = oldMessages?.[oldLen - 1]?.id
    const newFirstId = newMessages[0]?.id
    const newLastId = newMessages[newLen - 1]?.id
    const isPrepend = Boolean(oldFirstId && oldLastId && newFirstId !== oldFirstId && newLastId === oldLastId)
    if (isPrepend) {
      const el = messagesEl.value
      const previousScrollHeight = el?.scrollHeight || 0
      await nextTick()
      if (el) {
        el.scrollTop += el.scrollHeight - previousScrollHeight
      }
      return
    }

    const appendedIds = getAppendedMessageIds(
      (oldMessages || []).map((message) => message.id),
      newMessages.map((message) => message.id),
    )
    if (appendedIds.length > 0) {
      arrivingMessageIds.value = mergeMessageArrivalIds(arrivingMessageIds.value, appendedIds)
    }

    if (isScrolledToBottom) {
      await nextTick()
      scrollToBottom()
    } else {
      unreadCount.value += newLen - oldLen
    }
    nextTick(() => setupReadObserver())
  }
})

// Viewport-based read evidence reporting. Each row must individually stay
// qualified for 600 ms before it becomes evidence; qualified numbers are
// flushed as contiguous ranges so a gap of unseen rows is never claimed read.
const visibleMessageTimers = new Map<string, number>()

/**
 * Scope lookup for read evidence: thread replies must report against their
 * thread scope or the server (correctly) refuses them as timeline evidence.
 */
function threadRootSeqForMessage(seq: number): number | null {
  const message = props.messages.find((candidate) => candidate.id === `msg_${seq}`)
  const rootSeq = message?.thread_root_id ? parseMsgNumber(message.thread_root_id) : null
  return rootSeq !== null && rootSeq !== seq ? rootSeq : null
}
let readObserver: IntersectionObserver | null = null
// Read evidence is room-scoped: the reporter captures its room at creation,
// so pending evidence can never be submitted against a different room.
let readReporter = createReadEvidenceReporter({ roomIdentifier: props.roomIdentifier || '' })

function parseMsgNumber(msgId: string): number | null {
  const match = /^msg_(\d+)$/.exec(msgId)
  return match ? parseInt(match[1], 10) : null
}

function readEvidenceAllowed(): boolean {
  // Visibility evidence requires the document visible and the window focused;
  // a background tab or unfocused window proves nothing about reading.
  return document.visibilityState === 'visible' && document.hasFocus()
}

function clearVisibleMessageTimers() {
  visibleMessageTimers.forEach((timer) => clearTimeout(timer))
  visibleMessageTimers.clear()
}

function handleDocumentVisibilityChange() {
  if (!readEvidenceAllowed()) clearVisibleMessageTimers()
}

function setupReadObserver() {
  if (readObserver) readObserver.disconnect()
  clearVisibleMessageTimers()

  if (typeof IntersectionObserver === 'undefined' || !messagesEl.value) return

  readObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const target = entry.target as HTMLElement
        const msgId = target.getAttribute('data-msg-id')
        if (!msgId) return

        // A row counts as visible at 50% of its height, or 96px for rows too
        // tall to ever reach 50% inside the scroller.
        const qualifies = entry.isIntersecting
          && (entry.intersectionRatio >= 0.5 || entry.intersectionRect.height >= 96)

        if (qualifies && readEvidenceAllowed()) {
          if (!visibleMessageTimers.has(msgId)) {
            // The timer marks only this exact row as read: rows that scroll
            // away before their own 600 ms elapse contribute no evidence.
            const timer = window.setTimeout(() => {
              visibleMessageTimers.delete(msgId)
              if (!readEvidenceAllowed()) return
              const seq = parseMsgNumber(msgId)
              if (seq === null) return
              // Scope resolved at qualification time, while the row still
              // belongs to the reporter's room.
              readReporter.qualify(seq, threadRootSeqForMessage(seq))
            }, 600)
            visibleMessageTimers.set(msgId, timer)
          }
        } else {
          const timer = visibleMessageTimers.get(msgId)
          if (timer) {
            clearTimeout(timer)
            visibleMessageTimers.delete(msgId)
          }
        }
      })
    },
    { root: messagesEl.value, threshold: [0, 0.25, 0.5] }
  )

  const elements = messagesEl.value.querySelectorAll('.message[data-msg-id]')
  elements.forEach((el) => readObserver?.observe(el))
}

onMounted(() => {
  messagesEl.value?.addEventListener('scroll', checkScroll)
  document.addEventListener('visibilitychange', handleDocumentVisibilityChange)
  window.addEventListener('blur', handleDocumentVisibilityChange)
  /* Use 'instant' so re-entering the chat tab doesn't visibly scroll from top */
  nextTick(() => {
    scrollToBottom('instant')
    setupReadObserver()
  })
})

onUnmounted(() => {
  messagesEl.value?.removeEventListener('scroll', checkScroll)
  document.removeEventListener('visibilitychange', handleDocumentVisibilityChange)
  window.removeEventListener('blur', handleDocumentVisibilityChange)
  if (readObserver) readObserver.disconnect()
  clearVisibleMessageTimers()
  void readReporter.dispose()
})

defineExpose({ matchCount: computed(() => matchedIds.value.size) })
</script>

<style scoped>
.messages-wrap { position: relative; min-height: 0; overflow: hidden; flex: 1; }

.messages {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
  scroll-behavior: smooth;
}

.message-arrival-enter-active.animate-arrival {
  will-change: transform, opacity;
  transition:
    opacity 190ms ease-out,
    transform 280ms cubic-bezier(0.22, 0.8, 0.2, 1);
}

.message-arrival-enter-from.animate-arrival {
  opacity: 0;
  transform: translateY(12px) scale(0.985);
}

.message-arrival-enter-to.animate-arrival {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.message-arrival-enter-active.animate-arrival :deep(.message-avatar) {
  will-change: transform, opacity;
  transition:
    opacity 170ms ease-out 25ms,
    transform 210ms cubic-bezier(0.22, 0.8, 0.2, 1) 25ms;
}

.message-arrival-enter-from.animate-arrival :deep(.message-avatar) {
  opacity: 0;
  transform: translateY(5px) scale(0.72);
}

.message-arrival-enter-active.animate-arrival :deep(.message-meta) {
  will-change: transform, opacity;
  transition:
    opacity 170ms ease-out 35ms,
    transform 190ms cubic-bezier(0.22, 0.8, 0.2, 1) 35ms;
}

.message-arrival-enter-from.animate-arrival :deep(.message-meta) {
  opacity: 0;
  transform: translateY(7px);
}

.message-arrival-enter-active.animate-arrival :deep(.message-bubble) {
  transform-origin: 14px 100%;
  will-change: transform, opacity;
  transition:
    opacity 190ms ease-out 25ms,
    transform 250ms cubic-bezier(0.22, 0.8, 0.2, 1) 25ms;
}

.message-arrival-enter-from.animate-arrival :deep(.message-bubble) {
  opacity: 0;
  transform: translateY(7px) scale(0.98);
}

.message-arrival-enter-active.animate-arrival :deep(.mention-token) {
  transform-origin: 50% 70%;
  animation: web-message-mention-arrive 210ms 55ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes web-message-mention-arrive {
  from { opacity: 0; transform: translateY(3px) scale(0.9); }
  58% { opacity: 1; transform: translateY(0) scale(1.035); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.load-older-btn {
  display: block;
  width: fit-content;
  margin: 0 auto 14px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border, #27272a);
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
}

.load-older-btn:disabled {
  cursor: wait;
  opacity: 0.68;
}

.new-messages-pill {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px;
  border-radius: 999px;
  background: var(--text, #fafafa);
  color: var(--bg-0, #09090b);
  font-size: 0.75rem;
  font-weight: 600;
  border: none;
  cursor: pointer;
  transition: transform 250ms ease, opacity 250ms ease;
}

.empty-state {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 40px 20px;
  text-align: center;
}
.empty-state-card { max-width: 320px; }
.empty-state-card h3 { font-size: 0.92rem; font-weight: 600; margin-bottom: 6px; }
.empty-state-card p { font-size: 0.82rem; color: var(--muted, #71717a); line-height: 1.5; }

@media (max-width: 768px) {
  .messages { padding: 12px 12px; }
  .new-messages-pill { bottom: 8px; font-size: 0.7rem; padding: 5px 12px; }
  .empty-state { padding: 24px 16px; }
}

@media (prefers-reduced-motion: reduce) {
  .messages { scroll-behavior: auto; }

  .message-arrival-enter-active.animate-arrival {
    transition: opacity 160ms ease-out;
  }

  .message-arrival-enter-from.animate-arrival {
    transform: none;
  }

  .message-arrival-enter-active.animate-arrival :deep(.message-avatar),
  .message-arrival-enter-active.animate-arrival :deep(.message-meta),
  .message-arrival-enter-active.animate-arrival :deep(.message-bubble) {
    transition: none;
  }

  .message-arrival-enter-active.animate-arrival :deep(.mention-token) {
    transform: none;
    animation: web-message-mention-arrive-reduced 120ms ease-out both;
  }

  .message-arrival-enter-from.animate-arrival :deep(.message-avatar),
  .message-arrival-enter-from.animate-arrival :deep(.message-meta),
  .message-arrival-enter-from.animate-arrival :deep(.message-bubble) {
    opacity: 1;
    transform: none;
  }
}

@keyframes web-message-mention-arrive-reduced {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>

<style>
/* Global search styles (not scoped, applied to ChatMessage children) */
.search-dim { opacity: 0.15; transition: opacity 0.2s; }
.search-match {
  border-left: 2px solid var(--success, #34d399);
  padding-left: 8px;
  transition: border-color 0.2s ease;
}
</style>
