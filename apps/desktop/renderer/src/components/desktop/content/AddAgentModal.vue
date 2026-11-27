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
          class="desktop-add-agent-modal agent-refresh-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="desktop-add-agent-title"
          tabindex="-1"
          @keydown.esc.prevent="emit('close')"
          @keydown.tab="handleDialogTab"
        >
          <header class="desktop-add-agent-header">
            <div>
              <h3 id="desktop-add-agent-title">Add an agent</h3>
              <span class="agent-refresh-room" data-testid="desktop-add-agent-room-label">{{ roomLabel }}</span>
            </div>
            <button type="button" class="agent-motion-toggle" :aria-label="motionPaused ? 'Resume animations' : 'Pause animations'" :aria-pressed="motionPaused" @click="motionPaused = !motionPaused"><span aria-hidden="true">{{ motionPaused ? '▷' : 'Ⅱ' }}</span></button>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close add agent dialog"
              @click="emit('close')"
            >
              <X aria-hidden="true" />
            </button>
          </header>
          <nav class="agent-refresh-steps" aria-label="Agent setup steps">
            <button type="button" :aria-current="step === 'identity' ? 'step' : undefined" :disabled="Boolean(supervisedUi.launch.view.value)" @click="showStep('identity', $event)"><span>01</span> Identity</button>
            <button type="button" :aria-current="step === 'brain' ? 'step' : undefined" @click="showStep('brain', $event)"><span>02</span> Brain</button>
          </nav>
          <div ref="turnBody" class="desktop-add-agent-body agent-refresh-body" :data-turning="turning">
            <div ref="turnStage" class="agent-refresh-stage">
            <section class="agent-refresh-panel agent-refresh-identity" :inert="step !== 'identity'" :aria-hidden="step !== 'identity'">
              <h4>Make it yours.</h4>
              <AgentIdentityPicker v-model="identityAvatar" v-model:name="configuredName" :active="open && (step === 'identity' || turning)" :animate="!motionPaused" :error="identityError" :taken-names="takenNames" />
              <div v-if="hasSupervisedRuntime(selectedProvider)" class="agent-refresh-first-message"><AddAgentFirstMessage v-model="supervisedCharter" /></div>
            </section>
            <section class="agent-refresh-panel agent-refresh-brain" :inert="step !== 'brain'" :aria-hidden="step !== 'brain'">
            <AgentBrain :provider="selectedProviderId" :provider-name="selectedProvider?.name || 'Agent'" :model="selectedModelChoice" :effort="supervisedUi.launch.conflict.value ? '' : selectedEffort" :active="open && step === 'brain'" :animate="!motionPaused" />
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
              :install-command="installCommand"
              @refresh="retryProviderSetup"
              @choose-worktree="chooseWorktree"
              @open-secure-storage="openSecureCredentialStorage"
            >
            <AddAgentOpenModelSettings
              v-if="showOpenModelConfig"
              ref="openModelSettings"
              v-model:base-url="openModelBaseUrl"
              v-model:model="openModelModel"
              v-model:context-window="openModelContextWindow"
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
              :custom-model-error="customModelError"
              :model-description="modelSelectorDescription"
              :show-effort="showEffortSelector && !supervisedUi.launch.conflict.value"
              :effort="selectedEffort"
              :effort-options="effortSelectOptions"
              :effort-description="effortSelectorDescription"
              :catalog-label="providerModelCatalogLabel"
              :catalog-error="providerModelCatalogIsError"
              :cli-update="providerModelCliUpdate"
              @refresh="refreshProviderModels"
              @update:model-choice="handleModelChoiceValue"
              @update:custom-model-id="customModelId = $event"
              @update:effort="handleEffortValue"
            />
            <AddAgentRuntimeSettings
              :show-first-message="false"
              :provider="selectedProvider"
              :execution-description="lifecycleDescription"
              :charter="supervisedCharter"
              :permission-profiles="selectedPermissionProfiles"
              :selected-permission-profile="selectedPermissionProfile"
              @update:charter="supervisedCharter = $event"
              @select-permission="selectPermissionProfile"
            />
            <AddAgentSupervisedLaunch
              :controller="supervisedUi"
              :supervisor-error-shown="preflight?.blockedBySupervisor"
            />

            <AddAgentSignIn
              :controller="providerSignIn"
              :needs-sign-in="preflight?.nextAction === 'authenticate'"
              :auth-command="authCommand"
              :copying="copyingAuthCommand"
              @copy-command="copyAgentAuthCommand()"
            />
            <AddAgentFeedback v-if="setupMessage" :message="setupMessage" :tone="setupMessageTone" />



            </AddAgentSetupStatus>
            </section>
            </div>
          </div>
          <footer class="agent-refresh-footer">
            <button type="button" class="agent-refresh-back" @click="step === 'brain' ? showStep('identity', $event) : emit('close')" :disabled="step === 'brain' && Boolean(supervisedUi.launch.view.value)">{{ step === 'brain' ? '← Back to identity' : 'Cancel' }}</button>
            <button v-if="step === 'identity'" type="button" class="agent-refresh-continue" @click="showStep('brain', $event)">Continue to brain <span aria-hidden="true">→</span></button>
            <template v-else>
              <span class="agent-refresh-selected" data-agent-avatar-source><AgentAvatar :avatar="configuredAvatar" :name="configuredName" :size="32" /><span>{{ configuredName }}</span></span>

              <AddAgentActionBar
                :provider-id="selectedProviderId"
                :provider="selectedProvider"
                :preflight="preflight"
                :setup-busy="setupBusy"
          :setup-action-label="preflight?.nextAction === 'install_runtime' || preflight?.nextAction === 'install_mcp_bridge'
            ? setupActionButtonText(preflight.nextAction)
            : ''"
                :copying-auth-command="copyingAuthCommand"
                :sign-in-state="providerSignIn.update.value?.state ?? null"
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
                :charter-missing="!supervisedCharter.trim()"
                @setup-action="runSetupAction"
                @sign-in="providerSignIn.start()"
                @copy-install-command="copyAgentAuthCommand(installCommand)"
                @open-install-guide="openProviderInstallGuide"
                @refresh="retryProviderSetup"
                @create-worktree="createWorktree"
                @start="startManagedAgent"
                @recover-launch="handleRecoverSupervisedLaunch"
              />

            </template>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";
