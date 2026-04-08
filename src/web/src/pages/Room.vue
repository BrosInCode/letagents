<template>
  <div class="room-shell" :data-theme="theme">
    <!-- Drawer -->
    <RoomDrawer
      :open="drawerOpen"
      :room="room"
      :messages="messages"
      :senderName="senderName"
      @close="drawerOpen = false"
      @themeChange="theme = $event"
    />

    <RoomHeader
      :title="roomTitle"
      :subtitle="roomSubtitle"
      :activeTab="activeTab"
      :connectionState="connectionState"
      :searchQuery="searchQuery"
      :matchCount="matchCount"
      :canRename="room?.role === 'admin'"
      :showEventsTab="githubEventsSupported"
      @toggleDrawer="drawerOpen = !drawerOpen"
      @update:activeTab="activeTab = $event"
      @update:searchQuery="searchQuery = $event"
      @rename="handleRename"
    />

    <div v-if="connectionState === 'error' && !isConnected" class="room-error">
      <p class="room-error-title">{{ joinErrorTitle }}</p>
      <p class="room-error-body">{{ joinErrorBody }}</p>
      <div class="room-error-actions">
        <button v-if="showGitHubSignIn" class="retry-btn" @click="handleSignIn">
          Sign in with GitHub
        </button>
        <button class="retry-btn secondary" @click="retryJoin">Retry</button>
      </div>
    </div>

    <MessageList
      v-show="activeTab === 'chat' && isConnected"
      ref="messageListRef"
      :messages="messages"
      :searchQuery="searchQuery"
      @reply="selectedReply = $event"
    />

    <GitHubEventFeed
      v-show="githubEventsSupported && activeTab === 'events' && isConnected"
      :events="githubEvents"
      :repository="room?.name || room?.identifier || null"
      :isAvailable="githubEventsAvailable"
      :hasMore="githubEventsHasMore"
      :errorMessage="githubEventsError?.message || null"
      :isLoading="githubEventsLoading"
    />

    <TaskBoard
      v-show="activeTab === 'board' && isConnected"
      :tasks="tasks"
      :presence="presence"
      :taskGithubStatus="taskGithubStatus"
      @addTask="handleAddTask"
      @updateTask="handleUpdateTask"
    />

    <Composer
      v-if="activeTab === 'chat' && isConnected"
      :senderName="senderName"
      :roomIdentifier="room?.identifier || ''"
      :replyTo="selectedReply"
      @send="handleSend"
      @clearReply="selectedReply = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useRoom } from '@/composables/useRoom'
import { useAuth } from '@/composables/useAuth'
import RoomHeader from '@/components/room/RoomHeader.vue'
import RoomDrawer from '@/components/room/RoomDrawer.vue'
import MessageList from '@/components/room/MessageList.vue'
import GitHubEventFeed from '@/components/room/GitHubEventFeed.vue'
import Composer from '@/components/room/Composer.vue'
import TaskBoard from '@/components/room/TaskBoard.vue'
import type { RoomMessage } from '@/composables/useRoom'

const route = useRoute()
const router = useRouter()
const {
  messages,
  tasks,
  presence,
  taskGithubStatus,
  githubEvents,
  githubEventsAvailable,
  githubEventsHasMore,
  githubEventsError,
  githubEventsSupported,
  githubEventsLoading,
  room,
  isConnected,
  connectionState,
  joinError,
  joinRoom,
  sendMessage,
  addTask,
  updateTask,
  restoreSession,
  renameRoom,
  refreshRoomGitHubEvents,
} = useRoom()
const auth = useAuth()

type ViewTab = 'chat' | 'events' | 'board'
const VALID_TABS: ViewTab[] = ['chat', 'events', 'board']

function readTabFromQuery(): ViewTab {
  const q = route.query.view
  if (typeof q === 'string' && VALID_TABS.includes(q as ViewTab)) {
    return q as ViewTab
  }
  return 'chat'
}

const activeTab = ref<ViewTab>(readTabFromQuery())
const drawerOpen = ref(false)
const theme = ref(localStorage.getItem('lac-theme') || 'dark')
const searchQuery = ref('')
const messageListRef = ref<InstanceType<typeof MessageList> | null>(null)
const selectedReply = ref<RoomMessage | null>(null)

const matchCount = computed(() => messageListRef.value?.matchCount ?? 0)
const senderName = computed(() => auth.user.value?.login || 'anonymous')
const roomTitle = computed(() => room.value?.displayName || 'Connecting...')
const roomSubtitle = computed(() =>
  room.value
    ? `Room: ${room.value.name}`
    : connectionState.value === 'connecting' ? 'Joining room...' : 'Create a new room or join one.'
)
const showGitHubSignIn = computed(() => joinError.value?.code === 'NOT_AUTHENTICATED')
const joinErrorTitle = computed(() => {
  if (joinError.value?.code === 'NOT_AUTHENTICATED') {
    return 'GitHub sign-in required'
  }
  if (joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
    return 'No repo access'
  }
  return 'Could not connect to room.'
})
const joinErrorBody = computed(() => {
  if (joinError.value?.code === 'NOT_AUTHENTICATED') {
    return 'This repo-backed room requires GitHub sign-in before you can join.'
  }
  if (joinError.value?.code === 'PRIVATE_REPO_NO_ACCESS') {
    const login = auth.user.value?.login
    return login
      ? `Signed in as ${login}, but that account does not have access to this private repo room.`
      : 'Your current account does not have access to this private repo room.'
  }
  return joinError.value?.message || 'Could not connect to room.'
})

async function handleSend(text: string, agentPromptKind: string | null, replyTo: string | null) {
  const sent = await sendMessage(text, senderName.value, agentPromptKind, replyTo)
  if (sent) {
    selectedReply.value = null
  }
}

async function handleAddTask(title: string) {
  await addTask(title)
}

async function handleUpdateTask(taskId: string, updates: { status: string }) {
  await updateTask(taskId, updates as any)
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

async function handleSignIn() {
  const roomId = route.params.roomId as string
  await auth.signIn(roomId ? `/in/${roomId}` : '/')
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
  selectedReply.value = null
  if (newId) {
    await joinRoom(newId as string)
  }
})

watch(activeTab, async (tab) => {
  // Sync tab to URL query — use push so back/forward steps through views
  const currentView = route.query.view
  if (currentView !== tab) {
    const query = { ...route.query, view: tab === 'chat' ? undefined : tab }
    router.push({ query })
  }
  if (tab === 'events' && isConnected.value && githubEventsSupported.value) {
    await refreshRoomGitHubEvents()
  }
})

// When URL query changes externally (e.g. back/forward), sync tab
watch(() => route.query.view, (newView) => {
  const tab = readTabFromQuery()
  if (activeTab.value !== tab) {
    activeTab.value = tab
  }
})

watch(githubEventsSupported, (supported) => {
  // Only reset away from events after we've connected and confirmed no support
  if (!supported && activeTab.value === 'events' && isConnected.value) {
    activeTab.value = 'chat'
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

.room-error-title {
  margin: 0;
  color: var(--text, #fafafa);
  font-size: 1rem;
  font-weight: 700;
}

.room-error-body {
  margin: 0;
  max-width: 420px;
  text-align: center;
  line-height: 1.6;
}

.room-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
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

.retry-btn.secondary {
  background: transparent;
  color: var(--muted, #a1a1aa);
}
</style>
