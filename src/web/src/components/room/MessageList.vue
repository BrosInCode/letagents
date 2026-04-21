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
      <ChatMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
        :thread="threadSummaries.get(msg.id) || null"
        :stalePromptMuteStates="stalePromptMuteStates"
        :class="searchClasses(msg)"
        :searchQuery="searchQuery"
        @reply="emit('reply', $event)"
        @scrollToReply="scrollToMessage"
        @toggleStalePromptMute="emit('toggleStalePromptMute', $event.taskId, $event.muted)"
      />
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { type RoomMessage } from '@/composables/useRoom'
import ChatMessage from './ChatMessage.vue'

const props = defineProps<{
  messages: readonly RoomMessage[]
  hasOlderMessages?: boolean
  isLoadingOlderMessages?: boolean
  searchQuery?: string
  stalePromptMuteStates?: Readonly<Record<string, boolean>>
}>()
const emit = defineEmits<{
  loadOlder: []
  reply: [message: RoomMessage]
  toggleStalePromptMute: [taskId: string, muted: boolean]
}>()

const messagesEl = ref<HTMLElement | null>(null)
const unreadCount = ref(0)
const isScrolledFarUp = ref(false)
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

interface MessageThreadSummary {
  count: number
  latest: RoomMessage | null
}

const threadSummaries = computed(() => {
  const summaries = new Map<string, MessageThreadSummary>()

  for (const msg of props.messages) {
    const parentId = msg.reply_to?.id
    if (!parentId) continue

    const summary = summaries.get(parentId) || { count: 0, latest: null }
    summary.count += 1
    summary.latest = msg
    summaries.set(parentId, summary)
  }

  return summaries
})

function searchClasses(msg: RoomMessage): Record<string, boolean> {
  const q = (props.searchQuery || '').trim()
  if (!q) return {}
  const isMatch = matchedIds.value.has(msg.id)
  return {
    'search-dim': !isMatch,
    'search-match': isMatch,
  }
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

    if (isScrolledToBottom) {
      await nextTick()
      scrollToBottom()
    } else {
      unreadCount.value += newLen - oldLen
    }
  }
})

onMounted(() => {
  messagesEl.value?.addEventListener('scroll', checkScroll)
  /* Use 'instant' so re-entering the chat tab doesn't visibly scroll from top */
  nextTick(() => scrollToBottom('instant'))
})

onUnmounted(() => {
  messagesEl.value?.removeEventListener('scroll', checkScroll)
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
</style>

<style>
/* Global search styles (not scoped, applied to ChatMessage children) */
.search-dim { opacity: 0.15; transition: opacity 0.2s; }
.search-match {
  border-left: 2px solid var(--success, #34d399);
  padding-left: 8px;
  transition: all 0.2s;
}
</style>
