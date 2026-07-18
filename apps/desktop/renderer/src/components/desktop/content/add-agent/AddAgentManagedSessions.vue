<template>
  <section v-if="sessions.length" class="desktop-add-agent-managed-sessions">
    <article
      v-for="session in sessions"
      :key="session.id"
      class="desktop-add-agent-managed-session"
    >
      <span>{{ session.deliveryLabel }}</span>
      <strong>{{ session.displayName }}</strong>
      <small>{{ session.detail }}</small>
      <div class="desktop-add-agent-managed-session-actions">
        <button
          type="button"
          class="desktop-add-agent-managed-session-danger"
          :disabled="!session.canStop || Boolean(stoppingSessionId)"
          @click="handleStopManagedAgent(session.id)"
        >
          {{ stoppingSessionId === session.id ? "Stopping..." : "Stop agent" }}
        </button>
      </div>
      <AddAgentFeedback
        v-if="feedback?.sessionId === session.id"
        :message="feedback.message"
        :tone="feedback.tone"
      />
    </article>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, toRef, watch } from "vue";
import type { DesktopAgentProviderId, DesktopGitRoomInfo } from "../../../../../../electron/ipc-types";
import {
  useStableManagedAgentSessionViews,
} from "./managed-agent-sessions-context";
import { useManagedAgentLaunch } from "./useManagedAgentLaunch";
import AddAgentFeedback from "./AddAgentFeedback.vue";
import type { AddAgentFeedbackTone } from "./add-agent-errors";

const props = defineProps<{
  roomIdentifier: string;
  providerId: DesktopAgentProviderId | null;
  roomGitRoom: DesktopGitRoomInfo | null;
}>();

const roomIdentifier = toRef(props, "roomIdentifier");
const providerId = toRef(props, "providerId");
const sessions = useStableManagedAgentSessionViews(
  () => roomIdentifier.value,
  () => providerId.value,
  () => props.roomGitRoom,
);
let active = true;
let providerGeneration = 0;
let activeStopGeneration = 0;
const feedback = ref<{ sessionId: string; message: string; tone: AddAgentFeedbackTone } | null>(null);
const { stoppingSessionId, stop: stopManagedAgent } = useManagedAgentLaunch({
  onFeedback: (message, tone = "status") => {
    if (active && activeStopGeneration === providerGeneration && stoppingSessionId.value) {
      feedback.value = { sessionId: stoppingSessionId.value, message, tone };
    }
  },
});
watch(
  () => [props.roomIdentifier, props.providerId] as const,
  () => {
    providerGeneration += 1;
    feedback.value = null;
  },
);

async function handleStopManagedAgent(sessionId: string): Promise<void> {
  activeStopGeneration = providerGeneration;
  feedback.value = null;
  await stopManagedAgent(sessionId);
}

onBeforeUnmount(() => { active = false; });
</script>
<style scoped src="./AddAgentLiveCard.css"></style>
