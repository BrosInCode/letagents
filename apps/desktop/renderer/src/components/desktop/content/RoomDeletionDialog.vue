<template>
  <Teleport to="body">
    <DesktopDialogShell :open="Boolean(room)" :focus-key="room?.roomIdentifier" aria-label="Permanently delete room" :close-disabled="busy" initial-focus="[data-delete-cancel]" @close="emit('close')">
      <div class="room-deletion-content">
        <h2>Permanently delete {{ room?.displayName }}?</h2>
        <p><strong>This is a destructive action and cannot be undone.</strong></p>
        <p>The room, its focus rooms, messages, threads, tasks, attachments and shared work history will be deleted. Cloud deletion affects everyone in the room.</p>
        <p>Repository files and worktrees will be kept.</p>
        <label for="room-delete-confirmation">Type <strong>{{ room?.roomIdentifier }}</strong> to confirm.</label>
        <input id="room-delete-confirmation" v-model="confirmation" type="text" autocomplete="off" spellcheck="false" :disabled="busy" @keydown.enter.prevent="submit" />
        <p v-if="error" role="alert">{{ error }}</p>
        <footer>
          <button data-delete-cancel type="button" class="ghost-button" :disabled="busy" @click="emit('close')">Cancel</button>
          <button type="button" class="ghost-button settings-danger-button" :disabled="busy || confirmation !== room?.roomIdentifier" @click="submit">{{ busy ? 'Deleting…' : 'Permanently delete room' }}</button>
        </footer>
      </div>
    </DesktopDialogShell>
  </Teleport>
</template>
<script setup lang="ts">
import { ref, watch } from "vue";
import DesktopDialogShell from "./DesktopDialogShell.vue";
const props = defineProps<{ room: { roomIdentifier: string; displayName: string } | null; busy: boolean; error?: string | null }>();
const emit = defineEmits<{ close: []; confirm: [confirmation: string] }>();
const confirmation = ref("");
watch(() => props.room, () => { confirmation.value = ""; });
function submit(): void {
  if (!props.busy && props.room && confirmation.value === props.room.roomIdentifier) emit("confirm", confirmation.value);
}
</script>
<style scoped>
.room-deletion-content { padding: 28px; display: grid; gap: 16px; }
h2, p { margin: 0; }
h2 { padding-right: 24px; font-size: 20px; }
p { line-height: 1.5; }
input { width: 100%; padding: 10px; border: 1px solid var(--border-color, #888); border-radius: 6px; color: inherit; background: transparent; }
footer { display: flex; justify-content: flex-end; gap: 12px; }
</style>
