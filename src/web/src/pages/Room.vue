<template>
  <div class="room-shell" :data-theme="theme">
    <RoomHeader
      :title="roomTitle"
      :subtitle="roomSubtitle"
      :activeTab="activeTab"
      :connectionState="connectionState"
      @toggleDrawer="drawerOpen = !drawerOpen"
      @update:activeTab="activeTab = $event"
    />

    <MessageList
      v-show="activeTab === 'chat'"
      :messages="messages"
    />

    <TaskBoard
      v-show="activeTab === 'board'"
      :tasks="tasks"
      @addTask="handleAddTask"
    />

    <Composer
      v-if="activeTab === 'chat'"
      :senderName="senderName"
      :autoKeepPolling="autoKeepPolling"
      :keepPollingIntervalSeconds="KEEP_POLLING_INTERVAL_MS / 1000"
      :injectKeepPolling="injectKeepPolling"
      @send="handleSend"
      @update:autoKeepPolling="handleAutoKeepPollingChange"
      @update:injectKeepPolling="handleInjectKeepPollingChange"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import RoomHeader from '@/components/room/RoomHeader.vue'
import MessageList from '@/components/room/MessageList.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'

const KEEP_POLLING_TEXT = 'keep polling'
const KEEP_POLLING_INTERVAL_MS = 20_000

const route = useRoute()
const { messages, tasks, room, connectionState, joinRoom, sendMessage, addTask } = useRoom()
const auth = useAuth()

const activeTab = ref<'chat' | 'board'>('chat')
const drawerOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const autoKeepPolling = ref(false)
const injectKeepPolling = ref(false)

let keepPollingTimer: ReturnType<typeof setInterval> | null = null
let keepPollingInFlight = false

const senderName = computed(() => auth.user.value?.login || 'anonymous')
const roomTitle = computed(() => room.value?.displayName || 'No active room')
const roomSubtitle = computed(() =>
  room.value
    ? `Room: ${room.value.name}`
    : 'Create a new room or join one.'
)

async function handleSend(text: string) {
  const finalText = injectKeepPolling.value ? appendKeepPollingInstruction(text) : text
  await sendMessage(finalText, senderName.value)
}

async function sendKeepPollingMessage() {
  if (!room.value || keepPollingInFlight) return
  keepPollingInFlight = true
  try {
    await sendMessage(KEEP_POLLING_TEXT, senderName.value)
  } finally {
    keepPollingInFlight = false
  }
}

function stopKeepPollingLoop() {
  if (keepPollingTimer) {
    clearInterval(keepPollingTimer)
    keepPollingTimer = null
  }
}

async function startKeepPollingLoop() {
  stopKeepPollingLoop()
  if (!autoKeepPolling.value || !room.value) return
  await sendKeepPollingMessage()
  keepPollingTimer = setInterval(() => {
    void sendKeepPollingMessage()
  }, KEEP_POLLING_INTERVAL_MS)
}

function handleAutoKeepPollingChange(enabled: boolean) {
  autoKeepPolling.value = enabled
}

function handleInjectKeepPollingChange(enabled: boolean) {
  injectKeepPolling.value = enabled
}

function appendKeepPollingInstruction(text: string) {
  if (text.toLowerCase().includes(KEEP_POLLING_TEXT)) {
    return text
  }
  return `${text}\n\n${KEEP_POLLING_TEXT}`
}

async function handleAddTask(title: string) {
  await addTask(title)
}

onMounted(async () => {
  await auth.checkSession()
  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  }
})

onUnmounted(() => {
  stopKeepPollingLoop()
})

watch(autoKeepPolling, (enabled) => {
  if (!enabled) {
    stopKeepPollingLoop()
    return
  }
  void startKeepPollingLoop()
})

watch(() => room.value?.projectId, (newProjectId, oldProjectId) => {
  if (!newProjectId) {
    stopKeepPollingLoop()
    return
  }
  if (!oldProjectId) {
    if (autoKeepPolling.value) {
      void startKeepPollingLoop()
    }
    return
  }
  if (newProjectId === oldProjectId) return
  stopKeepPollingLoop()
  autoKeepPolling.value = false
  injectKeepPolling.value = false
})

watch(() => route.params.roomId, async (newId) => {
  if (newId) {
    await joinRoom(newId as string)
  }
})
</script>

<style scoped>
.room-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  background: var(--bg-0, #09090b);
  color: var(--text, #fafafa);
}
</style>
