<template>
  <section
    v-if="recovery && !(recovery.state === 'restored' && dismissed)"
    class="agent-inspector-continuation-recovery"
    :data-state="recovery.state"
    :role="recovery.state === 'failed' ? 'alert' : 'status'"
    aria-live="polite"
    aria-atomic="true"
  >
    <div class="agent-inspector-continuation-recovery-copy">
      <span class="agent-inspector-continuation-recovery-mark" aria-hidden="true">
        <svg v-if="recovery.state === 'restored'" viewBox="0 0 16 16" fill="none"><path d="m3.5 8 2.8 2.8 6.2-6.1" /></svg>
        <svg v-else viewBox="0 0 16 16" fill="none"><path d="M8 3v5l3 1.7M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" /></svg>
      </span>
      <div>
        <strong>{{ title }}</strong>
        <p>{{ recovery.detail }}</p>
      </div>
      <button
        v-if="recovery.state === 'restored'"
        type="button"
        class="agent-inspector-continuation-dismiss"
        aria-label="Dismiss conversation restored notice"
        @click="dismissed = true"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </div>
    <div v-if="recovery.state === 'failed' && (recovery.canRestore || recovery.canSkip)" class="agent-inspector-continuation-actions">
      <button v-if="recovery.canRestore" type="button" :disabled="busy" @click="emit('restore', recovery.sourceMessageId)">
        Restore and retry
      </button>
      <button v-if="recovery.canSkip" type="button" :disabled="busy" @click="emit('skip', recovery.sourceMessageId)">
        Skip message
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { AgentInspectorProjection } from "../../../../domain/agent-inspector";

const props = defineProps<{
  entryId: string;
  recovery: AgentInspectorProjection["continuationRecovery"];
  busy: boolean;
}>();
const emit = defineEmits<{
  restore: [sourceMessageId: string];
  skip: [sourceMessageId: string];
}>();
const dismissed = ref(false);
const title = computed(() => {
  if (props.recovery?.state === "restored") return "Conversation restored";
  if (props.recovery?.state === "restoring") return "Restoring conversation";
  return "Couldn’t restore this agent’s Codex conversation";
});

watch(
  () => [props.entryId, props.recovery?.sourceMessageId, props.recovery?.state] as const,
  () => { dismissed.value = false; },
);
</script>
