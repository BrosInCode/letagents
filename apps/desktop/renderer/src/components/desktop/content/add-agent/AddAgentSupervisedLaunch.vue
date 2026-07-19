<template>
  <p class="sr-only" aria-live="polite" aria-atomic="true">{{ recoveryAnnouncement }}</p>
  <AddAgentRecoveryNotice
    v-if="recoveryCandidate && recoverableProviderName"
    :provider-name="recoverableProviderName"
  />
  <section
    v-if="progress"
    class="desktop-add-agent-managed-sessions"
    data-testid="desktop-add-agent-supervised-runtime"
    aria-label="Supervised agent launch"
    tabindex="-1"
  >
    <article class="desktop-add-agent-managed-session" :data-state="state">
      <SupervisedLaunchProgress :progress="progress" @recover="controller.launch.handleRecover($event)" />
      <div class="desktop-add-agent-managed-session-actions">
        <button
          v-if="canAddAnotherCodexAgent"
          type="button"
          class="desktop-add-agent-managed-session-secondary"
          data-testid="desktop-add-agent-add-another-codex"
          @click="controller.launch.dismissReadyCodexLaunchForAnother"
        >Add another Codex agent</button>
        <button
          v-else-if="hasStopAction"
          type="button"
          class="desktop-add-agent-managed-session-danger"
          data-testid="desktop-add-agent-stop-supervised-runtime"
          :disabled="stopping"
          @click="controller.launch.stop"
        >{{ stopping ? "Stopping..." : progress.stopFailed ? "Retry stop" : progress.ready ? "Stop this supervised agent" : "Cancel launch" }}</button>
        <button
          v-else-if="progress.failed || progress.stopped"
          type="button"
          class="desktop-add-agent-managed-session-secondary"
          data-testid="desktop-add-agent-dismiss-launch"
          @click="controller.launch.dismiss"
        >Dismiss</button>
      </div>
    </article>
  </section>
  <AddAgentFeedback
    v-if="lookupError"
    :message="lookupError"
    :tone="lookupTone"
    :action-label="recoveryScanStatus === 'error' ? 'Check again' : null"
    data-testid="desktop-add-agent-supervised-lookup-error"
    tabindex="-1"
    @action="controller.launch.detectRecoverableLaunch"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import SupervisedLaunchProgress from "../SupervisedLaunchProgress.vue";
import AddAgentFeedback from "./AddAgentFeedback.vue";
import AddAgentRecoveryNotice from "./AddAgentRecoveryNotice.vue";
import type { AddAgentSupervisedUi } from "./useAddAgentController";

const props = defineProps<{
  controller: AddAgentSupervisedUi;
}>();
const progress = computed(() => props.controller.launch.view.value);
const stopping = computed(() => Boolean(props.controller.launch.stoppingEntryId.value));
const canAddAnotherCodexAgent = computed(() => {
  const entry = props.controller.launch.conflict.value;
  return entry?.provider === "codex" && Boolean(progress.value?.ready);
});
const hasStopAction = computed(() => Boolean(props.controller.launch.conflict.value)
  && !canAddAnotherCodexAgent.value);
const recoveryCandidate = computed(() => props.controller.launch.recoveryCandidate.value);
const recoverableProviderName = computed(() => props.controller.recoverableProviderName.value);
const recoveryAnnouncement = computed(() => recoveryCandidate.value && recoverableProviderName.value
  ? `Previous ${recoverableProviderName.value} agent available to recover.`
  : "");
const lookupError = computed(() => props.controller.launch.conflictLookupError.value);
const lookupTone = computed(() => props.controller.launch.conflictLookupTone.value);
const recoveryScanStatus = computed(() => props.controller.launch.recoveryScanStatus.value);
const state = computed(() => {
  if (!progress.value) return "idle";
  if (progress.value.status === "stopping") return "stopping";
  if (progress.value.ready) return "ready";
  if (progress.value.failed) return "blocked";
  if (progress.value.stopped) return "stopped";
  return "starting";
});
</script>
<style scoped src="./AddAgentLiveCard.css"></style>
