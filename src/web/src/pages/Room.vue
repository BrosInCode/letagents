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
import MessageList from '@/components/room/MessageList.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'

const route = useRoute()
const { messages, tasks, room, connectionState, joinRoom, sendMessage, addTask } = useRoom()
const auth = useAuth()

const activeTab = ref<'chat' | 'board'>('chat')
const drawerOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')

const senderName = computed(() => auth.session.value?.username || 'anonymous')
const roomTitle = computed(() => room.value?.displayName || 'No active room')
const roomSubtitle = computed(() =>
  room.value
    ? `Room: ${room.value.name}`
    : 'Create a new room or join one.'
)

async function handleSend(text: string) {
  await sendMessage(text, senderName.value)
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
