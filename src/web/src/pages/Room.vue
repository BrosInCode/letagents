<template>
  <div class="room-shell" :data-theme="theme">
    <!-- Drawer overlay -->
    <div class="drawer-overlay" :class="{ open: drawerOpen }" @click="drawerOpen = false" />

    <!-- Drawer -->
    <RoomDrawer
      v-if="drawerOpen"
      :room="room"
      :theme="theme"
      :soundEnabled="soundEnabled"
      :ownerLegend="ownerLegend"
      :shareKind="shareKind"
      :shareValue="shareValue"
      :shareDisplayValue="shareDisplayValue"
      class="open"
      @close="drawerOpen = false"
      @toggleTheme="toggleTheme"
      @toggleSound="toggleSound"
      @export="downloadExport"
      @copyShare="handleCopyShare"
    />

    <RoomHeader
      :title="roomTitle"
      :subtitle="roomSubtitle"
      :activeTab="activeTab"
      :connectionState="connectionState"
      :isAdmin="isAdmin"
      :searchActive="searchActive"
      @toggleDrawer="drawerOpen = !drawerOpen"
      @update:activeTab="switchTab"
      @rename="handleRename"
      @toggleSearch="searchActive = !searchActive"
      @search="handleSearch"
      @closeSearch="closeSearch"
    />

    <MessageList
      v-show="activeTab === 'chat'"
      :messages="filteredMessages"
      :searchQuery="searchQuery"
    />

    <TaskBoard
      v-show="activeTab === 'board'"
      :tasks="tasks"
      @addTask="handleAddTask"
      @updateTask="handleUpdateTask"
    />

    <Composer
      v-if="activeTab === 'chat'"
      :senderName="senderName"
      :disabled="!room"
      @send="handleSend"
    />

    <ToastContainer />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import { useToast } from '@/composables/useToast'
import RoomHeader from '@/components/room/RoomHeader.vue'
import MessageList from '@/components/room/MessageList.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'
import RoomDrawer from '@/components/room/RoomDrawer.vue'
import ToastContainer from '@/components/ui/ToastContainer.vue'

const route = useRoute()
const router = useRouter()
const {
  messages, tasks, room, connectionState, soundEnabled,
  joinRoom, sendMessage, addTask, updateTask, refreshTasks,
  renameRoom, downloadExport, toggleSound,
  getRoomShareKind, getRoomShareValue, getRoomShareDisplayValue,
  getOwnerLegend,
} = useRoom()
const auth = useAuth()
const { show: showToast } = useToast()

const activeTab = ref<'chat' | 'board'>('chat')
const drawerOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchActive = ref(false)
const searchQuery = ref('')

const senderName = computed(() => {
  if (auth.user.value?.display_name) return auth.user.value.display_name
  if (auth.user.value?.login) return auth.user.value.login
  return 'anonymous'
})
const roomTitle = computed(() => room.value?.displayName || 'No active room')
const roomSubtitle = computed(() =>
  room.value
    ? (room.value.name || room.value.code || room.value.projectId)
    : 'Create a new room or join one with a code.'
)
const isAdmin = computed(() => room.value?.role === 'admin')
const shareKind = computed(() => getRoomShareKind())
const shareValue = computed(() => getRoomShareValue())
const shareDisplayValue = computed(() => getRoomShareDisplayValue())
const ownerLegend = computed(() => getOwnerLegend())

const filteredMessages = computed(() => {
  if (!searchQuery.value) return messages.value
  return messages.value // filtering done in MessageList
})

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  localStorage.setItem('lac-theme', theme.value)
}

function switchTab(tab: 'chat' | 'board') {
  activeTab.value = tab
  if (tab === 'board') {
    refreshTasks()
  }
}

async function handleSend(text: string) {
  const ok = await sendMessage(text, senderName.value)
  if (!ok) showToast('Could not send message.', 'error')
}

async function handleAddTask(title: string) {
  const ok = await addTask(title)
  if (ok) showToast('Task added.', 'success')
  else showToast('Could not add task.', 'error')
}

async function handleUpdateTask(taskId: string, newStatus: string) {
  const ok = await updateTask(taskId, newStatus)
  if (ok) showToast(`Task updated to ${newStatus.replace(/_/g, ' ')}.`, 'success')
  else showToast('Could not update task.', 'error')
}

async function handleRename() {
  const current = room.value?.displayName || room.value?.name || ''
  const next = window.prompt('Choose a room display name.', current)
  if (!next || !next.trim()) return
  const ok = await renameRoom(next.trim())
  if (ok) showToast(`Renamed room to ${next.trim()}.`, 'success')
  else showToast('Could not rename room.', 'error')
}

async function handleCopyShare() {
  const value = getRoomShareValue()
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    const kind = getRoomShareKind()
    showToast(kind === 'url' ? 'Copied room URL.' : `Copied invite code ${value}.`, 'success')
  } catch {
    showToast('Clipboard access failed.', 'error')
  }
}

function handleSearch(query: string) {
  searchQuery.value = query
}

function closeSearch() {
  searchActive.value = false
  searchQuery.value = ''
}

// Apply theme on mount
function initTheme() {
  const saved = localStorage.getItem('lac-theme')
  const systemTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  theme.value = saved || systemTheme
  document.documentElement.setAttribute('data-theme', theme.value)
}

onMounted(async () => {
  initTheme()
  await auth.checkSession()
  const roomId = route.params.roomId as string
  if (roomId) {
    const ok = await joinRoom(roomId)
    if (!ok) showToast('Could not join room.', 'error')
  }
})

watch(() => route.params.roomId, async (newId) => {
  if (newId) {
    const ok = await joinRoom(newId as string)
    if (!ok) showToast('Could not join room.', 'error')
  }
})
</script>

<style scoped>
.room-shell {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100vh;
  background: var(--bg-0);
  color: var(--text);
}

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.5);
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}
.drawer-overlay.open {
  opacity: 1;
  pointer-events: auto;
}
</style>
