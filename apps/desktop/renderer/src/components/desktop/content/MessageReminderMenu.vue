<template>
  <button ref="trigger" type="button" role="menuitem" aria-haspopup="menu" :aria-expanded="open" @click="show" @keydown.right.prevent.stop="show">Remind me <span aria-hidden="true">›</span></button>
  <div v-if="open" ref="menu" class="room-message-context-menu reminder-submenu" role="menu" aria-label="Remind me" :style="position" @pointerdown.stop @keydown.stop="keydown">
    <button v-for="preset in reminderPresets" :key="preset.id" type="button" role="menuitem" :disabled="pending" @click="schedule(preset.id)">{{ preset.label }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { reminderDueAt, reminderPresets, type ReminderPreset } from '../../../domain/message-reminder-time';
import { scheduleMessageReminder } from '../../../composables/useMessageReminders';
const props = defineProps<{ room: string; message: string }>();
const emit = defineEmits<{ scheduled: [dueAt: string] }>();
const trigger = ref<HTMLButtonElement | null>(null), menu = ref<HTMLElement | null>(null);
const open = ref(false), pending = ref(false), error = ref('');
const position = ref({ left: '0px', top: '0px' });
function show() {
  const rect = trigger.value?.getBoundingClientRect(); if (!rect) return;
  position.value = { left: `${Math.max(8, Math.min(rect.right, window.innerWidth - 208))}px`, top: `${Math.max(8, Math.min(rect.top, window.innerHeight - 190))}px` };
  open.value = true; void nextTick(() => menu.value?.querySelector('button')?.focus());
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); open.value = false; trigger.value?.focus(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); const items = Array.from(menu.value?.querySelectorAll('button') ?? []);
    const index = items.findIndex(item => item === document.activeElement);
    items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }
}
async function schedule(preset: ReminderPreset) {
  const dueAt = reminderDueAt(preset); pending.value = true; error.value = '';
  try { await scheduleMessageReminder(props.room, props.message, dueAt); emit('scheduled', dueAt); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Reminder could not be set.'; }
  finally { pending.value = false; }
}
</script>
<style scoped>
.reminder-submenu { position: fixed; width: 200px; z-index: 1001; }
.reminder-submenu p { margin: 8px; font-size: 12px; color: var(--text-secondary); }
</style>
