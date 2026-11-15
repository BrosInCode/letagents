<template>
  <div class="drawer-section drawer-panel invite-bot-panel" data-testid="invite-bot-panel">
    <div class="drawer-section-title">
      <h2>Invite a bot</h2>
      <span>One message for the bot's owner</span>
    </div>
    <InviteBotSection
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
import { computed } from 'vue'
import InviteBotSection from '../../../../../../shared/ui/InviteBotSection.vue'
import { inviteBotConnectorUrl, type InviteBotPlatform } from '../../../../../../shared/ui/invite-bot'
import { cancelRoomInvite, createRoomInvite } from '@/composables/room/invites'
import type { RoomInfo } from '@/composables/useRoom'

const props = defineProps<{ room: RoomInfo }>()

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