import { useAgentSetupPresentation } from "./add-agent/useAgentSetupPresentation";
import AgentIdentityPicker from "../../../../../../../shared/ui/agent-identity/AgentIdentityPicker.vue";
import AgentAvatar from "../../../../../../../shared/ui/agent-identity/AgentAvatar.vue";
import AgentBrain from "../../../../../../../shared/ui/agent-identity/AgentBrain.vue";
import AddAgentActionBar from "./add-agent/AddAgentActionBar.vue";
import AddAgentProviderRail from "./add-agent/AddAgentProviderRail.vue";
import AddAgentSetupStatus from "./add-agent/AddAgentSetupStatus.vue";
import AddAgentOpenModelSettings from "./add-agent/AddAgentOpenModelSettings.vue";
import AddAgentModelSettings from "./add-agent/AddAgentModelSettings.vue";
import AddAgentFirstMessage from "./add-agent/AddAgentFirstMessage.vue";
import AddAgentRuntimeSettings from "./add-agent/AddAgentRuntimeSettings.vue";
import AddAgentSupervisedLaunch from "./add-agent/AddAgentSupervisedLaunch.vue";
import AddAgentFeedback from "./add-agent/AddAgentFeedback.vue";
import AddAgentSignIn from "./add-agent/AddAgentSignIn.vue";
import {
  useAddAgentController,
  type AddAgentModalEmit,
  type AddAgentModalEvents,
  type AddAgentModalProps,
} from "./add-agent/useAddAgentController";
import {
  hasSupervisedRuntime,
  externalMcpProviderInstruction,
  isExternalMcpProviderReady,
} from "../../../domain/managed-agents";


const props = defineProps<AddAgentModalProps>();
const emit = defineEmits<AddAgentModalEvents>();
const { configuredName, configuredAvatar, roomLabel, providers, selectedProviderId, selectProvider, selectedProvider, preflight, loadingProviders, loadingPreflight, loadError, statusTitle, statusDescription, runtimeLabel, bridgeLabel, repoLabel, showSecureStorage, secureStorageLabel, secureStorageNeedsAttention, canOpenSecureStorage, showWorktreePicker, matchingWorktrees, worktreePickerDescription, authCommand, installCommand, installUrl, retryProviderSetup, chooseWorktree, showOpenModelConfig, openModelBaseUrl, openModelModel, openModelContextWindow, openModelApiKey, openModelStatus, openModelError, savingOpenModelSettings, saveOpenModelSettings, clearOpenModelApiKey, showModelSelector, loadingProviderModels, selectedModelChoice, modelSelectOptions, selectedModelMode, customModelId, customModelError, modelSelectorDescription, showEffortSelector, selectedEffort, effortSelectOptions, effortSelectorDescription, providerModelCatalogLabel, providerModelCatalogIsError, providerModelCliUpdate, refreshProviderModels, handleModelChoiceValue, handleEffortValue, lifecycleDescription, supervisedCharter, selectedPermissionProfiles, selectedPermissionProfile, selectPermissionProfile, setupMessage, setupMessageTone, supervisedUi, setupBusy, setupActionButtonText, copyingAuthCommand, canCreateWorktree, creatingWorktree, createWorktreeButtonLabel, canStartManagedAgent, startingAgent, activeSetupConfirmation, selectedPermissionProfileWarning, runSetupAction, copyAgentAuthCommand, providerSignIn, openProviderInstallGuide, openSecureCredentialStorage, createWorktree, startManagedAgent } = useAddAgentController(props, emit as AddAgentModalEmit);

const { dialogElement, openModelSettings, handleAfterLeave, handleDialogTab, handleRecoverSupervisedLaunch, step, identityError, takenNames, identityAvatar, motionPaused, turnBody, turnStage, turning, showStep } = useAgentSetupPresentation(props, configuredName, configuredAvatar, supervisedUi);

</script>
<style scoped src="./add-agent/AddAgentRefresh.css"></style>
