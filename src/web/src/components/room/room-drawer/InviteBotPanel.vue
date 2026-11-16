<template>
  <div ref="panel" class="drawer-section drawer-panel invite-bot-panel" :data-attention="attention || undefined" data-testid="invite-bot-panel">
    <div class="drawer-section-title">
      <h2>Invite a bot</h2>
      <span>For the bot's owner</span>
    </div>
    <InviteBotSection
      ref="section"
      :room="inviteRoom"
      :admin="room.role === 'admin'"
      :git-room="room.gitRoom !== null"
      git-room-hint="Open an invite room and invite the bot there."
      :create-invite="createInvite"
      :cancel-invite="cancelInvite"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import InviteBotSection from '../../../../../../shared/ui/InviteBotSection.vue'
import { inviteBotConnectorUrl, type InviteBotPlatform } from '../../../../../../shared/ui/invite-bot'
import { cancelRoomInvite, createRoomInvite } from '@/composables/room/invites'
import type { RoomInfo } from '@/composables/useRoom'

const props = defineProps<{ room: RoomInfo }>()
const panel = ref<HTMLElement | null>(null)
const section = ref<InstanceType<typeof InviteBotSection> | null>(null)
const attention = ref(false)
let attentionTimer: ReturnType<typeof setTimeout> | undefined

/** From the composer's "+": scroll here, open the invite on the bot picker, and draw the eye once. */
function openAndFocus() {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  panel.value?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  section.value?.openSection()
  attention.value = true
  clearTimeout(attentionTimer)
  attentionTimer = setTimeout(() => { attention.value = false }, 900)
}
defineExpose({ openAndFocus })
onBeforeUnmount(() => clearTimeout(attentionTimer))

// The connector address is this server's own /mcp; Copy makes a one-use
// invite code for this room.
const inviteRoom = computed(() => ({
  roomId: props.room.identifier,
  roomName: props.room.displayName,
  connectorUrl: inviteBotConnectorUrl(typeof window !== 'undefined' ? window.location.origin : null),
}))

function createInvite(platform: InviteBotPlatform) {
  return createRoomInvite(props.room.identifier, platform)
}

async function cancelInvite(inviteId: string): Promise<string | null> {
  try {
    await cancelRoomInvite(props.room.identifier, inviteId)
    return null
  } catch (error) {
    return error instanceof Error && error.message ? error.message : 'The invite could not be cancelled. Try again.'
  }
}
</script>

<style>
/* Opened from the composer's "+": a soft ring shows where the invite is, once. */
.invite-bot-panel {
  position: relative;
}
.invite-bot-panel::after {
  content: '';
  position: absolute;
  inset: -1px;
  border: 1px solid var(--text-tertiary);
  border-radius: inherit;
  opacity: 0;
  pointer-events: none;
  transition: opacity 700ms ease-out;
}
.invite-bot-panel[data-attention]::after {
  opacity: 0.8;
  transition: opacity 180ms var(--ease-out);
}
</style>
