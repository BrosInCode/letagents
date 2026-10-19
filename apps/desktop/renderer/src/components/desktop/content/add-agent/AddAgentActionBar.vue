<template>
  <div class="desktop-add-agent-actions">
    <div v-if="!activeSupervisedLaunch" class="desktop-add-agent-action-buttons">
      <template v-if="preflight?.nextAction === 'install_external_runtime'">
        <button
          v-if="installCommand"
          type="button"
          class="desktop-add-agent-primary"
          :disabled="copyingAuthCommand"
          @click="emit('copy-install-command')"
        >
          {{ copyingAuthCommand ? "Copying..." : "Copy install command" }}
        </button>
        <button
          v-if="installUrl"
          type="button"
          class="desktop-add-agent-recover"
          @click="emit('open-install-guide')"
        >
          Open installation guide
        </button>
        <button
          v-if="!installCommand && !installUrl"
          type="button"
          class="desktop-add-agent-primary"
          :disabled="setupBusy"
          @click="emit('refresh')"
        >
          Check provider setup
        </button>
      </template>
      <button
        v-else-if="preflight?.nextAction === 'install_runtime'"
        type="button"
        class="desktop-add-agent-primary"
        :disabled="setupBusy"
        @click="emit('setup-action', 'install_runtime')"
      >
        {{ setupActionLabel }}
      </button>
    <button
      v-else-if="preflight?.nextAction === 'install_mcp_bridge'"
      type="button"
      class="desktop-add-agent-primary"
      :disabled="setupBusy"
      @click="emit('setup-action', 'install_mcp_bridge')"
    >
      {{ setupActionLabel }}
    </button>
    <button
      v-else-if="preflight?.nextAction === 'authenticate'"
      type="button"
      class="desktop-add-agent-primary"
      :disabled="copyingAuthCommand"
      @click="emit('copy-auth-command')"
    >
      {{ copyingAuthCommand ? "Copying..." : "Copy sign-in command" }}
    </button>
    <button
      v-else-if="preflight?.nextAction === 'choose_repo'"
      type="button"
      class="desktop-add-agent-primary"
      disabled
    >
      Connect project from the room
    </button>
    <button
      v-else-if="preflight?.nextAction === 'choose_worktree' && canCreateWorktree && matchingWorktreeCount === 0"
      type="button"
      class="desktop-add-agent-primary"
      data-testid="desktop-add-agent-create-worktree"
      :disabled="creatingWorktree"
      @click="emit('create-worktree')"
    >
      {{ createWorktreeLabel }}
    </button>
    <button
      v-else-if="preflight?.nextAction === 'choose_worktree'"
      type="button"
      class="desktop-add-agent-primary"
      disabled
    >
      {{ matchingWorktreeCount ? "Choose a worktree above" : "No matching worktree found" }}
    </button>
    <button
      v-else-if="supervisedProvider"
      type="button"
      class="desktop-add-agent-primary"
      :disabled="!canStart || startingAgent"
      @click="emit('start')"
    >
      {{ startButtonLabel }}
    </button>
    <button
      v-if="recoverableProviderName"
      type="button"
      class="desktop-add-agent-recover"
      data-testid="desktop-add-agent-recover-launch"
      :disabled="recoveringLaunch"
      @click="emit('recover-launch')"
    >
      <History aria-hidden="true" :size="16" :stroke-width="1.9" />
      {{ recoveringLaunch ? "Recovering..." : `Recover ${recoverableProviderName}` }}
    </button>
    </div>

    <span v-if="activeSupervisedLaunch" class="desktop-add-agent-confirmation">
      {{ activeSupervisedLaunch.ready
        ? `${activeSupervisedLaunch.agentName || activeSupervisedLaunch.providerLabel} is active in this room.`
        : activeSupervisedLaunch.failed
          ? "This launch needs attention."
          : activeSupervisedLaunch.stopped
            ? "This agent has stopped."
            : activeSupervisedLaunch.status === "stopping"
              ? `${activeSupervisedLaunch.providerLabel} is stopping.`
              : `${activeSupervisedLaunch.providerLabel} setup is in progress.` }}
    </span>
    <span v-else-if="setupConfirmationActive" class="desktop-add-agent-confirmation">
      Review this action, then confirm to continue.
    </span>
    <span v-else-if="externalInstruction" class="desktop-add-agent-confirmation">
      {{ externalInstruction }}
    </span>
    <span v-else-if="supervisedProvider && charterMissing" class="desktop-add-agent-confirmation">
      Add a first task to start the agent.
    </span>
    <span v-else-if="supervisedProvider && recoveryScanStatus !== 'ready'" class="desktop-add-agent-confirmation">
      {{ recoveryScanStatus === "error"
        ? "Previous launches could not be checked. Starting now creates a new agent."
        : "Checking for a previous agent before enabling Start..." }}
    </span>
    <span v-else-if="permissionWarning" class="desktop-add-agent-confirmation">
      {{ permissionWarning }}
    </span>
    <span
      v-else-if="preflight?.status === 'ready' && supervisedProvider"
      class="desktop-add-agent-confirmation"
    >
      Starts a {{ provider?.name || "local" }} agent for this room.
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { History } from "@lucide/vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
} from "../../../../../../electron/ipc-types";
import { hasSupervisedRuntime } from "../../../../domain/managed-agents";
import type { AddAgentSupervisedUi } from "./useAddAgentController";
import { canStartNewSupervisedLaunch } from "./useSupervisedLaunchRecovery";

const props = defineProps<{
  providerId: DesktopAgentProviderId | null;
  provider: DesktopAgentProvider | null;
  preflight: DesktopAgentProviderPreflight | null;
  setupBusy: boolean;
  setupActionLabel: string;
  copyingAuthCommand: boolean;
  installCommand?: string | null;
  installUrl?: string | null;
  canCreateWorktree: boolean;
  matchingWorktreeCount: number;
  creatingWorktree: boolean;
  createWorktreeLabel: string;
  canStartBase: boolean;
  startingAgent: boolean;
  setupConfirmationActive: boolean;
  externalInstruction: string | null;
  permissionWarning: string | null;
  supervised: AddAgentSupervisedUi;
  charterMissing: boolean;
}>();

const emit = defineEmits<{
  "setup-action": [action: DesktopAgentProviderSetupAction];
  "copy-auth-command": [];
  "copy-install-command": [];
  "open-install-guide": [];
  refresh: [];
  "create-worktree": [];
  start: [];
  "recover-launch": [];
}>();

const supervisedProvider = computed(() => hasSupervisedRuntime(props.provider));
const recoverableProviderName = computed(() => props.supervised.recoverableProviderName.value);
const recoveringLaunch = computed(() => props.supervised.launch.recoveringCandidate.value);
const recoveryScanStatus = computed(() => props.supervised.launch.recoveryScanStatus.value);
// A launch card owns this footer until it is explicitly dismissed, so stale
// setup actions never reappear underneath a live, failed, or stopped launch.
const activeSupervisedLaunch = computed(() => props.supervised.launch.view.value);
const canStart = computed(() => props.canStartBase
  && canStartNewSupervisedLaunch({
    providerId: props.providerId,
    scanStatus: recoveryScanStatus.value,
    hasActiveLaunch: Boolean(props.supervised.launch.view.value),
    recoveringCandidate: props.supervised.launch.recoveringCandidate.value,
  }));
const startButtonLabel = computed(() => {
  if (props.startingAgent) return "Starting...";
  return recoveryScanStatus.value === "error" ? "Start new agent" : "Start agent";
});
</script>
<style scoped src="./AddAgentActionBar.css"></style>
