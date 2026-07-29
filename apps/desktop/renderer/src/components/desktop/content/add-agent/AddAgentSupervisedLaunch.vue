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
      <AddAgentSupervisedLaunchActions
        :progress="progress"
        :can-add-another-supervised-agent="canAddAnotherSupervisedAgent"
        :provider-name="progress.providerLabel"
        :has-stop-action="hasStopAction"
        :stopping="stopping"
        @add-another="controller.launch.dismissReadyLaunchForAnother"
        @stop="controller.launch.stop"
        @dismiss="controller.launch.dismiss"
      />
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
import { AddAgentSupervisedLaunchActions } from "./AddAgentSupervisedLaunchActions";
import type { AddAgentSupervisedUi } from "./useAddAgentController";

const props = defineProps<{
  controller: AddAgentSupervisedUi;
}>();
const progress = computed(() => props.controller.launch.view.value);
const stopping = computed(() => Boolean(props.controller.launch.stoppingEntryId.value));
const canAddAnotherSupervisedAgent = computed(() => props.controller.launch.canAddAnotherSupervisedAgent.value);
const hasStopAction = computed(() => Boolean(props.controller.launch.conflict.value)
  && !canAddAnotherSupervisedAgent.value);
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
