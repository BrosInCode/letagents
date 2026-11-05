<template>
  <div class="drawer-section drawer-panel invite-bot-panel" data-testid="invite-bot-panel">
    <div class="drawer-section-title">
      <h2>Invite a bot</h2>
      <span>One message for the bot's owner</span>
    </div>
    <InviteBotSection :room="inviteRoom" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import InviteBotSection from '../../../../../../shared/ui/InviteBotSection.vue'
import { inviteBotConnectorUrl, type InviteBotRoom } from '../../../../../../shared/ui/invite-bot'
import type { RoomInfo } from '@/composables/useRoom'

const props = defineProps<{ room: RoomInfo }>()

// The room id is the code of an ad-hoc room, or github.com/owner/repo for a
// Git Room; the connector address is this server's own /mcp.
const inviteRoom = computed<InviteBotRoom>(() => ({
  roomId: props.room.identifier,
  roomName: props.room.displayName,
  gitRoom: props.room.gitRoom !== null,
  connectorUrl: inviteBotConnectorUrl(typeof window !== 'undefined' ? window.location.origin : null),
}))
</script>
