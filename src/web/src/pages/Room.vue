<template>
  <div class="room-shell" :data-theme="theme">
    <!-- Drawer -->
    <RoomDrawer
      :open="drawerOpen"
      :room="room"
      :messages="messages"
      @close="drawerOpen = false"
    />

    <RoomHeader
      :title="roomTitle"
      :subtitle="roomSubtitle"
      :activeTab="activeTab"
      :connectionState="connectionState"
      :searchQuery="searchQuery"
      :matchCount="matchCount"
      :canRename="room?.authenticated ?? false"
      @toggleDrawer="drawerOpen = !drawerOpen"
      @update:activeTab="activeTab = $event"
      @update:searchQuery="searchQuery = $event"
      @rename="handleRename"
    />

    <div v-if="connectionState === 'error' && !isConnected" class="room-error">
      <p>Could not connect to room.</p>
      <button class="retry-btn" @click="retryJoin">Retry</button>
    </div>

    <MessageList
      v-show="activeTab === 'chat' && isConnected"
      ref="messageListRef"
      :messages="messages"
      :searchQuery="searchQuery"
    />

    <TaskBoard
      v-show="activeTab === 'board' && isConnected"
      :tasks="tasks"
      @addTask="handleAddTask"
    />

    <Composer
      v-if="activeTab === 'chat' && isConnected"
      :senderName="senderName"
      @send="handleSend"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import RoomHeader from '@/components/room/RoomHeader.vue'
import RoomDrawer from '@/components/room/RoomDrawer.vue'
import MessageList from '@/components/room/MessageList.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'

const route = useRoute()
const { messages, tasks, room, isConnected, connectionState, joinRoom, sendMessage, addTask, restoreSession, renameRoom } = useRoom()
const auth = useAuth()

const activeTab = ref<'chat' | 'board'>('chat')
const drawerOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchQuery = ref('')
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)

const matchCount = computed(() => messageListRef.value?.matchCount ?? 0)
const senderName = computed(() => auth.user.value?.login || 'anonymous')
const roomTitle = computed(() => room.value?.displayName || 'Connecting...')
const roomSubtitle = computed(() =>
  room.value
    ? `Room: ${room.value.name}`
    : connectionState.value === 'connecting' ? 'Joining room...' : 'Create a new room or join one.'
)

async function handleSend(text: string) {
  await sendMessage(text, senderName.value)
}

async function handleAddTask(title: string) {
  await addTask(title)
}

async function handleRename() {
  const newName = prompt('Rename room:', room.value?.displayName || '')
  if (newName && newName.trim()) {
    await renameRoom(newName.trim())
  }
}

async function retryJoin() {
  const roomId = route.params.roomId as string
  if (roomId) await joinRoom(roomId)
}

onMounted(async () => {
  await auth.checkSession()
  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  } else {
    await restoreSession()
  }
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

.room-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--muted, #71717a);
}

.retry-btn {
  padding: 8px 20px;
  border-radius: 8px;
  border: 1px solid var(--border, #27272a);
  background: var(--surface, #18181b);
  color: var(--text, #fafafa);
  cursor: pointer;
  font-size: 0.85rem;
  transition: background 0.15s;
}
.retry-btn:hover {
  background: var(--border, #27272a);
}
</style>
