<template>
  <section v-if="account && (state.items.length || state.error || state.actionLoading)" class="message-reminders" aria-labelledby="reminders-title">
    <h2 id="reminders-title">Reminders</h2>
    <p v-if="state.error" class="knowledge-notice" role="alert">{{ state.error }} <button class="knowledge-text-button" @click="refresh(false, true)">Retry</button></p>
    <p v-if="!state.items.length">{{ state.loading ? 'Loading reminders…' : 'No reminders.' }}</p>
    <ul v-else>
      <li v-for="item in state.items" :key="item.id">
        <div><strong>{{ item.state === 'due' ? 'Due' : 'Pending' }}</strong> · <time :datetime="item.due_at">{{ new Date(item.due_at).toLocaleString() }}</time>
          <p>{{ item.preview ? `${item.preview.sender} in ${item.preview.room_display_name}` : 'Message unavailable' }}</p>
          <p v-if="item.preview">{{ item.preview.snippet }}</p>
        </div>
        <div class="reminder-actions">
          <button v-if="item.preview" class="knowledge-button" @click="emit('open', { roomIdentifier: item.room_id, messageId: item.message_id })">Open message</button>
          <button class="knowledge-button" :disabled="Boolean(state.pending)" @click="remove(item.id)">{{ item.state === 'due' ? 'Dismiss' : 'Cancel' }}</button>
        </div>
      </li>
    </ul>
    <button v-if="state.nextOffset !== null" class="knowledge-button" :disabled="state.loading" @click="refresh(true, true)">More reminders</button>
  </section>
</template>
<script setup lang="ts">
import { onMounted } from 'vue';
import { useMessageReminders } from '../../../composables/useMessageReminders';
import type { AttentionNavigationIntent } from './room-shell/types';
const emit = defineEmits<{ open: [intent: AttentionNavigationIntent] }>();
const { state, account, refresh, remove } = useMessageReminders();
onMounted(() => { void refresh(); });
</script>
<style scoped>
.message-reminders { margin: 16px 0; padding: 16px; border: 1px solid var(--border-strong); border-radius: 10px; }
h2 { margin: 0 0 10px; font-size: 15px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding: 12px 0; border-top: 1px solid var(--border-strong); }
p { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.reminder-actions { display: flex; flex-wrap: wrap; gap: 6px; }
</style>
