<template>
  <span v-if="roomNotificationsMuted(roomIdentifier)" class="room-muted-icon" role="img" aria-label="Room notifications muted or snoozed" title="Room notifications muted or snoozed">
    <BellOff aria-hidden="true" />
  </span>
</template>
<script setup lang="ts">
import { BellOff } from '@lucide/vue';
import { roomNotificationsMuted } from '../../../composables/useRoomNotificationPreferences';
defineProps<{ roomIdentifier?: string | null }>();
</script>
<style scoped>
.room-muted-icon { display: inline-flex; color: var(--text-tertiary); flex: none; }
.room-muted-icon svg { width: 13px; height: 13px; }
</style>
