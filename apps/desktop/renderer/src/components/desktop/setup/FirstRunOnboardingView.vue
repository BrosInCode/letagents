<template>
  <DesktopSurfacePage class="first-run-wizard" :data-stage="stage" data-testid="first-run-wizard">
    <article class="mcp-wizard-card first-run-card" data-testid="first-run-card">
      <div class="first-run-hero-row" data-testid="first-run-hero">
        <header class="mcp-wizard-header first-run-header" data-testid="first-run-header">
          <p class="hero-kicker">LetAgents setup</p>
          <SetupWizardProgress :current-step="stage" :steps="progressSteps" />
          <h1>{{ headline }}</h1>
          <p>{{ copy }}</p>
        </header>
      </div>

      <Transition name="room-panel" mode="out-in">
        <div v-if="stage === 'mcp'" key="mcp" class="first-run-stage" data-testid="first-run-stage-mcp">
          <McpHarnessChoiceStep
            v-if="mcpWizardStep === 'choose'"
            :targets="mcpState.targets"
            :selected-target-ids="selectedMcpTargetIds"
            @select-target="$emit('select-target', $event)"
            @select-all="$emit('select-all-targets')"
            @clear-selection="$emit('clear-target-selection')"
          />

          <McpInstallConfirmStep
            v-else-if="mcpWizardStep === 'install'"
            :targets="selectedMcpTargets"
          />

          <McpInstallDoneStep v-else :targets="selectedMcpTargets" />
        </div>

        <FirstRunGithubStep
          v-else-if="stage === 'github'"
          key="github"
          :auth-status="authStatus"
          :busy="authBusy"
          @start-auth="$emit('start-auth')"
          @open-verification="$emit('open-verification', $event)"
          @poll-auth="$emit('poll-auth')"
          @sign-out="$emit('sign-out')"
        />

        <FirstRunRoomStep
          v-else
          key="room"
          :room-name="roomName"
          :room-identifier="roomIdentifier"
          :busy="busy"
          @pick-repo="$emit('pick-repo')"
          @join-room-code="$emit('join-room-code', $event)"
        />
      </Transition>

      <div class="mcp-wizard-actions" data-testid="first-run-actions">
        <button
          v-if="showBack"
          class="ghost-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-back"
          @click="$emit('back')"
        >
          Back
        </button>

        <button
          v-if="stage === 'mcp' && mcpWizardStep === 'choose'"
          class="primary-button"
          type="button"
          :disabled="!selectedMcpTargetIds.length || busy"
          data-testid="first-run-mcp-continue"
          @click="$emit('continue-mcp')"
        >
          Continue
        </button>

        <button
          v-else-if="stage === 'mcp' && mcpWizardStep === 'install'"
          class="primary-button"
          type="button"
          :disabled="!selectedMcpTargetIds.length || busy || !canInstall"
          data-testid="first-run-mcp-install"
          @click="$emit('install-targets')"
        >
          {{ installButtonLabel }}
        </button>

        <button
          v-else-if="stage === 'mcp'"
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-to-github"
          @click="$emit('continue-to-github')"
        >
          Continue
        </button>

        <button
          v-else-if="stage === 'github'"
          class="primary-button"
          type="button"
          :disabled="busy || !authStatus?.authenticated"
          data-testid="first-run-to-room"
          @click="$emit('continue-to-room')"
        >
          Continue
        </button>

        <button
          v-else
          class="primary-button"
          type="button"
          :disabled="busy"
          data-testid="first-run-open-room"
          @click="$emit('finish')"
        >
          Open room
        </button>
      </div>

      <p v-if="feedback" class="mcp-feedback" data-testid="first-run-feedback">{{ feedback }}</p>
    </article>
  </DesktopSurfacePage>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type {
  DesktopAuthStatus,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
} from "../../../../../electron/ipc-types";
import FirstRunGithubStep from "./FirstRunGithubStep.vue";
import FirstRunRoomStep from "./FirstRunRoomStep.vue";
import McpHarnessChoiceStep from "./McpHarnessChoiceStep.vue";
import McpInstallConfirmStep from "./McpInstallConfirmStep.vue";
import McpInstallDoneStep from "./McpInstallDoneStep.vue";
import SetupWizardProgress from "./SetupWizardProgress.vue";
import type { DesktopMcpWizardStep, FirstRunWizardStage } from "./types";
import DesktopSurfacePage from "../content/ui/DesktopSurfacePage.vue";

