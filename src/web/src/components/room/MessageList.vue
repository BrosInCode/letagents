<template>
  <div class="messages-wrap">
    <div class="messages" ref="messagesEl">
      <ChatMessage
        v-for="msg in sortedMessages"
        :key="msg.id"
        :message="msg"
        :searchQuery="searchQuery"
      />
    </div>
    <button
      v-if="unreadCount > 0"
      class="new-messages-pill visible"
      @click="scrollToNextUnread"
    >
      ↓ {{ unreadCount }} new messages
    </button>
    <div v-if="sortedMessages.length === 0" class="empty-state">
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
  searchQuery?: string
}>()

const messagesEl = ref<HTMLElement | null>(null)
const unreadCount = ref(0)
const unreadIds = ref<string[]>([])
let isScrolledToBottom = true

function checkScroll() {
  if (!messagesEl.value) return
  const el = messagesEl.value
  isScrolledToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  if (isScrolledToBottom && unreadIds.value.length > 0) {
    unreadIds.value = []
    unreadCount.value = 0
  }
}

function scrollToBottom(force = false) {
  if (!messagesEl.value) return
  if (force || isScrolledToBottom) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    unreadIds.value = []
    unreadCount.value = 0
  }
}

function scrollToNextUnread() {
  if (unreadIds.value.length === 0) return
  const nextId = unreadIds.value.shift()!
  unreadCount.value = unreadIds.value.length
  const el = messagesEl.value?.querySelector(`[data-msg-id="${nextId}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

const sortedMessages = computed(() =>
  [...props.messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
)

watch(() => props.messages.length, async (newLen, oldLen) => {
  const diff = newLen - (oldLen || 0)
  if (diff > 0) {
    if (isScrolledToBottom) {
      await nextTick()
      scrollToBottom(true)
    } else {
      // Track new unread message IDs
      const newMessages = sortedMessages.value.slice(-diff)
      unreadIds.value.push(...newMessages.map(m => m.id))
      unreadCount.value = unreadIds.value.length
    }
  }
})

// When search query changes, scroll to first match
watch(() => props.searchQuery, async (query) => {
  if (query) {
    await nextTick()
    const firstMatch = messagesEl.value?.querySelector('.search-match')
    if (firstMatch) {
      firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }
})

onMounted(() => {
  messagesEl.value?.addEventListener('scroll', checkScroll)
  nextTick(() => scrollToBottom(true))
})

onUnmounted(() => {
  messagesEl.value?.removeEventListener('scroll', checkScroll)
})
</script>

<style scoped>
.messages-wrap { position: relative; min-height: 0; overflow: hidden; flex: 1; }

.messages {
  height: 100%; overflow-y: auto;
  padding: 16px 20px; scroll-behavior: smooth;
}
.messages::before {
  content: ''; position: sticky; top: 0; display: block;
  height: 12px; background: linear-gradient(var(--bg-0), transparent);
  pointer-events: none; z-index: 1;
}

.new-messages-pill {
  position: absolute; bottom: 12px; left: 50%;
  transform: translateX(-50%) translateY(50px);
  z-index: 10; display: flex; align-items: center; gap: 4px;
  padding: 6px 16px; border-radius: 999px;
  background: var(--text); color: var(--bg-0);
  font-size: 0.75rem; font-weight: 600; border: none; cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: transform 250ms ease, opacity 250ms ease;
}
.new-messages-pill.visible {
  opacity: 1; pointer-events: auto;
  transform: translateX(-50%) translateY(0);
}

.empty-state {
  display: grid; place-items: center; height: 100%;
  padding: 40px 20px; text-align: center;
}
.empty-state-card { max-width: 320px; }
.empty-state-card h3 { font-size: 0.92rem; font-weight: 600; margin-bottom: 6px; }
.empty-state-card p { font-size: 0.82rem; color: var(--muted); line-height: 1.5; }

@media (max-width: 640px) {
  .messages { padding: 12px; }
}
</style>
