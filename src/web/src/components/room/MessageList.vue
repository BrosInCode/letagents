<template>
  <div class="messages-wrap">
    <p v-if="openingThreadId || threadOpenError" class="thread-open-status" role="status">{{ threadOpenError || 'Loading thread…' }}</p>
    <div class="messages-scroll">
    <div class="messages scroll-fade-y" ref="messagesEl" @scrollend="finishMessageReveal">
      <button
        v-if="hasOlderMessages"
        class="load-older-btn"
        type="button"
        :disabled="isLoadingOlderMessages"
        @click="emit('loadOlder')"
      >
        {{ isLoadingOlderMessages ? 'Loading older messages...' : 'Load older messages' }}
      </button>

        <template v-for="msg in timelineMessages" :key="msg.id">
        <div v-if="msg.id === unreadTimeline.dividerId.value" class="explicit-unread" role="separator">New messages</div>
        <ChatMessage
          :message="msg"
          :roomIdentifier="roomIdentifier"
          :thread="loadedThreadSummaries.get(msg.id) || threadSummaries.get(msg.id) || null"
          :thread-open="activeThreadId === msg.id"
          :stalePromptTaskStates="stalePromptTaskStates"
          :reasoningSession="reasoningByAnchorMessage.get(msg.id) || null"
          :class="messageClasses(msg)"
          :taskReferenceIds="taskReferenceIds"
          :arriving="arrivingMessageIds.has(msg.id)"
          :agentNames="agentNames"
          @reply="emit('reply', $event)"
          @open-thread="toggleThread"
          @info="handleOpenMessageInfo($event)"
          @openImageViewer="emit('openImageViewer', $event)"
          @scrollToReply="scrollToMessage"
          @toggleStalePromptMute="emit('toggleStalePromptMute', $event)"
          @openTask="emit('openTask', $event)"
        >
          <template #thread>
            <InlineThread v-if="openedThreads.has(msg.id)" v-show="activeThreadId === msg.id"
              :id="`web-thread-${msg.id}`" :parent="msg" :messages="messages" :room-identifier="roomIdentifier || ''"
              :reasoning-by-anchor-message="reasoningByAnchorMessage" :stale-prompt-task-states="stalePromptTaskStates"
              @toggle-stale-prompt-mute="emit('toggleStalePromptMute', $event)"
              :active="activeThreadId === msg.id" :agent-names="agentNames" :task-reference-ids="taskReferenceIds"
              :search-query="searchQuery" :reveal-message-id="threadRevealId"
              @close="toggleThread(msg.id)" @info="handleOpenMessageInfo" @open-image-viewer="emit('openImageViewer', $event)"
              @open-task="emit('openTask', $event)" @jump="scrollToMessage" @rows-changed="observeMessageRows"
              @summary="loadedThreadSummaries.set(msg.id, $event)" @messages="rememberThreadMessages(msg.id, $event)">
              <template #composer="context"><slot name="thread-composer" v-bind="context" /></template>
            </InlineThread>
          </template>
        </ChatMessage>
        </template>

    </div>
    <button
      v-if="unreadCount > 0 || isScrolledFarUp"
      class="new-messages-pill visible"
      @click="unreadTimeline.jumpToLatest()"
    >
      <span v-if="unreadCount > 0">↓ {{ unreadCount }} new messages</span>
      <span v-else>↓ Scroll to latest</span>
    </button>
    <div v-if="messages.length === 0 && !agentWork.length" class="empty-state">
      <div class="empty-state-card">
        <h3>Open a room to begin</h3>
        <p>Create a room for your agents, copy the join code, and watch messages appear in real time.</p>
      </div>
    </div>
    </div>
    <!-- Live strip: who is working or typing right now. It sits outside the
         scrolling list so it stays in view while the reader is in older history. -->
    <div ref="liveStripEl" class="room-live-strip">
      <div v-if="agentWork.length" class="room-local-agent-work-list" role="status" aria-live="polite">
        <div v-for="work in agentWork.slice(0, 3)" :key="work.id" class="room-local-agent-work"
          data-motion-work :data-motion-session="work.session" :data-motion-agent="work.key" :data-motion-after="work.after">
          <span class="room-local-agent-work-pulse" aria-hidden="true"></span>
          <span class="room-local-agent-work-copy"><strong>{{ work.name }}</strong><span>{{ work.summary }}</span></span>
          <span class="room-local-agent-work-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <p v-if="agentWork.length > 3" class="room-local-agent-work-overflow">+{{ agentWork.length - 3 }} more agents working</p>
      </div>
      <TypingIndicator :key="roomIdentifier || ''" :names="typingNames" :color-for="typingColor" />
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
import "../../../../../shared/ui/room-agent-work.css";
import { useRoomWorkIndicators } from "./roomWorkIndicators";
import TypingIndicator from "../../../../../shared/ui/TypingIndicator.vue";
import { useRoomTypingNames } from "@/composables/roomTyping";
import { getSenderColor } from "@/composables/room/identity";
import { useRoomMessageMotion, useRoomWorkHandoff } from "../../../../../shared/ui/useRoomMessageMotion";
import { provide, ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { type RoomAgentPresence, type RoomMessage, type RoomReasoningSession, type StalePromptTaskState } from '@/composables/useRoom'
import ChatMessage from './ChatMessage.vue'
import InlineThread from './InlineThread.vue'
import { apiFetch, roomPath } from '@/composables/room/api'
import { messageMatchesSearch } from './chat-message/formatting'
import MessageInfoSurface from './MessageInfoSurface.vue'
import { mergeMessageArrivalIds, watchMessageListGrowth } from './messageArrival'
import { buildMessageThreadSummaries, messageThreadParentId, type MessageThreadSummary } from './messageThreading'
import { createReadEvidenceReporter } from './readEvidence'
import { injectRoomMessageLinkPreviews } from '@/composables/roomMessageLinkPreviews'
import { injectRoomMessageReactions } from '@/composables/roomMessageReactions'
import { decideMessageRevealAction } from './messageReveal'
import { useRoomUnread } from '@/composables/roomUnread'
import { unreadMenuKey, useUnreadTimeline } from '../../../../../shared/room-unread-client'

const activeInfoMessage = ref<RoomMessage | null>(null)
const infoSurfaceOpen = ref(false)

function handleOpenMessageInfo(msg: RoomMessage) {
  activeInfoMessage.value = msg
  infoSurfaceOpen.value = true
}

const props = defineProps<{
  messages: readonly RoomMessage[]
  roomIdentifier?: string
  unreadRoomId?: string
  presence?: readonly RoomAgentPresence[]
  reasoningSessions?: readonly RoomReasoningSession[]
  hasOlderMessages?: boolean
  messagesLoaded?: boolean
  isLoadingOlderMessages?: boolean
  searchQuery?: string
  stalePromptTaskStates?: Readonly<Record<string, StalePromptTaskState>>
  taskReferenceIds?: ReadonlySet<string>
  /** A message another view asked to show, e.g. the one that woke an agent. */
  revealMessageId?: string | null
  agentNames?: ReadonlyMap<string, string>
}>()
const emit = defineEmits<{
  threadMessages: [messages: RoomMessage[]]
  loadOlder: []
  reply: [message: RoomMessage]
  openImageViewer: [imageId: string]
  toggleStalePromptMute: [payload: { taskId: string; muted: boolean; promptTimestamp: string }]
  openTask: [taskId: string]
  revealed: [messageId: string]
  /** The requested message is further back than the list will load to reach it. */
  revealUnavailable: [messageId: string, reason?: 'too_far_back' | 'unavailable']
}>()

const currentAgentWork = useRoomWorkIndicators(() => props.presence || [], () => props.messages, () => props.roomIdentifier)

const messagesEl = ref<HTMLElement | null>(null)
const liveStripEl = ref<HTMLElement | null>(null)
const typingNames = useRoomTypingNames(computed(() => props.roomIdentifier || ''))
const typingColor = (name: string) => getSenderColor(name, 'browser')
const unreadRoom = computed(() => props.unreadRoomId)
const roomUnread = useRoomUnread()
provide(unreadMenuKey, { client: roomUnread, room: unreadRoom })
const unreadRevealId = ref<string | null>(null)
let finishUnreadReveal: ((found: boolean) => void) | null = null
const unreadTimeline = useUnreadTimeline({
  client: roomUnread, room: unreadRoom,
  active: computed(() => Boolean(props.unreadRoomId)),
  ready: computed(() => Boolean(props.messagesLoaded)),
  element: messagesEl,
  reveal: id => new Promise(resolve => {
    finishUnreadReveal?.(false)
    finishUnreadReveal = resolve
    unreadRevealId.value = id
    revealOlderPagesRequested = 0
    void nextTick(revealRequestedMessage)
  }),
  bottom: (reading) => scrollToBottom(reading ? 'smooth' : 'instant'),
})
function completeUnreadReveal(found: boolean) {
  unreadRevealId.value = null
  finishUnreadReveal?.(found)
  finishUnreadReveal = null
}
const unreadCount = ref(0)
const isScrolledFarUp = ref(false)
const arrivingMessageIds = ref<ReadonlySet<string>>(new Set())
let isScrolledToBottom = true
let scrollRevision = 0
let revealingMessage = false
let revealFrame: number | null = null
let revealTimer: number | null = null
let bottomFollowQueued = false
function followLatestAfterLayout() {
  if (!isScrolledToBottom || bottomFollowQueued) return
  const revision = scrollRevision
  const top = messagesEl.value?.scrollTop
  bottomFollowQueued = true
  void nextTick(() => {
    bottomFollowQueued = false
    if (revision === scrollRevision && messagesEl.value?.scrollTop === top) scrollToBottom('instant')
  })
}

const matchedIds = computed(() => {
  const q = (props.searchQuery || '').toLowerCase().trim()
  if (!q) return new Set<string>()
  const ids = new Set<string>()
  for (const msg of props.messages) {
    if (messageMatchesSearch(msg, q, props.agentNames)) {
      ids.add(msg.id)
    }
  }
  return ids
})

const activeThreadId = ref<string | null>(null)
const loadedThreadRoots = ref(new Map<string, RoomMessage>())
const openingThreadId = ref<string | null>(null)
const threadOpenError = ref('')
let threadRoomRevision = 0
const allRootMessages = computed(() => [...new Map([...loadedThreadRoots.value.values(), ...props.messages].map(message => [message.id, message])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || Number(a.id.slice(4)) - Number(b.id.slice(4))))
const openedThreads = ref(new Set<string>())
const loadedThreadMessages = ref(new Map<string, RoomMessage[]>())
function rememberThreadMessages(id: string, messages: RoomMessage[]) {
  loadedThreadMessages.value.set(id, messages)
  emit('threadMessages', [...loadedThreadRoots.value.values(), ...[...loadedThreadMessages.value.values()].flat()])
}
const loadedThreadSummaries = ref(new Map<string, MessageThreadSummary>())
const threadRevealId = ref<string | null>(null)
const timelineMessages = computed(() => {
  const loaded = new Set(allRootMessages.value.map(message => message.id))
  return allRootMessages.value.filter(message => {
    const parent = messageThreadParentId(message)
    return !parent || !loaded.has(parent)
  })
})
async function toggleThread(id: string) {
  const source = props.messages.find(message => message.id === id)
  const rootId = source && messageThreadParentId(source)
  if (rootId) {
    if (openingThreadId.value) return
    const revision = threadRoomRevision
    if (!allRootMessages.value.some(message => message.id === rootId)) {
      openingThreadId.value = rootId
      threadOpenError.value = ''
      try {
        const page = await apiFetch(`${roomPath(props.roomIdentifier || '')}/messages/${encodeURIComponent(rootId)}/thread`)
        if (revision !== threadRoomRevision) return
        loadedThreadRoots.value.set(rootId, page.root)
        rememberThreadMessages(rootId, page.replies)
      } catch {
        if (revision === threadRoomRevision) threadOpenError.value = 'Thread could not be opened. Please try again.'
        return
      } finally { if (revision === threadRoomRevision) openingThreadId.value = null }
    }
    await toggleThread(rootId)
    threadRevealId.value = id
    await nextTick()
    scrollToMessage(rootId)
    return
  }
  threadOpenError.value = ''
  const el = messagesEl.value
  const top = el?.scrollTop ?? 0
  const returnFocus = activeThreadId.value === id ? el?.querySelector<HTMLButtonElement>(`[data-msg-id="${CSS.escape(id)}"] .thread-marker`) : null
  scrollRevision++
  isScrolledToBottom = false
  messageMotion.cancel()
  activeThreadId.value = activeThreadId.value === id ? null : id
  openedThreads.value.add(id)
  threadRevealId.value = null
  void nextTick(() => {
    if (el) el.scrollTo({ top, behavior: 'instant' })
    checkScroll()
    observeMessageRows()
    returnFocus?.focus({ preventScroll: true })
  })
}
watch(() => props.roomIdentifier, () => {
  threadRoomRevision++
  openingThreadId.value = null
  threadOpenError.value = ''
  loadedThreadRoots.value = new Map()
  activeThreadId.value = null
  openedThreads.value = new Set()
  loadedThreadSummaries.value = new Map()
  loadedThreadMessages.value = new Map()
  threadRevealId.value = null
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

const arrivalTimers = new Map<string, ReturnType<typeof setTimeout>>()
function markArrivals(ids: string[]) {
  arrivingMessageIds.value = mergeMessageArrivalIds(arrivingMessageIds.value, ids)
  for (const id of ids) {
    clearTimeout(arrivalTimers.get(id))
    arrivalTimers.set(id, setTimeout(() => {
      arrivalTimers.delete(id)
      const remaining = new Set(arrivingMessageIds.value)
      remaining.delete(id)
      arrivingMessageIds.value = remaining
    }, 320))
  }
}
function clearArrivals() {
  arrivalTimers.forEach(clearTimeout)
  arrivalTimers.clear()
  arrivingMessageIds.value = new Set()
}

function handleScroll() {
  cancelMessageRevealFrame()
  checkScroll()
}

function checkScroll() {
  scrollRevision++
  if (!messagesEl.value) return
  const el = messagesEl.value
  const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  isScrolledToBottom = !revealingMessage && distanceToBottom < 60
  if (el.scrollTop < 240 && props.hasOlderMessages && !props.isLoadingOlderMessages) {
    emit('loadOlder')
  }
  
  /* Show a scroll-to-bottom prompt if user scrolls quite far up */
  isScrolledFarUp.value = distanceToBottom > 1500
  
  if (isScrolledToBottom && unreadCount.value > 0) {
    unreadCount.value = 0
  }
}

function cancelMessageRevealFrame() {
  if (revealFrame !== null) window.cancelAnimationFrame(revealFrame)
  revealFrame = null
}

function cancelMessageReveal() {
  cancelMessageRevealFrame()
  if (revealTimer !== null) window.clearTimeout(revealTimer)
  revealFrame = revealTimer = null
  revealingMessage = false
}

function beginMessageReveal() {
  cancelMessageReveal()
  const element = messagesEl.value
  if (!element) return
  const top = element.scrollTop
  revealingMessage = true
  // Smooth scrolling may start after the first frame. Any scroll event cancels this probe.
  revealFrame = window.requestAnimationFrame(() => {
    revealFrame = window.requestAnimationFrame(() => {
      revealFrame = null
      if (messagesEl.value === element && element.scrollTop === top) finishMessageReveal()
    })
  })
  revealTimer = window.setTimeout(finishMessageReveal, 800)
}

function finishMessageReveal() {
  cancelMessageReveal()
  checkScroll()
}

function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
  unreadTimeline.programmaticScroll()
  if (!messagesEl.value) return
  cancelMessageReveal()
  isScrolledToBottom = true
  messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior })
  unreadCount.value = 0
  isScrolledFarUp.value = false
}

function findMessageElement(messageId: string): HTMLElement | null {
  if (!messagesEl.value || !messageId) return null
  return messagesEl.value.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(messageId)}"]`)
}

