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
  messages: RoomMessage[]
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
.messages-wrap {
  position: relative;
  min-height: 0;
  overflow: hidden;
  flex: 1;
}

.messages {
  height: 100%;
  overflow-y: auto;
  padding: 24px 24px 18px;
  scroll-behavior: smooth;
}
.messages::before {
  content: '';
  position: sticky;
  top: 0;
  display: block;
  height: 20px;
  background: linear-gradient(rgba(17, 17, 19, 0.98), transparent);
  pointer-events: none;
  z-index: 1;
}

.messages > * {
  max-width: 980px;
  margin: 0 auto;
}

.new-messages-pill {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 16px;
  border-radius: 999px;
  background: rgba(244, 244, 245, 0.92);
  color: #101013;
  font-size: 0.72rem;
  font-weight: 600;
  border: none;
  cursor: pointer;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22);
  transition: transform 250ms ease, opacity 250ms ease, box-shadow 200ms ease;
}

.new-messages-pill:hover {
  transform: translateX(-50%) translateY(-1px);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
}

.empty-state {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 40px 20px;
  text-align: center;
}
.empty-state-card {
  max-width: 360px;
  padding: 28px 28px 24px;
  border-radius: 24px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.02));
  box-shadow: 0 24px 56px rgba(0, 0, 0, 0.25);
}
.empty-state-card h3 {
  font-size: 1rem;
  font-weight: 650;
  margin-bottom: 8px;
}
.empty-state-card p {
  font-size: 0.84rem;
  color: rgba(255, 255, 255, 0.56);
  line-height: 1.6;
}

@media (max-width: 900px) {
  .messages {
    padding: 18px 14px 14px;
  }
}
</style>
