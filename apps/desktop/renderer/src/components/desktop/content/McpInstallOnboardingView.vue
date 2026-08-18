<template>
  <section class="mcp-onboarding surface-page" data-testid="mcp-install-onboarding">
    <article class="mcp-wizard-card" :data-step="wizardStep" data-testid="mcp-wizard-card">
      <SetupWizardHeader kicker="First setup" :headline="headline" :copy="introCopy" />

      <SetupWizardProgress :current-step="wizardStep" :steps="progressSteps" />

      <Transition name="room-panel" mode="out-in">
        <McpHarnessChoiceStep
          v-if="wizardStep === 'choose'"
          key="choose"
          :targets="state.targets"
          :selected-target-ids="selectedTargetIds"
          @select-target="$emit('select-target', $event)"
          @select-all="$emit('select-all-targets')"
          @clear-selection="$emit('clear-target-selection')"
        />

        <McpInstallConfirmStep
          v-else
          key="install"
          :targets="selectedTargets"
          :show-result="wizardStep === 'done' || Boolean(feedback)"
        />
      </Transition>

      <SetupWizardActions
        :wizard-step="wizardStep"
        :selected-targets="selectedTargets"
        :busy="busy"
        :can-install="canInstall"
        :retry="Boolean(feedback) && selectedTargets.some((target) => target.status !== 'installed')"
        @continue="$emit('continue')"
        @back="$emit('back')"
        @install-targets="$emit('install-targets')"
        @finish="$emit('finish')"
      />

      <p v-if="feedback" class="mcp-feedback" data-testid="mcp-install-feedback">{{ feedback }}</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopMcpInstallState,
  DesktopMcpInstallTarget,
  DesktopMcpInstallTargetId,
} from "../../../../../electron/ipc-types";
import McpHarnessChoiceStep from "../setup/McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "../setup/McpInstallConfirmStep.vue";
import SetupWizardActions from "../setup/SetupWizardActions.vue";
import SetupWizardHeader from "../setup/SetupWizardHeader.vue";
import SetupWizardProgress from "../setup/SetupWizardProgress.vue";
import type { DesktopMcpWizardStep } from "../setup/types";

const props = defineProps<{
  state: DesktopMcpInstallState;
  selectedTargetIds: DesktopMcpInstallTargetId[];
  wizardStep: DesktopMcpWizardStep;
  busy: boolean;
  feedback: string | null;
  canInstall: boolean;
}>();

defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
  "select-all-targets": [];
  "clear-target-selection": [];
  continue: [];
  back: [];
  "install-targets": [];
  finish: [];
}>();

const selectedTargets = computed<DesktopMcpInstallTarget[]>(() => {
  return props.state.targets.filter((target) => props.selectedTargetIds.includes(target.id));
});

const headline = computed(() => {
  if (props.wizardStep === "install") return "Connect your agents.";
  if (props.wizardStep === "done") return "MCP installed.";
  return "Where do your agents live?";
});

const introCopy = computed(() => {
  if (props.wizardStep === "install") {
    return "We'll add the LetAgents MCP to these apps so their agents can talk in shared rooms.";
  }

  if (props.wizardStep === "done") {
    return "Restart your agent apps, then continue.";
  }

  return "We'll install the LetAgents MCP in the apps you select.";
});

const progressSteps = computed<Array<{ id: DesktopMcpWizardStep; step: string; label: string; complete: boolean }>>(() => [
  { id: "choose", step: "1", label: "Apps", complete: props.wizardStep !== "choose" },
  { id: "install", step: "2", label: "MCP", complete: props.wizardStep === "done" },
  { id: "done", step: "3", label: "Restart", complete: false },
]);
</script>
