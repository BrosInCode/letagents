<template>
  <div class="messages-wrap">
    <div class="messages" ref="messagesEl">
      <ChatMessage
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
      />
    </div>
    <button
      v-if="unreadCount > 0"
      class="new-messages-pill visible"
      @click="scrollToBottom"
    >
      ↓ {{ unreadCount }} new messages
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
import { ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { type RoomMessage } from '@/composables/useRoom'
import ChatMessage from './ChatMessage.vue'

const props = defineProps<{
  messages: readonly RoomMessage[]
}>()

const messagesEl = ref<HTMLElement | null>(null)
const unreadCount = ref(0)
let isScrolledToBottom = true

function checkScroll() {
  if (!messagesEl.value) return
  const el = messagesEl.value
  isScrolledToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

function scrollToBottom() {
  if (!messagesEl.value) return
  messagesEl.value.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })
  unreadCount.value = 0
}

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
</script>

<style scoped>
.messages-wrap { position: relative; min-height: 0; overflow: hidden; flex: 1; }

.messages {
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
  scroll-behavior: smooth;
}
.messages::before {
  content: '';
  position: sticky;
  top: 0;
  display: block;
  height: 12px;
  background: linear-gradient(var(--bg-0, #09090b), transparent);
  pointer-events: none;
  z-index: 1;
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
</style>