const props = defineProps<{
  stage: FirstRunWizardStage;
  mcpState: DesktopMcpInstallState;
  selectedMcpTargetIds: DesktopMcpInstallTargetId[];
  mcpWizardStep: DesktopMcpWizardStep;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  authBusy: boolean;
  canInstall: boolean;
  feedback: string | null;
  roomName: string;
  roomIdentifier: string | null;
}>();

defineEmits<{
  "select-target": [targetId: DesktopMcpInstallTargetId];
  "select-all-targets": [];
  "clear-target-selection": [];
  "continue-mcp": [];
  "install-targets": [];
  "continue-to-github": [];
  "start-auth": [];
  "open-verification": [url: string];
  "poll-auth": [];
  "sign-out": [];
  "continue-to-room": [];
  "pick-repo": [];
  "join-room-code": [roomCode: string];
  back: [];
  finish: [];
}>();

const selectedMcpTargets = computed(() => {
  return props.mcpState.targets.filter((target) => props.selectedMcpTargetIds.includes(target.id));
});

const selectedTargetLabel = computed(() => {
  if (selectedMcpTargets.value.length === 1) return selectedMcpTargets.value[0]?.name || "your app";
  if (selectedMcpTargets.value.length === props.mcpState.targets.length) return "all your apps";
  return `${selectedMcpTargets.value.length} apps`;
});

const installButtonLabel = computed(() => {
  if (props.busy) return "Installing...";
  if (!selectedMcpTargets.value.length) return "Install LetAgents";
  return selectedMcpTargets.value.length === 1
    ? "Install LetAgents"
    : `Install in ${selectedMcpTargets.value.length} apps`;
});

const headline = computed(() => {
  if (props.stage === "github") return "Let agents work on your repo in a room.";
  if (props.stage === "room") return "Choose where agents should work.";
  if (props.mcpWizardStep === "install") return `Add LetAgents to ${selectedTargetLabel.value}.`;
  if (props.mcpWizardStep === "done") return `${selectedTargetLabel.value} ${selectedMcpTargets.value.length === 1 ? "is" : "are"} ready.`;
  return "Bring your agent in.";
});

const copy = computed(() => {
  if (props.stage === "github") {
    return "Connect GitHub so LetAgents can find your repositories, confirm access, and open the right shared place for agent work.";
  }
  if (props.stage === "room") {
    return "Open a room for a repository, or join one someone has already shared with you.";
  }
  if (props.mcpWizardStep === "install") {
    return "LetAgents will add a small MCP connection to this app, already pointed at this repository and ready for the right room.";
  }
  if (props.mcpWizardStep === "done") {
    return "Restart or reload the app you selected. Your agents will see LetAgents the next time they start.";
  }
  return "Choose the coding apps your agents use. LetAgents will add the MCP connection there, so agents can join rooms without copy-paste setup.";
});

const progressSteps = computed<Array<{ id: FirstRunWizardStage; step: string; label: string; complete: boolean }>>(() => [
  { id: "mcp", step: "1", label: "Agent app", complete: props.stage !== "mcp" },
  { id: "github", step: "2", label: "GitHub", complete: props.stage === "room" },
  { id: "room", step: "3", label: "Room", complete: false },
]);

const showBack = computed(() => {
  return props.stage !== "mcp" || props.mcpWizardStep !== "choose";
});
</script>
