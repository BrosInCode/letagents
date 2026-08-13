<template>
  <Teleport to="body">
    <Transition name="desktop-add-agent-dialog" @after-leave="handleAfterLeave">
      <div
        v-if="open"
        class="desktop-add-agent-backdrop"
        data-testid="desktop-add-agent-modal"
        @click.self="emit('close')"
      >
        <section
          ref="dialogElement"
          class="desktop-add-agent-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-add-agent-title"
          tabindex="-1"
          @keydown.esc.prevent="emit('close')"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-add-agent-header">
            <div>
              <span>Add agent</span>
              <h3 id="desktop-add-agent-title">Bring an agent into this room</h3>
              <p>
                Choose a provider, confirm its setup, then start it in
                <strong data-testid="desktop-add-agent-room-label">{{ roomLabel }}</strong>.
              </p>
            </div>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close add agent dialog"
              @click="emit('close')"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <div class="desktop-add-agent-body">
            <AddAgentProviderRail
              :providers="providers"
              :selected-provider-id="selectedProviderId"
              @select="selectProvider"
            />
            <AddAgentSetupStatus
              :provider-name="selectedProvider?.name || null"
              :preflight="preflight"
              :loading="loadingProviders || loadingPreflight"
              :error="loadError"
              :status-title="statusTitle"
              :status-description="statusDescription"
              :status-label="preflightStatusLabel"
              :runtime-label="runtimeLabel"
              :bridge-label="bridgeLabel"
              :repo-label="repoLabel"
              :show-secure-storage="showSecureStorage"
              :secure-storage-label="secureStorageLabel"
              :secure-storage-needs-attention="secureStorageNeedsAttention"
              :can-open-secure-storage="canOpenSecureStorage"
              :show-worktrees="showWorktreePicker"
              :worktrees="matchingWorktrees"
              :worktree-description="worktreePickerDescription"
              :auth-command="authCommand"
              :install-command="installCommand"
              @refresh="retryProviderSetup"
              @choose-worktree="chooseWorktree"
              @open-secure-storage="openSecureCredentialStorage"
            >
            <AddAgentOpenModelSettings
              v-if="showOpenModelConfig"
              v-model:base-url="openModelBaseUrl"
              v-model:model="openModelModel"
              v-model:api-key="openModelApiKey"
              :has-api-key="Boolean(openModelStatus?.hasApiKey)"
              :saving="savingOpenModelSettings"
              :error="openModelError"
              @save="saveOpenModelSettings"
              @clear-key="clearOpenModelApiKey"
            />
            <AddAgentModelSettings
              v-if="showModelSelector"
              :loading="loadingProviderModels"
              :model-choice="selectedModelChoice"
              :model-options="modelSelectOptions"
              :custom="selectedModelMode === 'custom'"
              :custom-model-id="customModelId"
              :model-description="modelSelectorDescription"
              :show-effort="showEffortSelector"
              :effort="selectedEffort"
              :effort-options="effortSelectOptions"
              :effort-description="effortSelectorDescription"
              :catalog-label="providerModelCatalogLabel"
              :catalog-error="providerModelCatalogIsError"
              @refresh="refreshProviderModels"
              @update:model-choice="handleModelChoiceValue"
              @update:custom-model-id="customModelId = $event"
              @update:effort="handleEffortValue"
            />
            <AddAgentRuntimeSettings
              :provider="selectedProvider"
              :launch-mode="launchMode"
              :lifecycle-description="lifecycleDescription"
              :charter="supervisedCharter"
              :show-delivery="showDeliverySelector"
              :delivery-mode="deliveryMode"
              :delivery-description="deliveryModeDescription"
              :permission-profiles="selectedPermissionProfiles"
              :selected-permission-profile="selectedPermissionProfile"
              :show-cursor-policy="showCursorMcpPolicySelector"
              :cursor-policy="selectedCursorMcpPolicy"
              :cursor-policy-description="selectedCursorMcpPolicyDescription"
              :external-prompt="externalJoinPrompt"
              :copying-external-prompt="copyingExternalPrompt"
              @update:launch-mode="launchMode = $event"
              @update:charter="supervisedCharter = $event"
              @update:delivery-mode="deliveryMode = $event"
              @select-permission="selectPermissionProfile"
              @update:cursor-policy="selectedCursorMcpPolicy = $event"
              @copy-external-prompt="copyExternalJoinPrompt"
            />
            <AddAgentManagedSessions
              :room-identifier="roomIdentifier"
              :provider-id="selectedProviderId"
              :room-git-room="roomGitRoom"
            />
            <AddAgentSupervisedLaunch
              :controller="supervisedUi"
            />

            <AddAgentFeedback v-if="setupMessage" :message="setupMessage" :tone="setupMessageTone" />

            <AddAgentActionBar
              :room-identifier="roomIdentifier"
              :provider-id="selectedProviderId"
              :provider="selectedProvider"
              :preflight="preflight"
              :permission-profile="selectedPermissionProfile"
              :launch-mode="launchMode"
              :setup-busy="setupBusy"
        :setup-action-label="preflight?.nextAction === 'install_runtime' || preflight?.nextAction === 'install_mcp_bridge'
          ? setupActionButtonText(preflight.nextAction)
          : ''"
              :copying-auth-command="copyingAuthCommand"
              :install-command="installCommand"
              :install-url="installUrl"
              :can-create-worktree="canCreateWorktree"
              :matching-worktree-count="matchingWorktrees.length"
              :creating-worktree="creatingWorktree"
              :create-worktree-label="createWorktreeButtonLabel"
              :can-start-base="canStartManagedAgent"
              :starting-agent="startingAgent"
              :setup-confirmation-active="Boolean(activeSetupConfirmation)"
              :external-instruction="isExternalMcpProviderReady(selectedProvider, preflight)
                ? externalMcpProviderInstruction(selectedProvider)
                : null"
              :permission-warning="selectedPermissionProfileWarning"
              :supervised="supervisedUi"
              :charter-missing="launchMode === 'supervised' && !supervisedCharter.trim()"
              @setup-action="runSetupAction"
              @copy-auth-command="copyAgentAuthCommand"
              @copy-install-command="copyAgentAuthCommand(installCommand)"
              @open-install-guide="openProviderInstallGuide"
              @refresh="retryProviderSetup"
              @create-worktree="createWorktree"
              @start="startManagedAgent"
              @recover-launch="handleRecoverSupervisedLaunch"
            />

            </AddAgentSetupStatus>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";
