<template>
  <div class="room-settings-row" data-testid="room-personal-notifications">
    <div class="room-settings-row-copy">
      <p class="room-settings-row-title">Notifications for this room</p>
      <p class="room-settings-row-description">Only affects your alerts.</p>
      <p v-if="unavailable" class="room-settings-row-description">{{ unavailable }}</p>
      <p v-else-if="snoozed" class="room-settings-row-description">Snoozed until {{ snoozed }}.</p>
      <p v-if="state.error && !unavailable" role="alert">{{ state.error }} <button type="button" @click="refresh">Retry</button></p>
    </div>
    <div class="room-settings-row-action">
      <label>
        <span class="sr-only">Notification level for this room</span>
        <select :value="state.preference.level" :disabled="disabled" @change="setLevel">
          <option value="all">All messages</option>
          <option value="mentions">Mentions only</option>
          <option value="muted">Muted</option>
        </select>
      </label>
      <label>
        <span class="sr-only">Snooze this room</span>
        <select value="" :disabled="disabled" @change="snooze">
          <option value="" disabled>Snooze…</option>
          <option value="1h">1 hour</option>
          <option value="8h">8 hours</option>
          <option value="tomorrow">Until tomorrow 09:00</option>
        </select>
      </label>
      <button v-if="snoozed" class="room-settings-button" type="button" :disabled="disabled" @click="preferences.update(roomIdentifier, { snoozed_until: null })">Resume</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, watch } from 'vue';
import { roomNotificationSnoozeUntil, type RoomNotificationLevel, type RoomNotificationSnoozePreset } from '../../../../../../../../shared/room-notification-preferences.mjs';
import { roomNotificationPreferences as preferences, roomNotificationState, roomNotificationAccountAvailable } from '../../../../composables/useRoomNotificationPreferences';
const props = defineProps<{ roomIdentifier: string; localOnly: boolean }>();
const state = computed(() => roomNotificationState(props.roomIdentifier));
const unavailable = computed(() => props.localOnly ? 'Notification settings require a cloud room.' : !roomNotificationAccountAvailable() ? 'Sign in to manage your notifications.' : '');
const disabled = computed(() => Boolean(unavailable.value) || state.value.busy || state.value.loading);
const snoozed = computed(() => Date.parse(state.value.preference.snoozed_until ?? '') > Date.now() ? new Date(state.value.preference.snoozed_until!).toLocaleString() : '');
function refresh() { if (!unavailable.value) void preferences.refresh(props.roomIdentifier); }
watch(() => props.roomIdentifier, refresh, { immediate: true });
function setLevel(event: Event) { void preferences.update(props.roomIdentifier, { level: (event.target as HTMLSelectElement).value as RoomNotificationLevel }); }
function snooze(event: Event) {
  const select = event.target as HTMLSelectElement;
  void preferences.update(props.roomIdentifier, { snoozed_until: roomNotificationSnoozeUntil(select.value as RoomNotificationSnoozePreset) });
  select.value = '';
}
</script>
<style scoped>
select { background: var(--bg-elevated); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px; font: inherit; }
.room-settings-row-action { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
