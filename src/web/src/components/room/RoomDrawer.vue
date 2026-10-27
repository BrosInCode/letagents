<template>
  <Teleport to="body">
    <dialog ref="drawerElement" class="drawer" aria-label="Room settings" @cancel.prevent="emit('close')" @click="handleBackdropClick">
      <DrawerBrand @close="emit('close')" />

      <RouterLink class="drawer-work-link" to="/my-work" @click="emit('close')">My work <span aria-hidden="true">→</span></RouterLink>

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
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { type RoomInfo, type RoomMessage, useRoom } from '@/composables/useRoom'
import DrawerBrand from './room-drawer/DrawerBrand.vue'
import { messageDisplayText } from './chat-message/formatting'
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
const drawerElement = ref<HTMLDialogElement | null>(null)

function handleBackdropClick(event: MouseEvent) {
  const dialog = drawerElement.value
  if (!dialog || event.target !== dialog) return
  const bounds = dialog.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom) emit('close')
}

watch([() => props.open, drawerElement], ([open, dialog]) => {
  if (open && !dialog?.open) dialog?.showModal()
  else if (!open && dialog?.open) dialog.close()
}, { flush: 'post', immediate: true })

onBeforeUnmount(() => drawerElement.value?.close())

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
    `[${new Date(m.timestamp).toLocaleString()}] ${m.sender}: ${messageDisplayText(m)}`,
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

<style scoped>
.drawer-work-link { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; margin: 12px 0; border: 1px solid var(--border-strong); border-radius: 8px; color: var(--text); font-size: 13px; text-decoration: none; }
.drawer-work-link:hover { background: var(--accent-hover); }
</style>
