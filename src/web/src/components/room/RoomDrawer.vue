<template>
  <Teleport to="body">
    <div v-if="open" class="drawer-overlay" @click="emit('close')" />
    <aside :class="['drawer', { open }]">
      <DrawerBrand @close="emit('close')" />

      <ThemeToggle :is-dark="isDark" @toggle="toggleTheme" />

      <SharePanel
        :copied="codeCopied"
        :room-name="room?.displayName || ''"
        :share-display-value="shareDisplayValue"
        :share-kind="shareKind"
        :share-value="shareValue"
        @copy="copyShareValue"
      />

      <ParentRoomPanel
        v-if="parentRoomUrl"
        :display="parentRoomDisplay"
        :url="parentRoomUrl"
        @close="emit('close')"
      />

      <RulesShortcutPanel
        v-if="showRulesButton"
        @open-rules="emit('openRules')"
      />

      <SenderPalettePanel
        :overflow-count="overflowCount"
        :overflow-names="overflowNames"
        :visible-owners="visibleOwners"
      />

      <RoomNotesPanel
        :sound-enabled="soundEnabled"
        :status-text="statusText"
        @export-chat="exportChat"
        @toggle-sound="toggleSound"
      />

      <GitHubIntegrationPanel
        v-if="room && !ghLoading && ghStatus"
        :error="ghError"
        :installing="ghInstalling"
        :is-admin="room?.role === 'admin'"
        :loading="ghLoading"
        :status="ghStatus"
        @install="installGitHubApp"
        @setup="setupGitHubAppManifest"
      />
    </aside>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { type RoomInfo, type RoomMessage, useRoom } from '@/composables/useRoom'
import DrawerBrand from './room-drawer/DrawerBrand.vue'
import GitHubIntegrationPanel from './room-drawer/GitHubIntegrationPanel.vue'
import ParentRoomPanel from './room-drawer/ParentRoomPanel.vue'
import RoomNotesPanel from './room-drawer/RoomNotesPanel.vue'
import RulesShortcutPanel from './room-drawer/RulesShortcutPanel.vue'
import SenderPalettePanel from './room-drawer/SenderPalettePanel.vue'
import SharePanel from './room-drawer/SharePanel.vue'
import ThemeToggle from './room-drawer/ThemeToggle.vue'
import { useGitHubIntegration } from './room-drawer/useGitHubIntegration'
import { useRoomDrawerOwners } from './room-drawer/useRoomDrawerOwners'
import { useRoomDrawerShare } from './room-drawer/useRoomDrawerShare'

const props = defineProps<{
  open: boolean
  room: RoomInfo | null
  messages: readonly RoomMessage[]
  senderName?: string
  showRulesButton?: boolean
}>()

const emit = defineEmits<{ close: [], themeChange: [theme: string], openRules: [] }>()

const roomRef = toRef(props, 'room')
const messagesRef = toRef(props, 'messages')

const { soundEnabled, toggleSound } = useRoom()
const isDark = ref(localStorage.getItem('lac-theme') !== 'light')

const {
  codeCopied,
  copyShareValue,
  parentRoomDisplay,
  parentRoomUrl,
  shareDisplayValue,
  shareKind,
  shareValue,
} = useRoomDrawerShare(roomRef)

const {
  overflowCount,
  overflowNames,
  visibleOwners,
} = useRoomDrawerOwners(messagesRef)

const {
  fetchGitHubStatus,
  ghError,
  ghInstalling,
  ghLoading,
  ghStatus,
  installGitHubApp,
  setupGitHubAppManifest,
} = useGitHubIntegration(roomRef)

const statusText = computed(() => {
  if (!props.room) return 'Create or join a room to start live chat.'
  const parts: string[] = []
  if (props.senderName) parts.push(`Sending as ${props.senderName}`)
  parts.push(`Connected to ${props.room.displayName}`)
  return parts.join('; ') + '.'
})

function toggleTheme() {
  isDark.value = !isDark.value
  const newTheme = isDark.value ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', newTheme)
  localStorage.setItem('lac-theme', newTheme)
  emit('themeChange', newTheme)
}

function exportChat() {
  if (!props.messages.length) return
  const lines = props.messages.map(m =>
    `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${m.text}`,
  )
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `chat-export-${Date.now()}.txt`
  a.click()
  URL.revokeObjectURL(url)
}

watch(() => props.open, (isOpen) => {
  if (isOpen && props.room) fetchGitHubStatus()
})
</script>

<style src="./room-drawer/RoomDrawer.css"></style>
