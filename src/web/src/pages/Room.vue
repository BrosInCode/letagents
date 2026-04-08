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
      @update:activeTab="handleActiveTabChange"
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
      :taskGithubStatus="taskGithubStatus"
      @addTask="handleAddTask"
      @updateTask="handleUpdateTask"
    />

    <ActivityView
      v-show="activeTab === 'activity' && isConnected"
      :messages="messages"
      :presence="presence"
      :tasks="tasks"
      :taskGithubStatus="taskGithubStatus"
    />

    <Composer
      v-if="activeTab === 'chat' && isConnected"
      :senderName="senderName"
      :roomIdentifier="room?.identifier || ''"
      :replyTo="selectedReply"
      :messages="messages"
      :presence="presence"
      @send="handleSend"
      @clearReply="selectedReply = null"
    />

    <!-- Mobile bottom navigation -->
    <nav v-if="isConnected" class="mobile-bottom-nav" role="tablist" aria-label="Room navigation">
      <button
        role="tab"
        :aria-selected="activeTab === 'chat'"
        :class="{ active: activeTab === 'chat' }"
        @click="handleActiveTabChange('chat')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span>Chat</span>
      </button>
      <button
        v-if="githubEventsSupported"
        role="tab"
        :aria-selected="activeTab === 'events'"
        :class="{ active: activeTab === 'events' }"
        @click="handleActiveTabChange('events')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        <span>Events</span>
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'board'"
        :class="{ active: activeTab === 'board' }"
        @click="handleActiveTabChange('board')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        <span>Board</span>
      </button>
      <button
        role="tab"
        :aria-selected="activeTab === 'activity'"
        :class="{ active: activeTab === 'activity' }"
        @click="handleActiveTabChange('activity')"
        type="button"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        <span>Activity</span>
      </button>
    </nav>
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
import ActivityView from '@/components/room/ActivityView.vue'
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

type RoomTab = 'chat' | 'events' | 'board' | 'activity'
const VALID_TABS: RoomTab[] = ['chat', 'events', 'board', 'activity']
const activeTab = ref<RoomTab>('chat')
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

function normalizeRoomTab(rawValue: unknown): RoomTab {
  const requested = typeof rawValue === 'string' ? rawValue : ''
  if (!VALID_TABS.includes(requested as RoomTab)) {
    return 'chat'
  }

  if (requested === 'events' && !githubEventsSupported.value) {
    return 'chat'
  }

  return requested as RoomTab
}

function syncViewQuery(tab: RoomTab, mode: 'push' | 'replace' = 'replace') {
  const current = typeof route.query.view === 'string' ? route.query.view : ''
  if (current === tab) {
    return
  }

  const navigate = mode === 'push' ? router.push : router.replace
  void navigate({
    query: {
      ...route.query,
      view: tab,
    },
  })
}

function applyRouteTab(rawValue: unknown) {
  const nextTab = normalizeRoomTab(rawValue)
  if (activeTab.value !== nextTab) {
    activeTab.value = nextTab
  }
  syncViewQuery(nextTab, 'replace')
}

function handleActiveTabChange(rawValue: RoomTab) {
  const nextTab = normalizeRoomTab(rawValue)
  if (activeTab.value !== nextTab) {
    activeTab.value = nextTab
  }
  syncViewQuery(nextTab, 'push')
}

onMounted(async () => {
  await auth.checkSession()
  const roomId = route.params.roomId as string
  if (roomId) {
    await joinRoom(roomId)
  } else {
    await restoreSession()
  }

  applyRouteTab(route.query.view)
})

watch(() => route.params.roomId, async (newId) => {
  selectedReply.value = null
  if (newId) {
    await joinRoom(newId as string)
  }

  applyRouteTab(route.query.view)
})

watch(() => route.query.view, (newView) => {
  applyRouteTab(newView)
})

watch(activeTab, async (tab) => {
  if (tab === 'events' && isConnected.value && githubEventsSupported.value) {
    await refreshRoomGitHubEvents()
  }
})

watch(githubEventsSupported, (supported) => {
  // Only reset away from events after we've connected and confirmed no support
  if (!supported && activeTab.value === 'events' && isConnected.value) {
    activeTab.value = 'chat'
    syncViewQuery('chat', 'replace')
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

/* ── Mobile bottom navigation ── */
.mobile-bottom-nav {
  display: none;
}

@media (max-width: 768px) {
  .room-shell { height: 100dvh; }
  .room-error { padding: 24px 16px; }
  .room-error-body { font-size: 0.85rem; }

  .mobile-bottom-nav {
    display: flex;
    align-items: center;
    justify-content: space-around;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    padding: 0 4px env(safe-area-inset-bottom, 0px);
    background: var(--bg-0, #09090b);
    border-top: 1px solid var(--line, #27272a);
    position: sticky;
    bottom: 0;
    z-index: 50;
  }

  .mobile-bottom-nav button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    flex: 1;
    padding: 6px 0;
    border: none;
    background: none;
    color: var(--muted, #71717a);
    cursor: pointer;
    transition: color 150ms;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-bottom-nav button svg {
    width: 20px;
    height: 20px;
  }

  .mobile-bottom-nav button span {
    font-size: 0.65rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .mobile-bottom-nav button.active,
  .mobile-bottom-nav button[aria-selected="true"] {
    color: var(--accent, #6366f1);
  }

  .mobile-bottom-nav button:hover:not(.active) {
    color: var(--text, #fafafa);
  }
}
</style>
