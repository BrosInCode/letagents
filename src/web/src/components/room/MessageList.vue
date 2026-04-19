<template>
  <div class="messages-wrap">
    <div class="messages scroll-fade-y" ref="messagesEl">
      <ChatMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
        :class="searchClasses(msg)"
        :searchQuery="searchQuery"
        @reply="emit('reply', $event)"
        @scrollToReply="scrollToMessage"
      />
    </div>
    <button
      v-if="unreadCount > 0 || isScrolledFarUp"
      class="new-messages-pill visible"
      @click="scrollToBottom"
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
  searchQuery?: string
}>()
const emit = defineEmits<{
  reply: [message: RoomMessage]
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
  
  /* Show a scroll-to-bottom prompt if user scrolls quite far up */
  isScrolledFarUp.value = distanceToBottom > 1500
  
  if (isScrolledToBottom && unreadCount.value > 0) {
    unreadCount.value = 0
  }
}

function scrollToBottom() {
  if (!messagesEl.value) return
  messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })
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

watch(() => props.messages.length, async (newLen, oldLen) => {
  if (newLen > (oldLen || 0)) {
    if (isScrolledToBottom) {
      await nextTick()
      scrollToBottom()
    } else {
      unreadCount.value += newLen - (oldLen || 0)
    }
  }
})

onMounted(() => {
  messagesEl.value?.addEventListener('scroll', checkScroll)
  nextTick(scrollToBottom)
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