function scrollToMessage(messageId: string, behavior: ScrollBehavior = 'smooth') {
  const reply = [...props.messages, ...[...loadedThreadMessages.value.values()].flat()].find(message => message.id === messageId)
  const root = reply && messageThreadParentId(reply)
  if (root && !allRootMessages.value.some(message => message.id === root)) { void toggleThread(messageId); return }
  if (root) {
    if (activeThreadId.value !== root) toggleThread(root)
    threadRevealId.value = messageId
    void nextTick(() => scrollToMessage(root, behavior))
    return
  }

  messageMotion.cancel()
  unreadTimeline.programmaticScroll()
  const target = findMessageElement(messageId)
  if (!target) return
  scrollRevision++
  isScrolledToBottom = false
  if (behavior === 'instant') cancelMessageReveal()
  else beginMessageReveal()
  target.scrollIntoView({ behavior, block: 'center' })
  target.classList.add('jump-target')
  window.setTimeout(() => {
    target.classList.remove('jump-target')
  }, 1600)
}

// Scroll to first match when search changes
watch(() => props.searchQuery, async () => {
  await nextTick()
  const matchingReply = props.messages.find(message => matchedIds.value.has(message.id) && messageThreadParentId(message))
  if (matchingReply) { scrollToMessage(matchingReply.id); return }
  const firstMatch = messagesEl.value?.querySelector('.search-match')
  if (firstMatch) {
    unreadTimeline.programmaticScroll()
    scrollRevision++
    isScrolledToBottom = false
    beginMessageReveal()
    firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})

watch(() => props.roomIdentifier, (nextRoomIdentifier) => {
  scrollRevision++
  cancelMessageReveal()
  clearArrivals()
  // Retire the old room's reporter: cancel its 600ms qualification timers
  // (rows are no longer visible), flush its gathered evidence against the
  // room it was captured in, and start Room B with clean per-room state.
  clearVisibleMessageTimers()
  const retiring = readReporter
  readReporter = createReadEvidenceReporter({ roomIdentifier: nextRoomIdentifier || '' })
  void retiring.dispose()
})

// Coalesce layout changes into one follow, cancelled by navigation or scrolling.
const messageReactions = injectRoomMessageReactions()
const messageLinkPreviews = injectRoomMessageLinkPreviews()
watch([
  () => messageReactions?.revision.value,
  () => messageLinkPreviews?.revision.value,
], followLatestAfterLayout)


// Typing and composer growth resize the list without changing its messages.
let viewportResizeObserver: ResizeObserver | null = null
let observedViewportHeight = 0
function keepLatestInViewOnResize() {
  const el = messagesEl.value
  if (!el || el.clientHeight === observedViewportHeight) return
  const wasAtLatest = isScrolledToBottom || el.scrollHeight - el.scrollTop - observedViewportHeight < 60
  observedViewportHeight = el.clientHeight
  if (wasAtLatest && !revealingMessage) {
    isScrolledToBottom = true
    followLatestAfterLayout()
  }
}

watchMessageListGrowth(() => timelineMessages.value, async ({ prepended, appendedIds, addedCount }) => {
  if (prepended) {
    const el = messagesEl.value
    const previousScrollHeight = el?.scrollHeight || 0
    const revision = scrollRevision
    await nextTick()
    if (el && revision === scrollRevision) {
      unreadTimeline.programmaticScroll()
      el.scrollTop += el.scrollHeight - previousScrollHeight
    }
    observeMessageRows()
    return
  }

  if (appendedIds.length > 0) {
    markArrivals(appendedIds)
  }

  if (isScrolledToBottom) {
    followLatestAfterLayout()
  } else {
    unreadCount.value += addedCount
  }
  nextTick(() => {
    if (readObserver) observeMessageRows()
    else setupReadObserver()
  })
})

const motionMessages = () => timelineMessages.value.map(message => ({
  id: message.id, stableId: message.id, text: message.text,
  session: message.agent_identity?.agent_session_id, key: message.agent_identity?.agent_key,
}))

const workHandoff = useRoomWorkHandoff({
  work: () => currentAgentWork.value,
  identity: work => work,
  after: work => work.after,
  messages: motionMessages,
  scope: () => props.roomIdentifier,
  enabled: () => Boolean(props.messagesLoaded) && isScrolledToBottom,
})
const agentWork = workHandoff.work
watch(() => agentWork.value.map(work => work.id).join('|'), followLatestAfterLayout)

const messageMotion = useRoomMessageMotion({
  element: messagesEl,
  work: liveStripEl,
  scope: () => props.roomIdentifier,
  ready: () => Boolean(props.messagesLoaded),
  following: () => isScrolledToBottom,
  scrollToLatest: () => scrollToBottom('instant'),
  messages: motionMessages,
  onInterrupt: () => workHandoff.clear(),
})

// A requested message may be older than the loaded page: load a few older
// pages to find it, then give up quietly rather than paging the whole room.
const MAX_REVEAL_OLDER_PAGES = 20
let initialScrollSettled = false
let revealOlderPagesRequested = 0

function revealRequestedMessage() {
  const messageId = props.revealMessageId || unreadRevealId.value
  const isUnreadReveal = !props.revealMessageId && Boolean(unreadRevealId.value)
  if (!messageId) return

  const historyReady =
    initialScrollSettled &&
    (props.messagesLoaded ?? (props.messages.length > 0 || !props.hasOlderMessages))
  const found = props.messages.some(message => message.id === messageId)
    && (!isUnreadReveal || props.messages.some(message => message.id === messageId && (!message.thread_root_id || message.thread_root_id === message.id)))

  const action = decideMessageRevealAction({
    found,
    historyReady,
    hasOlder: Boolean(props.hasOlderMessages),
    loading: Boolean(props.isLoadingOlderMessages),
    pagesRequested: revealOlderPagesRequested,
    maxPages: MAX_REVEAL_OLDER_PAGES,
  })

  switch (action) {
    case 'scroll':
      scrollToMessage(messageId, isUnreadReveal ? 'instant' : 'smooth')
      revealOlderPagesRequested = 0
      if (isUnreadReveal) completeUnreadReveal(true)
      else emit('revealed', messageId)
      break
    case 'wait':
      // Still waiting for initial history, or a page load is currently in flight.
      break
    case 'load_older':
      revealOlderPagesRequested += 1
      emit('loadOlder')
      break
    case 'too_far_back':
      revealOlderPagesRequested = 0
      if (isUnreadReveal) { completeUnreadReveal(false); break }
      emit('revealUnavailable', messageId, 'too_far_back')
      emit('revealed', messageId)
      break
    case 'unavailable':
      revealOlderPagesRequested = 0
      if (isUnreadReveal) { completeUnreadReveal(false); break }
      emit('revealUnavailable', messageId, 'unavailable')
      emit('revealed', messageId)
      break
  }
}

watch(() => props.revealMessageId, () => { revealOlderPagesRequested = 0 })
// Registered after the messages watcher so a prepend has restored its scroll
// position before the reveal scrolls.
watch(
  () => [props.revealMessageId, props.messages, props.messages.length, props.isLoadingOlderMessages, props.messagesLoaded] as const,
  () => { void nextTick(revealRequestedMessage) },
)

// Viewport-based read evidence reporting. Each row must individually stay
// qualified for 600 ms before it becomes evidence; qualified numbers are
// flushed as contiguous ranges so a gap of unseen rows is never claimed read.
const visibleMessageTimers = new Map<string, number>()

/**
 * Scope lookup for read evidence: thread replies must report against their
 * thread scope or the server (correctly) refuses them as timeline evidence.
 */
function threadRootSeqForMessage(seq: number): number | null {
  const message = [...props.messages, ...[...loadedThreadMessages.value.values()].flat()].find((candidate) => candidate.id === `msg_${seq}`)
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
  if (!readEvidenceAllowed()) {
    clearVisibleMessageTimers()
    return
  }
  // The observer only reports rows whose visibility changes, so rows that
  // stayed on screen while the window was away need a fresh observer.
  setupReadObserver()
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

  observeMessageRows()
}

// Observing a row that is already observed does nothing, so rows already on
// screen keep their pending 600 ms timers while new messages keep arriving.
function observeMessageRows() {
  const elements = messagesEl.value?.querySelectorAll('.message[data-msg-id]') ?? []
  elements.forEach((el) => readObserver?.observe(el))
}

onMounted(() => {
  messagesEl.value?.addEventListener('scroll', handleScroll)
  if (typeof ResizeObserver !== 'undefined' && messagesEl.value) {
    observedViewportHeight = messagesEl.value.clientHeight
    viewportResizeObserver = new ResizeObserver(keepLatestInViewOnResize)
    viewportResizeObserver.observe(messagesEl.value)
  }
  document.addEventListener('visibilitychange', handleDocumentVisibilityChange)
  window.addEventListener('blur', handleDocumentVisibilityChange)
  window.addEventListener('focus', handleDocumentVisibilityChange)
  /* Use 'instant' so re-entering the chat tab doesn't visibly scroll from top */
  nextTick(() => {
    scrollToBottom('instant')
    setupReadObserver()
    initialScrollSettled = true
    revealRequestedMessage()
  })
})

onUnmounted(() => {
  clearArrivals()
  scrollRevision++
  cancelMessageReveal()
  viewportResizeObserver?.disconnect()
  completeUnreadReveal(false)
  messagesEl.value?.removeEventListener('scroll', handleScroll)
  document.removeEventListener('visibilitychange', handleDocumentVisibilityChange)
  window.removeEventListener('blur', handleDocumentVisibilityChange)
  window.removeEventListener('focus', handleDocumentVisibilityChange)
  if (readObserver) readObserver.disconnect()
  clearVisibleMessageTimers()
  void readReporter.dispose()
})

defineExpose({ matchCount: computed(() => matchedIds.value.size) })
</script>

<style scoped>
.thread-open-status { margin: 0; padding: 6px 24px; color: var(--muted); font-size: .8rem; }
.explicit-unread { transition: none !important; animation: none !important; display: flex; align-items: center; gap: 12px; font-size: 11px; color: var(--text-secondary); margin: 12px 0; }
.explicit-unread::before, .explicit-unread::after { content: ""; flex: 1; border-top: 1px solid var(--border-strong); }
.room-local-agent-work-list { margin: 6px auto 8px; }
.room-local-agent-work { cursor: default; }
.messages-wrap { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
/* The list and its floating pill. The live strip sits below it, outside the scroll. */
.messages-scroll { position: relative; flex: 1 1 0; min-height: 0; }
/* The strip owns the space under the last message, so its rows grow into that space without moving the list twice. */
.room-live-strip { min-height: 10px; padding: 0 20px; --room-chat-content-max: 720px; }

.messages {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 16px 20px 6px;
  --room-chat-content-max: 720px;
  scroll-behavior: smooth;
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
  bottom: 2px;
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
  white-space: nowrap;
  max-width: calc(100% - 24px);
  cursor: pointer;
  transition: transform 250ms ease, opacity 250ms ease;
}

.empty-state {
  position: absolute;
  inset: 0;
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
  .messages { padding: 12px 18px 6px; }
  .room-live-strip { min-height: 6px; padding: 0 18px; }
  .new-messages-pill { bottom: 2px; font-size: 0.7rem; padding: 5px 12px; }
  .empty-state { padding: 24px 16px; }
  .load-older-btn, .new-messages-pill { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .messages { scroll-behavior: auto; }

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
