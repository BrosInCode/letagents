<template>
  <div class="desktop-add-agent-actions">
    <div v-if="!activeSupervisedLaunch" class="desktop-add-agent-action-buttons">
      <button
        v-if="preflight?.nextAction === 'install_runtime'"
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
      @click="emit('choose-repo')"
    >
      Choose project folder
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
      v-else-if="hasDesktopManagedRuntime(provider) || hasSupervisedRuntime(provider)"
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
            ? "This supervised launch has stopped."
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
    <span v-else-if="launchMode === 'supervised' && charterMissing" class="desktop-add-agent-confirmation">
      Add a charter before starting the supervised agent.
    </span>
    <span v-else-if="launchMode === 'supervised' && recoveryScanStatus !== 'ready'" class="desktop-add-agent-confirmation">
      {{ recoveryScanStatus === "error"
        ? "Previous launches could not be checked. Starting now creates a new supervised agent."
        : "Checking for a previous supervised agent before enabling Start..." }}
    </span>
    <span v-else-if="permissionWarning" class="desktop-add-agent-confirmation">
      {{ permissionWarning }}
    </span>
    <span v-else-if="activeSessions.length" class="desktop-add-agent-confirmation">
      Each start creates a separate local agent session.
    </span>
    <span
      v-else-if="preflight?.status === 'ready' && (hasDesktopManagedRuntime(provider) || hasSupervisedRuntime(provider))"
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
  DesktopManagedAgentPermissionProfile,
} from "../../../../../../electron/ipc-types";
import { hasDesktopManagedRuntime, hasSupervisedRuntime } from "../../../../domain/managed-agents";
import { useStableManagedAgentSessionViews } from "./managed-agent-sessions-context";
import type { AddAgentSupervisedUi } from "./useAddAgentController";
import { canStartNewSupervisedLaunch } from "./useSupervisedLaunchRecovery";

const props = defineProps<{
  roomIdentifier: string;
  providerId: DesktopAgentProviderId | null;
  provider: DesktopAgentProvider | null;
  preflight: DesktopAgentProviderPreflight | null;
  permissionProfile: DesktopManagedAgentPermissionProfile | null;
  launchMode: "legacy" | "supervised";
  setupBusy: boolean;
  setupActionLabel: string;
  copyingAuthCommand: boolean;
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
  "choose-repo": [];
  "create-worktree": [];
  start: [];
  "recover-launch": [];
}>();

const activeSessions = useStableManagedAgentSessionViews(
  () => props.roomIdentifier,
  () => props.providerId,
);
const recoverableProviderName = computed(() => props.supervised.recoverableProviderName.value);
const recoveringLaunch = computed(() => props.supervised.launch.recoveringCandidate.value);
const recoveryScanStatus = computed(() => props.supervised.launch.recoveryScanStatus.value);
// A launch card owns this footer until it is explicitly dismissed. Tying
// ownership to the editable lifecycle toggle lets stale setup actions reappear
// underneath a live, failed, or stopped supervised launch.
const activeSupervisedLaunch = computed(() => props.supervised.launch.view.value);
const canStart = computed(() => props.canStartBase
  && (props.launchMode !== "supervised" || canStartNewSupervisedLaunch({
    providerId: props.providerId,
    scanStatus: recoveryScanStatus.value,
    hasActiveLaunch: Boolean(props.supervised.launch.view.value),
    hasRecoveryCandidate: Boolean(props.supervised.launch.recoveryCandidate.value),
    recoveringCandidate: props.supervised.launch.recoveringCandidate.value,
    supportsConcurrentAgents: props.provider?.capabilities.includes("concurrent_supervised_agents") === true,
  })));
const startButtonLabel = computed(() => {
  if (props.startingAgent) return "Starting...";
  if (props.launchMode === "supervised") {
    return recoveryScanStatus.value === "error"
      ? "Start new supervised agent"
      : "Start supervised agent";
  }
  if (!hasDesktopManagedRuntime(props.provider)) return "Start agent";
  const providerName = props.provider?.name?.trim() || "agent";
  const profileLabel = props.permissionProfile?.label?.trim();
  const prefix = activeSessions.value.length ? "Start another" : "Start";
  return profileLabel
    ? `${prefix} ${providerName} - ${profileLabel}`
    : `${prefix} ${providerName}`;
});
</script>
<style scoped src="./AddAgentActionBar.css"></style>