import { nextTick, ref, watch } from "vue";
import AddAgentManagedSessions from "./add-agent/AddAgentManagedSessions.vue";
import AddAgentActionBar from "./add-agent/AddAgentActionBar.vue";
import AddAgentProviderRail from "./add-agent/AddAgentProviderRail.vue";
import AddAgentSetupStatus from "./add-agent/AddAgentSetupStatus.vue";
import AddAgentOpenModelSettings from "./add-agent/AddAgentOpenModelSettings.vue";
import AddAgentModelSettings from "./add-agent/AddAgentModelSettings.vue";
import AddAgentRuntimeSettings from "./add-agent/AddAgentRuntimeSettings.vue";
import AddAgentSupervisedLaunch from "./add-agent/AddAgentSupervisedLaunch.vue";
import AddAgentFeedback from "./add-agent/AddAgentFeedback.vue";
import {
  useAddAgentController,
  type AddAgentModalEmit,
  type AddAgentModalEvents,
  type AddAgentModalProps,
} from "./add-agent/useAddAgentController";
import {
  externalMcpProviderInstruction,
  isExternalMcpProviderReady,
} from "../../../domain/managed-agents";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<AddAgentModalProps>();
const emit = defineEmits<AddAgentModalEvents>();
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;

watch(() => props.open, (open) => {
  if (open) {
    previousFocusElement = currentFocusableElement();
    void nextTick(() => dialogElement.value?.focus());
  }
}, { immediate: true });

function handleAfterLeave(): void {
  if (props.open) return;
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

async function handleRecoverSupervisedLaunch(): Promise<void> {
  await supervisedUi.launch.recoverDetectedLaunch();
  if (supervisedUi.launch.recoveryCandidate.value) return;
  await nextTick();
  dialogElement.value?.querySelector<HTMLElement>('[data-testid="desktop-add-agent-supervised-runtime"], [data-testid="desktop-add-agent-supervised-lookup-error"]')?.focus();
}

const { roomLabel, providers, selectedProviderId, selectProvider, selectedProvider, preflight, loadingProviders, loadingPreflight, loadError, statusTitle, statusDescription, preflightStatusLabel, runtimeLabel, bridgeLabel, repoLabel, showSecureStorage, secureStorageLabel, secureStorageNeedsAttention, canOpenSecureStorage, showWorktreePicker, matchingWorktrees, worktreePickerDescription, authCommand, installCommand, installUrl, retryProviderSetup, chooseWorktree, showOpenModelConfig, openModelBaseUrl, openModelModel, openModelApiKey, openModelStatus, openModelError, savingOpenModelSettings, saveOpenModelSettings, clearOpenModelApiKey, showModelSelector, loadingProviderModels, selectedModelChoice, modelSelectOptions, selectedModelMode, customModelId, modelSelectorDescription, showEffortSelector, selectedEffort, effortSelectOptions, effortSelectorDescription, providerModelCatalogLabel, providerModelCatalogIsError, refreshProviderModels, handleModelChoiceValue, handleEffortValue, launchMode, lifecycleDescription, supervisedCharter, showDeliverySelector, deliveryMode, deliveryModeDescription, selectedPermissionProfiles, selectedPermissionProfile, showCursorMcpPolicySelector, selectedCursorMcpPolicy, selectedCursorMcpPolicyDescription, externalJoinPrompt, copyingExternalPrompt, selectPermissionProfile, copyExternalJoinPrompt, setupMessage, setupMessageTone, supervisedUi, setupBusy, setupActionButtonText, copyingAuthCommand, canCreateWorktree, creatingWorktree, createWorktreeButtonLabel, canStartManagedAgent, startingAgent, activeSetupConfirmation, selectedPermissionProfileWarning, runSetupAction, copyAgentAuthCommand, openProviderInstallGuide, openSecureCredentialStorage, createWorktree, startManagedAgent } = useAddAgentController(props, emit as AddAgentModalEmit);
</script>
