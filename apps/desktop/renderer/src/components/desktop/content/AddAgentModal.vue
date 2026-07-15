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
            <section class="desktop-add-agent-providers" aria-label="Agent providers">
              <span class="desktop-add-agent-providers-label">Provider</span>
              <button
                v-for="provider in providers"
                :key="provider.id"
                class="desktop-add-agent-provider"
                type="button"
                :data-selected="provider.id === selectedProviderId"
                :aria-pressed="provider.id === selectedProviderId"
                :data-testid="`desktop-add-agent-provider-${provider.id}`"
                @click="selectProvider(provider.id)"
              >
                <span class="desktop-add-agent-provider-icon" aria-hidden="true">
                  <McpHarnessIcon :target-id="provider.mcpTargetId" />
                </span>
                <span>
                  <strong>{{ provider.name }}</strong>
                  <small>{{ provider.description }}</small>
                </span>
              </button>
            </section>

            <section class="desktop-add-agent-status" :data-state="preflight?.status || 'loading'">
              <div class="desktop-add-agent-status-header">
                <div>
                  <span>{{ selectedProvider?.name || "Provider" }}</span>
                  <h4>{{ statusTitle }}</h4>
                </div>
                <div class="desktop-add-agent-status-actions">
                  <span
                    class="desktop-add-agent-status-pill"
                    :data-state="preflight?.status || 'loading'"
                    aria-live="polite"
                  >
                    {{ preflightStatusLabel }}
                  </span>
                  <button
                    type="button"
                    :disabled="loadingPreflight || !selectedProviderId"
                    @click="refreshSelectedProvider({ forceModels: true })"
                  >
                    {{ loadingPreflight ? "Checking..." : "Check again" }}
                  </button>
                </div>
              </div>

              <p v-if="preflight?.detail">{{ preflight.detail }}</p>
              <p v-else-if="loadError">{{ loadError }}</p>
              <p v-else>Checking provider readiness...</p>

              <dl class="desktop-add-agent-checks">
                <div>
                  <dt>Agent app</dt>
                  <dd>{{ runtimeLabel }}</dd>
                </div>
                <div>
                  <dt>LetAgents connection</dt>
                  <dd>{{ bridgeLabel }}</dd>
                </div>
                <div>
                  <dt>Project folder</dt>
                  <dd>{{ repoLabel }}</dd>
                </div>
              </dl>

              <section
                v-if="showWorktreePicker"
                class="desktop-add-agent-worktrees"
                data-testid="desktop-add-agent-worktree-picker"
                aria-label="Matching worktrees"
              >
              <div class="desktop-add-agent-worktrees-header">
                <span>Existing worktrees</span>
                <p>{{ worktreePickerDescription }}</p>
              </div>
              <button
                v-for="worktree in matchingWorktrees"
                :key="worktree.path"
                type="button"
                class="desktop-add-agent-worktree"
                :data-current="worktree.isCurrent"
                :data-testid="`desktop-add-agent-worktree-${worktree.path}`"
                @click="chooseWorktree(worktree.path)"
              >
                <GitBranch :size="14" aria-hidden="true" />
                <span>
                  <strong>{{ worktree.branch }}</strong>
                  <small>{{ worktree.path }}</small>
                </span>
                <code>{{ worktree.head.slice(0, 7) }}</code>
              </button>
              <p v-if="!matchingWorktrees.length" class="desktop-add-agent-worktrees-empty">
                No existing worktree is on {{ preflight?.branchMismatch?.expectedBranch }}.
              </p>
            </section>

            <section
              v-if="preflight?.nextAction === 'authenticate' && authCommand"
              class="desktop-add-agent-auth-command"
              aria-label="Agent sign-in command"
            >
              <span>Sign-in command</span>
              <code>{{ authCommand }}</code>
            </section>

            <section
              v-if="showOpenModelConfig"
              class="desktop-add-agent-open-model-config"
              data-testid="desktop-add-agent-open-model-config"
              aria-label="Open model configuration"
            >
              <span>Model endpoint</span>
              <label>
                <small>Endpoint URL (OpenAI Responses-compatible)</small>
                <input
                  v-model="openModelBaseUrl"
                  type="url"
                  placeholder="https://openrouter.ai/api/v1"
                  data-testid="desktop-add-agent-open-model-base-url"
                />
              </label>
              <label>
                <small>Saved default model</small>
                <input
                  v-model="openModelModel"
                  type="text"
                  placeholder="qwen/qwen3-coder"
                  data-testid="desktop-add-agent-open-model-model"
                />
              </label>
              <label>
                <small>API key {{ openModelStatus?.hasApiKey ? "(saved - paste to replace)" : "(optional for local endpoints)" }}</small>
                <input
                  v-model="openModelApiKey"
                  type="password"
                  autocomplete="off"
                  :placeholder="openModelStatus?.hasApiKey ? '••••••••' : 'sk-or-...'"
                  data-testid="desktop-add-agent-open-model-api-key"
                />
              </label>
              <div class="desktop-add-agent-open-model-config-actions">
                <button
                  type="button"
                  :disabled="savingOpenModelSettings"
                  data-testid="desktop-add-agent-open-model-save"
                  @click="saveOpenModelSettings"
                >
                  {{ savingOpenModelSettings ? "Saving..." : "Save model settings" }}
                </button>
                <button
                  v-if="openModelStatus?.hasApiKey"
                  type="button"
                  :disabled="savingOpenModelSettings"
                  @click="clearOpenModelApiKey"
                >
                  Clear saved key
                </button>
              </div>
              <p v-if="openModelStatus?.error">{{ openModelStatus.error }}</p>
            </section>

            <section
              v-if="showModelSelector"
              class="desktop-add-agent-delivery desktop-add-agent-model"
              aria-label="Agent model"
            >
              <div class="desktop-add-agent-section-heading">
                <span>Model &amp; reasoning</span>
                <button
                  type="button"
                  :disabled="loadingProviderModels"
                  data-testid="desktop-add-agent-model-refresh"
                  @click="refreshProviderModels"
                >
                  {{ loadingProviderModels ? "Loading..." : "Refresh models" }}
                </button>
              </div>
              <div class="desktop-add-agent-model-grid" :data-single="!showEffortSelector">
                <div class="desktop-add-agent-setting">
                  <DesktopModelPicker
                    :model-value="selectedModelChoice"
                    :options="modelSelectOptions"
                    label="Model"
                    id="desktop-add-agent-model-select"
                    described-by="desktop-add-agent-model-description"
                    test-id="desktop-add-agent-model-select"
                    @update:model-value="handleModelChoiceValue"
                  />
                  <label v-if="selectedModelMode === 'custom'" class="desktop-add-agent-model-custom-input">
                    <small>Model id</small>
                    <input
                      v-model="customModelId"
                      type="text"
                      placeholder="provider/model-or-alias"
                      data-testid="desktop-add-agent-model-custom-input"
                    />
                  </label>
                  <p id="desktop-add-agent-model-description">{{ modelSelectorDescription }}</p>
                </div>
                <div v-if="showEffortSelector" class="desktop-add-agent-setting">
                  <DesktopSelectField
                    :model-value="selectedEffort"
                    :options="effortSelectOptions"
                    label="Effort"
                    id="desktop-add-agent-effort-select"
                    described-by="desktop-add-agent-effort-description"
                    test-id="desktop-add-agent-effort-select"
                    @update:model-value="handleEffortValue"
                  />
                  <p id="desktop-add-agent-effort-description">
                    {{ effortSelectorDescription }}
                  </p>
                </div>
              </div>
              <p class="desktop-add-agent-model-catalog" aria-live="polite">
                {{ providerModelCatalogLabel }}
              </p>
            </section>

            <section
              v-if="hasSupervisedRuntime(selectedProvider)"
              class="desktop-add-agent-delivery"
              aria-label="Agent lifecycle"
              data-testid="desktop-add-agent-lifecycle"
            >
              <span>Lifecycle</span>
              <div class="desktop-add-agent-segmented">
                <button
                  type="button"
                  :data-selected="launchMode === 'legacy'"
                  data-testid="desktop-add-agent-lifecycle-legacy"
                  @click="launchMode = 'legacy'"
                >
                  This app
                </button>
                <button
                  type="button"
                  :data-selected="launchMode === 'supervised'"
                  data-testid="desktop-add-agent-lifecycle-supervised"
                  @click="launchMode = 'supervised'"
                >
                  Supervised
                </button>
              </div>
              <p>{{ lifecycleDescription }}</p>
              <label v-if="launchMode === 'supervised'" class="desktop-add-agent-model-custom-input">
                <small>Charter</small>
                <textarea
                  v-model="supervisedCharter"
                  rows="3"
                  data-testid="desktop-add-agent-supervised-charter"
                />
              </label>
            </section>

            <section
              v-if="showDeliverySelector && launchMode === 'legacy'"
              class="desktop-add-agent-delivery"
              aria-label="Agent delivery mode"
            >
              <span>Delivery</span>
              <div class="desktop-add-agent-segmented">
                <button
                  type="button"
                  :data-selected="deliveryMode === 'mcp_polling'"
                  @click="deliveryMode = 'mcp_polling'"
                >
                  From the agent app
                </button>
                <button
                  type="button"
                  :data-selected="deliveryMode === 'desktop_events'"
                  @click="deliveryMode = 'desktop_events'"
                >
                  From this desktop app
                </button>
              </div>
              <p>{{ deliveryModeDescription }}</p>
            </section>

            <section
              v-if="selectedProvider?.capabilities.includes('desktop_managed_runtime') && selectedPermissionProfiles.length"
              class="desktop-add-agent-permissions"
              aria-label="Agent permissions"
            >
              <span>Permissions</span>
              <div class="desktop-add-agent-permission-options">
                <button
                  v-for="profile in selectedPermissionProfiles"
                  :key="profile.id"
                  type="button"
                  :data-selected="profile.id === selectedPermissionProfile?.id"
                  :data-state="profile.status"
                  :disabled="profile.status !== 'available'"
                  @click="selectPermissionProfile(profile)"
                >
                  <span class="desktop-add-agent-permission-option-title">
                    <strong>{{ profile.label }}</strong>
                    <em :data-risk="profile.risk">{{ profile.risk }}</em>
                  </span>
                  <small>{{ permissionProfileOptionSummary(profile) }}</small>
                </button>
              </div>
              <p v-if="selectedPermissionProfile">{{ permissionProfileSummary(selectedPermissionProfile) }}</p>
            </section>

            <section
              v-if="showCursorMcpPolicySelector"
              class="desktop-add-agent-delivery"
              aria-label="Cursor MCP tools"
            >
              <span>MCP tools</span>
              <div class="desktop-add-agent-segmented">
                <button
                  v-for="option in cursorMcpPolicyOptions"
                  :key="option.id"
                  type="button"
                  :data-selected="selectedCursorMcpPolicy === option.id"
                  :data-testid="`desktop-add-agent-cursor-mcp-${option.id}`"
                  @click="selectedCursorMcpPolicy = option.id"
                >
                  {{ option.label }}
                </button>
              </div>
              <p>{{ selectedCursorMcpPolicyDescription }}</p>
            </section>

            <section
              v-if="externalJoinPrompt"
              class="desktop-add-agent-external-prompt"
              data-testid="desktop-add-agent-external-prompt"
              aria-label="External agent join prompt"
            >
              <div class="desktop-add-agent-external-prompt-intro">
                <div>
                  <span>External agent setup</span>
                  <p>
                    Copy these instructions into {{ selectedProvider?.name || "the provider" }} so it can join the
                    correct room, use a readable agent name, and keep listening for work.
                  </p>
                </div>
                <button
                  type="button"
                  :disabled="copyingExternalPrompt"
                  @click="copyExternalJoinPrompt"
                >
                  {{ copyingExternalPrompt ? "Copying..." : "Copy agent instructions" }}
                </button>
              </div>
              <details class="desktop-add-agent-external-prompt-details">
                <summary>Show full instructions</summary>
                <pre><code>{{ externalJoinPrompt }}</code></pre>
              </details>
            </section>

            <section v-if="activeManagedSessions.length" class="desktop-add-agent-managed-sessions">
              <article
                v-for="session in activeManagedSessions"
                :key="session.id"
                class="desktop-add-agent-managed-session"
              >
                <span>{{ session.deliveryMode === "desktop_events" ? "From this desktop app" : "From the agent app" }}</span>
                <strong>{{ managedAgentSessionDisplayName(session) }}</strong>
                <small>
                  {{ managedAgentSessionDetail(session) }}
                </small>
                <div class="desktop-add-agent-managed-session-actions">
                  <button
                    type="button"
                    class="desktop-add-agent-managed-session-danger"
                    :disabled="!session.canStop || Boolean(stoppingSessionId)"
                    @click="stopManagedAgent(session.id)"
                  >
                    {{ stoppingSessionId === session.id ? "Stopping..." : "Stop agent" }}
                  </button>
                </div>
              </article>
            </section>

            <section
              v-if="supervisedConflict"
              class="desktop-add-agent-managed-sessions"
              data-testid="desktop-add-agent-supervised-runtime"
              aria-label="Supervised agent runtime"
            >
              <article
                class="desktop-add-agent-managed-session"
                :data-state="supervisedConflict.condition === 'none' ? supervisedConflict.observedState : 'blocked'"
              >
                <span>{{ supervisedConflictLabel }}</span>
                <strong>{{ supervisedConflict.displayName }}</strong>
                <small>
                  {{ supervisedConflict.observedState }} · {{ supervisedConflict.condition }}
                </small>
                <p v-if="supervisedConflictDetail">{{ supervisedConflictDetail }}</p>
                <div class="desktop-add-agent-managed-session-actions">
                  <button
                    type="button"
                    class="desktop-add-agent-managed-session-danger"
                    data-testid="desktop-add-agent-stop-supervised-runtime"
                    :disabled="Boolean(stoppingSupervisorEntryId)"
                    @click="stopSupervisedConflict"
                  >
                    {{ stoppingSupervisorEntryId === supervisedConflict.id ? "Stopping..." : "Stop this supervised agent" }}
                  </button>
                </div>
              </article>
            </section>

            <p v-if="supervisedConflictLookupError" class="desktop-add-agent-feedback">
              {{ supervisedConflictLookupError }}
            </p>

            <p v-if="setupMessage" class="desktop-add-agent-feedback">{{ setupMessage }}</p>

            <div class="desktop-add-agent-actions">
              <button
                v-if="preflight?.nextAction === 'install_runtime'"
                type="button"
                class="desktop-add-agent-primary"
                :disabled="setupBusy"
                @click="runSetupAction('install_runtime')"
              >
                {{ setupActionButtonText("install_runtime") }}
              </button>

              <button
                v-else-if="preflight?.nextAction === 'install_mcp_bridge'"
                type="button"
                class="desktop-add-agent-primary"
                :disabled="setupBusy"
                @click="runSetupAction('install_mcp_bridge')"
              >
                {{ setupActionButtonText("install_mcp_bridge") }}
              </button>

              <button
                v-else-if="preflight?.nextAction === 'authenticate'"
                type="button"
                class="desktop-add-agent-primary"
                :disabled="copyingAuthCommand"
                @click="copyAgentAuthCommand"
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
                v-else-if="preflight?.nextAction === 'choose_worktree' && canCreateWorktree && !matchingWorktrees.length"
                type="button"
                class="desktop-add-agent-primary"
                data-testid="desktop-add-agent-create-worktree"
                :disabled="creatingWorktree"
                @click="createWorktree"
              >
                {{ createWorktreeButtonLabel }}
              </button>

              <button
                v-else-if="preflight?.nextAction === 'choose_worktree'"
                type="button"
                class="desktop-add-agent-primary"
                disabled
              >
                {{ matchingWorktrees.length ? "Choose a worktree above" : "No matching worktree found" }}
              </button>

              <button
                v-else-if="hasDesktopManagedRuntime(selectedProvider)"
                type="button"
                class="desktop-add-agent-primary"
                :disabled="!canStartManagedAgent || startingAgent"
                @click="startManagedAgent"
              >
                {{ managedAgentStartButtonLabel }}
              </button>

              <span v-if="activeSetupConfirmation" class="desktop-add-agent-confirmation">
                Review this action, then confirm to continue.
              </span>
              <span v-else-if="isExternalMcpProviderReady(selectedProvider, preflight)" class="desktop-add-agent-confirmation">
                {{ externalMcpProviderInstruction(selectedProvider) }}
              </span>
              <span v-else-if="selectedPermissionProfileWarning" class="desktop-add-agent-confirmation">
                {{ selectedPermissionProfileWarning }}
              </span>
              <span v-else-if="activeManagedSessions.length" class="desktop-add-agent-confirmation">
                Each start creates a separate local agent session.
              </span>
              <span
                v-else-if="preflight?.status === 'ready' && hasDesktopManagedRuntime(selectedProvider)"
                class="desktop-add-agent-confirmation"
              >
                Starts a {{ selectedProvider?.name || "local" }} agent for this room.
              </span>
            </div>

            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { GitBranch, X } from "@lucide/vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderModelOption,
  DesktopAgentProviderModelsResult,
  DesktopAgentProviderModelSource,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopCursorMcpPolicy,
  DesktopGitRoomInfo,
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentEffort,
  DesktopManagedAgentPermissionProfile,
  DesktopManagedAgentPermissionProfileId,
  DesktopManagedAgentSession,
  DesktopOpenModelSettingsStatus,
  DesktopSupervisorManifestEntry,
  RepoStatus,
} from "../../../../../electron/ipc-types";
import {
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  branchScopedGitRoomExpectedBranch,
  cursorMcpPolicyDescription,
  cursorMcpPolicyLabel,
  cursorMcpPolicyOptions,
  defaultCursorMcpPolicy,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasDesktopManagedRuntime,
  hasSupervisedRuntime,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  isVisibleManagedAgentSession,
  matchingManagedAgentWorktreesForBranch,
  managedAgentRepoDetail,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSelectionForProvider,
  managedAgentPermissionProfileStatusLabel,
  managedAgentPermissionProfileSummary,
  managedAgentSessionDisplayName,
  managedAgentSessionMatchesRoom,
  managedAgentSessionStatusLabel,
  managedAgentStopResultMessage,
  shouldShowCursorMcpPolicySelector,
  shouldShowDeliveryModeSelector,
  shouldShowManagedModelSelector,
  shouldShowOpenModelConfig,
  visibleDesktopAgentProviders,
  type AgentSetupConfirmation,
} from "../../../domain/managed-agents";
import {
  isSupervisedRuntimeSettled,
  refreshSupervisedRuntimeEntry,
  stopSupervisedProviderLane,
  supervisedRecoveryDetail,
  supervisedRuntimeCardLabel,
} from "../../../domain/supervised-recovery";
import { copyTextToClipboard } from "../../../domain/clipboard";
import { createManagedAgentWorktree } from "../../../domain/managed-agent-worktrees";
import McpHarnessIcon from "../setup/McpHarnessIcon.vue";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";
import DesktopSelectField, { type DesktopSelectOption } from "../controls/DesktopSelectField.vue";
import { desktopIpc } from "../../../ipc/index.js";
import DesktopModelPicker from "../controls/DesktopModelPicker.vue";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string;
  roomGitRoom: DesktopGitRoomInfo | null;
  gitRoomMatchesActiveRepo: boolean;
  roomDisplayName: string | null;
  repoRootPath: string | null;
  repoStatus: RepoStatus | null;
  managedSessions: DesktopManagedAgentSession[];
}>();

const emit = defineEmits<{
  close: [];
  "choose-repo": [];
  "choose-worktree": [rootPath: string];
  "managed-sessions-updated": [sessions: DesktopManagedAgentSession[]];
  "managed-session-started": [session: DesktopManagedAgentSession];
}>();

const providers = ref<DesktopAgentProvider[]>([]);
const selectedProviderId = ref<DesktopAgentProviderId | null>(null);
const preflight = ref<DesktopAgentProviderPreflight | null>(null);
const loadingProviders = ref(false);
const loadingPreflight = ref(false);
const setupBusy = ref(false);
const startingAgent = ref(false);
const creatingWorktree = ref(false);
const stoppingSessionId = ref<string | null>(null);
const stoppingSupervisorEntryId = ref<string | null>(null);
const supervisedConflict = ref<DesktopSupervisorManifestEntry | null>(null);
const supervisedConflictLookupError = ref<string | null>(null);
const copyingAuthCommand = ref(false);
const copyingExternalPrompt = ref(false);
const setupConfirmation = ref<AgentSetupConfirmation | null>(null);
const loadError = ref<string | null>(null);
const setupMessage = ref<string | null>(null);
const deliveryMode = ref<DesktopManagedAgentDeliveryMode>("desktop_events");
const launchMode = ref<"legacy" | "supervised">("legacy");
const supervisedCharter = ref("Work from the room board, coordinate in the room, and keep polling until stopped.");
const selectedCursorMcpPolicy = ref<DesktopCursorMcpPolicy>(defaultCursorMcpPolicy);
const openModelStatus = ref<DesktopOpenModelSettingsStatus | null>(null);
const openModelBaseUrl = ref("");
const openModelModel = ref("");
const openModelApiKey = ref("");
const savingOpenModelSettings = ref(false);
const providerModels = ref<DesktopAgentProviderModelsResult | null>(null);
const loadingProviderModels = ref(false);
type ModelSelectionMode = "default" | "option" | "custom";
const MODEL_PREFLIGHT_DEBOUNCE_MS = 400;
const selectedModelMode = ref<ModelSelectionMode>("default");
const selectedProviderModelId = ref("");
const customModelId = ref("");
const selectedEffort = ref<DesktopManagedAgentEffort | "">("");
const selectedPermissionProfileId = ref<DesktopManagedAgentPermissionProfileId | null>(null);
const selectedPermissionProfileIdsByProvider = ref<
  Partial<Record<DesktopAgentProviderId, DesktopManagedAgentPermissionProfileId>>
>({});
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;
let preflightRequestId = 0;
let modelRequestId = 0;
let modalStateVersion = 0;
let managedSessionRefreshTimer: number | null = null;
let supervisedRuntimeRefreshTimer: number | null = null;
let supervisedCreationRequestId: string | null = null;
let modelPreflightTimer: number | null = null;

const selectedProvider = computed(() =>
  providers.value.find((provider) => provider.id === selectedProviderId.value) || null
);
const supervisedConflictDetail = computed(() =>
  supervisedConflict.value ? supervisedRecoveryDetail(supervisedConflict.value) : null
);
const supervisedConflictLabel = computed(() =>
  supervisedConflict.value ? supervisedRuntimeCardLabel(supervisedConflict.value) : "Supervised runtime"
);

const activeManagedSessions = computed(() =>
  props.managedSessions.filter((session) =>
    session.providerId === selectedProviderId.value
    && managedAgentSessionMatchesRoom(session, props.roomIdentifier)
    && isVisibleManagedAgentSession(session)
  )
);

const selectedPermissionProfiles = computed(() => selectedProvider.value?.permissionProfiles ?? []);
const selectedPermissionProfile = computed(() =>
  selectedPermissionProfiles.value.find((profile) => profile.id === selectedPermissionProfileId.value) ??
  selectedPermissionProfiles.value.find((profile) => profile.id === selectedProvider.value?.defaultPermissionProfileId) ??
  selectedPermissionProfiles.value.find((profile) => profile.status === "available") ??
  selectedPermissionProfiles.value[0] ??
  null
);
const canStartManagedAgent = computed(() =>
  Boolean(
    preflight.value?.canStart &&
    !loadingPreflight.value &&
    (selectedModelMode.value !== "option" || !loadingProviderModels.value) &&
    (
      !selectedPermissionProfiles.value.length ||
      selectedPermissionProfile.value?.status === "available"
    )
    && (launchMode.value === "legacy" || Boolean(supervisedCharter.value.trim()))
  )
);
const authCommand = computed(() => agentAuthCommand(selectedProvider.value));
const roomLabel = computed(() => props.roomDisplayName?.trim() || props.roomIdentifier);
const externalJoinPrompt = computed(() =>
  isExternalMcpProviderReady(selectedProvider.value, preflight.value)
    ? externalMcpProviderJoinPrompt(selectedProvider.value, props.roomIdentifier, props.repoRootPath)
    : null
);

const activeSetupConfirmation = computed(() => {
  const nextAction = preflight.value?.nextAction;
  if (nextAction !== "install_runtime" && nextAction !== "install_mcp_bridge") {
    return null;
  }
  return isAgentSetupConfirmationActive(setupConfirmation.value, selectedProviderId.value, nextAction)
    ? setupConfirmation.value
    : null;
});

const statusTitle = computed(() => {
  if (loadingProviders.value || loadingPreflight.value) return "Checking setup";
  if (loadError.value) return "Provider check failed";
  if (!preflight.value) return "Choose a provider";
  return preflight.value.message;
});

const preflightStatusLabel = computed(() => {
  if (loadingProviders.value || loadingPreflight.value) return "Checking";
  if (loadError.value || preflight.value?.status === "error") return "Needs attention";
  if (preflight.value?.status === "ready") return "Ready";
  if (!preflight.value) return "Not checked";
  return "Setup needed";
});

const runtimeLabel = computed(() => {
  if (preflight.value?.version) return preflight.value.version;
  if (preflight.value?.status === "missing_runtime") return "Missing";
  if (selectedProvider.value?.capabilities.includes("desktop_managed_runtime")) return "Required";
  return "External app";
});

const bridgeLabel = computed(() => {
  if (preflight.value?.mcpStatus === "installed") return "Installed";
  if (preflight.value?.mcpStatus === "needs_attention") return "Needs repair";
  if (preflight.value?.mcpStatus === "not_installed") return "Not installed";
  return "Unknown";
});

const repoLabel = computed(() => {
  if (!agentProviderNeedsDesktopRepo(selectedProvider.value)) {
    return "Handled by provider app";
  }
  const mismatch = preflight.value?.branchMismatch;
  if (mismatch) {
    return mismatch.currentBranch
      ? `${mismatch.currentBranch} - expected ${mismatch.expectedBranch}`
      : `Expected ${mismatch.expectedBranch}`;
  }
  return props.repoRootPath || "Required before local agents can start";
});

const matchingWorktrees = computed(() =>
  props.roomGitRoom && !props.gitRoomMatchesActiveRepo
    ? []
    : matchingManagedAgentWorktreesForBranch(props.repoStatus, expectedWorktreeBranch.value)
);

const showWorktreePicker = computed(() =>
  preflight.value?.nextAction === "choose_worktree"
);

const canCreateWorktree = computed(() =>
  Boolean(
    props.repoRootPath?.trim()
    && expectedWorktreeBranch.value?.trim()
    && (!props.roomGitRoom || props.gitRoomMatchesActiveRepo),
  )
);

const createWorktreeButtonLabel = computed(() =>
  creatingWorktree.value
    ? "Creating worktree..."
    : `Create worktree on ${expectedWorktreeBranch.value}`
);

const expectedWorktreeBranch = computed(() =>
  preflight.value?.branchMismatch?.expectedBranch
  || branchScopedGitRoomExpectedBranch(props.roomGitRoom, props.repoStatus)
);

const worktreePickerDescription = computed(() => {
  const expectedBranch = expectedWorktreeBranch.value || "this branch";
  if (matchingWorktrees.value.length) {
    return `Pick an existing checkout on ${expectedBranch}.`;
  }
  return `Open an existing worktree on ${expectedBranch}, then check again.`;
});

const deliveryModeDescription = computed(() =>
  deliveryMode.value === "desktop_events"
    ? "This desktop app sends room updates to the local agent."
    : "The agent app joins the room through its LetAgents connection."
);

const lifecycleDescription = computed(() => {
  if (launchMode.value === "legacy") return "The current app-owned path stays unchanged and stops with its normal lifecycle.";
  if (/^local[_-]/i.test(props.roomIdentifier) || /^git-room:local:/i.test(props.roomIdentifier)) {
    return "Supervision needs a cloud room for durable workplace reachability. Local-only rooms keep the existing path.";
  }
  return "A detached daemon owns desired state and recovery. Closing this app does not stop the Codex worker.";
});

const showCursorMcpPolicySelector = computed(() =>
  shouldShowCursorMcpPolicySelector(selectedProvider.value)
);

const showDeliverySelector = computed(() =>
  shouldShowDeliveryModeSelector(selectedProvider.value)
);

const showOpenModelConfig = computed(() =>
  shouldShowOpenModelConfig(selectedProvider.value)
);

const showModelSelector = computed(() =>
  shouldShowManagedModelSelector(selectedProvider.value)
);

const showEffortSelector = computed(() =>
  selectedProviderId.value === "codex" || selectedProviderId.value === "claude-code"
);

const providerModelOptions = computed(() => providerModels.value?.models ?? []);

const providerModelCatalogLabel = computed(() => {
  if (loadingProviderModels.value) return "Loading the provider model catalog...";
  if (providerModels.value?.error) return providerModels.value.error;
  const count = providerModelOptions.value.length;
  if (count) return `${count} provider model${count === 1 ? "" : "s"} available.`;
  return "Provider default and custom model ids are available.";
});

const modelSelectOptions = computed<DesktopSelectOption[]>(() => [
  { value: "default", label: "Use provider default" },
  ...providerModelOptions.value.map((option) => ({
    value: modelChoiceValue(option),
    label: option.label,
  })),
  { value: "custom", label: "Custom model id" },
]);

const effortSelectOptions = computed<DesktopSelectOption[]>(() => [
  { value: "", label: "Use provider default" },
  ...managedAgentEffortOptionsForProvider(selectedProviderId.value),
]);

const selectedProviderModel = computed(() =>
  providerModelOptions.value.find((option) => option.id === selectedProviderModelId.value) ?? null
);

const selectedModelChoice = computed(() => {
  if (selectedModelMode.value === "option" && selectedProviderModelId.value) {
    return `option:${selectedProviderModelId.value}`;
  }
  return selectedModelMode.value;
});

const selectedModel = computed(() => {
  if (selectedModelMode.value === "option") {
    return selectedProviderModelId.value.trim() || null;
  }
  if (selectedModelMode.value === "custom") {
    return customModelId.value.trim() || null;
  }
  return null;
});

const selectedModelSource = computed<DesktopAgentProviderModelSource | null>(() => {
  if (selectedModelMode.value === "option") {
    return selectedProviderModel.value?.source ?? "provider";
  }
  if (selectedModelMode.value === "custom") {
    return "custom";
  }
  return null;
});

const selectedCursorMcpPolicyDescription = computed(() =>
  cursorMcpPolicyDescription(selectedCursorMcpPolicy.value)
);

const modelSelectorDescription = computed(() => {
  if (loadingProviderModels.value) return "Loading available models...";
  if (selectedModelMode.value === "default") {
    if (providerModels.value?.error) return providerModels.value.error;
    const defaultModel = providerModels.value?.defaultModel;
    return defaultModel
      ? `Use the provider default (${defaultModel}).`
      : "Use the model configured by the provider app.";
  }
  if (selectedModelMode.value === "custom") {
    if (selectedProviderId.value === "cursor") {
      return selectedModel.value
        ? "Pass this model id directly to Cursor. Cursor effort overrides can use Cursor's parameterized model syntax."
        : "Enter a Cursor model id or parameterized model string for this agent session.";
    }
    return selectedModel.value
      ? "Pass this model id directly to the provider for this agent session."
      : "Enter a provider model id or alias for this agent session.";
  }
  if (providerModels.value?.error && !selectedProviderModel.value) return providerModels.value.error;
  return selectedProviderModel.value
    ? `Use ${selectedProviderModel.value.label} for this agent session.`
    : "Choose another model or return to provider default.";
});

const effortSelectorDescription = computed(() => {
  if (!selectedEffort.value) {
    return "Use the provider's configured reasoning effort for this agent session.";
  }
  const label = managedAgentEffortLabel(selectedEffort.value);
  return `Use ${label.toLowerCase()} reasoning effort for this agent session.`;
});

const managedAgentStartButtonLabel = computed(() => {
  if (startingAgent.value) return "Starting...";
  if (launchMode.value === "supervised") return "Start supervised agent";
  if (!hasDesktopManagedRuntime(selectedProvider.value)) return "Start agent";
  const providerName = selectedProvider.value?.name?.trim() || "agent";
  const profileLabel = selectedPermissionProfile.value?.label?.trim();
  const prefix = activeManagedSessions.value.length ? "Start another" : "Start";
  return profileLabel
    ? `${prefix} ${providerName} - ${profileLabel}`
    : `${prefix} ${providerName}`;
});

const selectedPermissionProfileWarning = computed(() => {
  if (!hasDesktopManagedRuntime(selectedProvider.value)) {
    return null;
  }
  const profile = selectedPermissionProfile.value;
  if (!profile || profile.status !== "available") {
    return null;
  }
  const providerName = selectedProvider.value?.name?.trim() || "this agent";
  if (profile.risk === "high") {
    return `${profile.label} gives ${providerName} broad write and shell access. Use only with trusted repos and MCPs.`;
  }
  if (
    selectedProviderId.value === "cursor" &&
    profile.id === "sandboxed_write" &&
    selectedCursorMcpPolicy.value !== "none"
  ) {
    return "Sandboxed writes still allow the selected Cursor MCP tools.";
  }
  return null;
});

watch(
  () => props.open,
  (open) => {
    if (open) {
      previousFocusElement = currentFocusableElement();
      void loadProviders();
      startManagedSessionRefreshTimer();
      void nextTick(() => dialogElement.value?.focus());
    } else {
      resetTransientState();
      stopManagedSessionRefreshTimer();
      stopSupervisedRuntimeRefreshTimer();
    }
  },
  { immediate: true },
);

function handleAfterLeave(): void {
  if (props.open) return;
  restoreFocus(previousFocusElement);
  previousFocusElement = null;
}

watch(
  () => [
    selectedProviderId.value,
    props.repoRootPath,
    props.roomIdentifier,
    props.roomGitRoom?.ref.type,
    props.roomGitRoom?.ref.name,
  ] as const,
  () => {
    if (props.open && selectedProviderId.value) {
      void refreshSelectedProvider();
    }
  },
);

watch(
  () => [selectedCursorMcpPolicy.value, selectedPermissionProfileId.value] as const,
  () => {
    if (props.open && selectedProviderId.value) {
      void loadProviderModels();
      requestPreflight();
    }
  },
);

watch(
  () => [selectedModelMode.value, selectedProviderModelId.value] as const,
  () => {
    if (props.open && selectedProviderId.value) {
      requestPreflight();
    }
  },
);

watch(
  () => customModelId.value,
  () => {
    if (props.open && selectedProviderId.value && selectedModelMode.value === "custom") {
      requestPreflight({ debounce: true });
    }
  },
);

watch(
  () => selectedEffort.value,
  () => {
    if (props.open && selectedProviderId.value && showEffortSelector.value) {
      requestPreflight();
    }
  },
);

onBeforeUnmount(() => {
  clearScheduledModelPreflight();
  stopManagedSessionRefreshTimer();
  stopSupervisedRuntimeRefreshTimer();
});

async function loadManagedSessions(options: { quiet?: boolean } = {}): Promise<void> {
  if (!props.open) return;
  const requestVersion = modalStateVersion;
  try {
    const sessions = await desktopIpc.workers.listManagedAgentSessions(props.roomIdentifier);
    if (!isCurrentModalState(requestVersion)) return;
    emit("managed-sessions-updated", sessions);
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    if (!options.quiet) {
      setupMessage.value = error instanceof Error ? error.message : "Could not load managed agent sessions.";
    }
  }
}

async function refreshSelectedProvider(options: { forceModels?: boolean } = {}): Promise<void> {
  if (!props.open || !selectedProviderId.value) return;
  clearScheduledModelPreflight();
  void loadManagedSessions();
  void loadOpenModelSettings();
  void loadProviderModels({ refresh: options.forceModels });
  await runPreflight({ refreshModels: options.forceModels });
}

async function loadProviders(): Promise<void> {
  if (!props.open || loadingProviders.value) return;
  const requestVersion = modalStateVersion;
  loadingProviders.value = true;
  loadError.value = null;
  try {
    const nextProviders = visibleDesktopAgentProviders(
      await desktopIpc.workers.listAgentProviders(),
    );
    if (!isCurrentModalState(requestVersion)) return;
    providers.value = nextProviders;
    const previousProviderId = selectedProviderId.value;
    selectedProviderId.value = selectedProviderId.value
      && providers.value.some((provider) => provider.id === selectedProviderId.value)
      ? selectedProviderId.value
      : providers.value.find((provider) => provider.id === "codex")?.id || providers.value[0]?.id || null;
    syncPermissionProfileSelection();
    syncDeliveryModeSelection();
    if (selectedProviderId.value && selectedProviderId.value === previousProviderId) {
      await refreshSelectedProvider();
    }
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    loadError.value = error instanceof Error ? error.message : "Could not load agent providers.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      loadingProviders.value = false;
    }
  }
}

async function startManagedAgent(): Promise<void> {
  if (!selectedProviderId.value || !props.repoRootPath || startingAgent.value) return;
  if (!hasDesktopManagedRuntime(selectedProvider.value)) return;
  const requestVersion = modalStateVersion;
  startingAgent.value = true;
  setupMessage.value = null;
  startManagedSessionRefreshTimer(1_000);
  try {
    if (launchMode.value === "supervised") {
      if (!hasSupervisedRuntime(selectedProvider.value)) {
        throw new Error("This provider has not passed the durable supervision evidence gate.");
      }
      supervisedCreationRequestId ||= window.crypto.randomUUID();
      const entry = await desktopIpc.supervisor.createAgent({
        creationRequestId: supervisedCreationRequestId,
        providerId: selectedProviderId.value,
        roomIdentifier: props.roomIdentifier,
        displayName: `${selectedProvider.value?.name ?? "Agent"} supervised agent`,
        repoRootPath: props.repoRootPath,
        charter: supervisedCharter.value.trim(),
        permissionProfileId: selectedPermissionProfile.value?.id ?? null,
        model: selectedModel.value,
      });
      if (!isCurrentModalState(requestVersion)) return;
      // A durable `running` claim returns before the native provider has
      // published room presence. Render this manifest entry immediately so
      // the first Start click has a visible result and cannot be mistaken for
      // a no-op that needs a second click.
      supervisedConflict.value = entry;
      supervisedCreationRequestId = null;
      supervisedConflictLookupError.value = null;
      setupMessage.value = `${entry.displayName} is ${entry.observedState}; the supervisor daemon owns its lifecycle.`;
      startSupervisedRuntimeRefresh(entry.id);
      void loadManagedSessions({ quiet: true });
      return;
    }
    const result = await desktopIpc.workers.startManagedAgent({
      providerId: selectedProviderId.value,
      roomIdentifier: props.roomIdentifier,
      roomGitRoom: props.roomGitRoom,
      roomDisplayName: props.roomDisplayName,
      repoRootPath: props.repoRootPath,
      deliveryMode: deliveryMode.value,
      permissionProfileId: selectedPermissionProfile.value?.id ?? null,
      cursorMcpPolicy: selectedProviderId.value === "cursor" ? selectedCursorMcpPolicy.value : null,
      model: selectedModel.value,
      modelSource: selectedModelSource.value,
      effort: selectedEffort.value || null,
    });
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = result.message;
    upsertManagedSession(result.session);
    emit("managed-session-started", result.session);
    await loadManagedSessions();
    await runPreflight();
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    if (launchMode.value === "supervised") {
      const entryId = supervisedCreationRequestId ? `supervised_${supervisedCreationRequestId}` : null;
      if (entryId) {
        const recovery = await refreshSupervisedRuntimeEntry(desktopIpc.supervisor, props.roomIdentifier, entryId);
        if (!isCurrentModalState(requestVersion)) return;
        supervisedConflict.value = recovery.entry?.desiredState === "stopped" ? null : recovery.entry;
        supervisedConflictLookupError.value = recovery.entry ? null : recovery.error;
      }
    }
    setupMessage.value = error instanceof Error ? error.message : "Could not start this agent.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      startingAgent.value = false;
      startManagedSessionRefreshTimer();
    }
  }
}

async function stopSupervisedConflict(): Promise<void> {
  const entry = supervisedConflict.value;
  if (!entry || stoppingSupervisorEntryId.value) return;
  const requestVersion = modalStateVersion;
  stoppingSupervisorEntryId.value = entry.id;
  setupMessage.value = `Stopping ${entry.displayName}...`;
  try {
    const updated = await stopSupervisedProviderLane(desktopIpc.supervisor, entry.id);
    if (!isCurrentModalState(requestVersion)) return;
    supervisedConflict.value = updated.desiredState === "stopped" ? null : updated;
    stopSupervisedRuntimeRefreshTimer();
    setupMessage.value = `${updated.displayName} is stopped. Start once to create its replacement.`;
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = error instanceof Error ? error.message : "Could not stop the supervised agent.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      stoppingSupervisorEntryId.value = null;
    }
  }
}

async function stopManagedAgent(sessionId: string): Promise<void> {
  if (stoppingSessionId.value) return;
  const requestVersion = modalStateVersion;
  stoppingSessionId.value = sessionId;
  setupMessage.value = "Stopping local agent...";
  try {
    const session = await desktopIpc.workers.stopManagedAgent({
      sessionId,
      stopMode: "worker",
    });
    if (!isCurrentModalState(requestVersion)) return;
    if (session) {
      setupMessage.value = managedAgentStopResultMessage(session);
      upsertManagedSession(session);
    }
    await loadManagedSessions();
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = error instanceof Error ? error.message : "Could not stop this agent.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      stoppingSessionId.value = null;
    }
  }
}

async function loadOpenModelSettings(): Promise<void> {
  if (!showOpenModelConfig.value) return;
  const requestVersion = modalStateVersion;
  try {
    const status = await desktopIpc.openModel.getSettingsStatus();
    if (!isCurrentModalState(requestVersion)) return;
    openModelStatus.value = status;
    openModelBaseUrl.value = status.baseUrl;
    openModelModel.value = status.model;
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = error instanceof Error ? error.message : "Could not load open model settings.";
  }
}

async function loadProviderModels(options: { refresh?: boolean } = {}): Promise<void> {
  if (!props.open || !selectedProviderId.value || !showModelSelector.value) {
    providerModels.value = null;
    return;
  }
  const requestVersion = modalStateVersion;
  const requestId = ++modelRequestId;
  const requestProviderId = selectedProviderId.value;
  const listModels = desktopIpc.workers.listAgentProviderModels;
  if (typeof listModels !== "function") {
    providerModels.value = {
      providerId: requestProviderId,
      status: "unavailable",
      models: [],
      defaultModel: null,
      error: "Restart the desktop app to load provider model options.",
    };
    loadingProviderModels.value = false;
    return;
  }
  loadingProviderModels.value = true;
  try {
    const result = await listModels(
      requestProviderId,
      {
        roomIdentifier: props.roomIdentifier,
        roomGitRoom: props.roomGitRoom,
        repoRootPath: props.repoRootPath,
        cursorMcpPolicy: requestProviderId === "cursor" ? selectedCursorMcpPolicy.value : null,
        model: selectedModel.value,
        modelSource: selectedModelSource.value,
        effort: selectedEffort.value || null,
        refreshModels: options.refresh,
      },
    );
    if (
      isCurrentModalState(requestVersion) &&
      requestId === modelRequestId &&
      selectedProviderId.value === requestProviderId
    ) {
      providerModels.value = result;
      syncSelectedProviderModelSelection(result);
    }
  } catch (error) {
    if (
      isCurrentModalState(requestVersion) &&
      requestId === modelRequestId &&
      selectedProviderId.value === requestProviderId
    ) {
      providerModels.value = {
        providerId: requestProviderId,
        status: "error",
        models: [],
        defaultModel: null,
        error: error instanceof Error ? error.message : "Could not load provider models.",
      };
    }
  } finally {
    if (isCurrentModalState(requestVersion) && requestId === modelRequestId) {
      loadingProviderModels.value = false;
    }
  }
}

function refreshProviderModels(): void {
  if (loadingProviderModels.value) return;
  void loadProviderModels({ refresh: true });
}

function requestPreflight(options: { debounce?: boolean } = {}): void {
  if (!props.open || !selectedProviderId.value) return;
  clearScheduledModelPreflight();
  invalidateCurrentPreflight();
  if (options.debounce) {
    modelPreflightTimer = window.setTimeout(() => {
      modelPreflightTimer = null;
      void runPreflight();
    }, MODEL_PREFLIGHT_DEBOUNCE_MS);
    return;
  }
  void runPreflight();
}

function invalidateCurrentPreflight(): void {
  preflight.value = null;
  setupConfirmation.value = null;
  loadingPreflight.value = false;
  preflightRequestId += 1;
}

function clearScheduledModelPreflight(): void {
  if (modelPreflightTimer !== null) {
    window.clearTimeout(modelPreflightTimer);
    modelPreflightTimer = null;
  }
}

function syncSelectedProviderModelSelection(
  result: DesktopAgentProviderModelsResult | null = providerModels.value,
): void {
  if (selectedModelMode.value !== "option" || !selectedProviderModelId.value) return;
  if (result?.status !== "ready") return;
  if (result.models.some((option) => option.id === selectedProviderModelId.value)) return;
  selectDefaultModel();
}

async function applyOpenModelSettings(input: {
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
}): Promise<void> {
  if (savingOpenModelSettings.value) return;
  const requestVersion = modalStateVersion;
  savingOpenModelSettings.value = true;
  setupMessage.value = null;
  try {
    const status = await desktopIpc.openModel.saveSettings(input);
    if (!isCurrentModalState(requestVersion)) return;
    openModelStatus.value = status;
    openModelBaseUrl.value = status.baseUrl;
    openModelModel.value = status.model;
    openModelApiKey.value = "";
    setupMessage.value = "Model settings saved.";
    await loadProviderModels();
    await runPreflight();
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = error instanceof Error ? error.message : "Could not save model settings.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      savingOpenModelSettings.value = false;
    }
  }
}

function saveOpenModelSettings(): Promise<void> {
  const apiKey = openModelApiKey.value.trim();
  return applyOpenModelSettings({
    baseUrl: openModelBaseUrl.value.trim() || null,
    model: openModelModel.value.trim() || null,
    ...(apiKey ? { apiKey } : {}),
  });
}

function clearOpenModelApiKey(): Promise<void> {
  return applyOpenModelSettings({ apiKey: null });
}

function selectProvider(providerId: DesktopAgentProviderId): void {
  modalStateVersion += 1;
  clearScheduledModelPreflight();
  selectedProviderId.value = providerId;
  if (!hasSupervisedRuntime(selectedProvider.value)) {
    launchMode.value = "legacy";
  }
  resetModelSelection();
  syncPermissionProfileSelection();
  syncDeliveryModeSelection();
  preflight.value = null;
  preflightRequestId += 1;
  loadingPreflight.value = false;
  setupBusy.value = false;
  startingAgent.value = false;
  stoppingSessionId.value = null;
  stoppingSupervisorEntryId.value = null;
  stopSupervisedRuntimeRefreshTimer();
  supervisedConflict.value = null;
  supervisedConflictLookupError.value = null;
  supervisedCreationRequestId = null;
  copyingAuthCommand.value = false;
  copyingExternalPrompt.value = false;
  setupConfirmation.value = null;
  setupMessage.value = null;
}

function syncDeliveryModeSelection(): void {
  if (!shouldShowDeliveryModeSelector(selectedProvider.value)) {
    deliveryMode.value = "desktop_events";
  }
}

function resetModelSelection(): void {
  clearScheduledModelPreflight();
  selectedModelMode.value = "default";
  selectedProviderModelId.value = "";
  customModelId.value = "";
  selectedEffort.value = "";
  providerModels.value = null;
  loadingProviderModels.value = false;
  modelRequestId += 1;
}

function selectDefaultModel(): void {
  selectedModelMode.value = "default";
  selectedProviderModelId.value = "";
}

function selectProviderModel(option: DesktopAgentProviderModelOption): void {
  selectedModelMode.value = "option";
  selectedProviderModelId.value = option.id;
}

function selectCustomModel(): void {
  selectedModelMode.value = "custom";
}

function modelChoiceValue(option: DesktopAgentProviderModelOption): string {
  return `option:${option.id}`;
}

function handleModelChoiceValue(value: string): void {
  if (value === "default") {
    selectDefaultModel();
    return;
  }
  if (value === "custom") {
    selectCustomModel();
    return;
  }
  if (value.startsWith("option:")) {
    const modelId = value.slice("option:".length);
    const option = providerModelOptions.value.find((entry) => entry.id === modelId);
    if (option) {
      selectProviderModel(option);
    }
  }
}

function handleEffortValue(value: string): void {
  selectedEffort.value = value === "" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : "";
}

function syncPermissionProfileSelection(): void {
  const nextId = managedAgentPermissionProfileSelectionForProvider(
    selectedProvider.value,
    selectedPermissionProfileIdsByProvider.value,
  );
  selectedPermissionProfileId.value = nextId;
  if (selectedProviderId.value && nextId) {
    selectedPermissionProfileIdsByProvider.value = {
      ...selectedPermissionProfileIdsByProvider.value,
      [selectedProviderId.value]: nextId,
    };
  }
}

function selectPermissionProfile(profile: DesktopManagedAgentPermissionProfile): void {
  if (profile.status !== "available") return;
  selectedPermissionProfileId.value = profile.id;
  if (selectedProviderId.value) {
    selectedPermissionProfileIdsByProvider.value = {
      ...selectedPermissionProfileIdsByProvider.value,
      [selectedProviderId.value]: profile.id,
    };
  }
}

function permissionProfileSummary(profile: DesktopManagedAgentPermissionProfile): string {
  return managedAgentPermissionProfileSummary(profile);
}

function permissionProfileOptionSummary(profile: DesktopManagedAgentPermissionProfile): string {
  if (profile.status === "available") {
    return profile.description;
  }
  return `${managedAgentPermissionProfileStatusLabel(profile.status)} - ${profile.detail || profile.description}`;
}

function managedAgentEffortOptionsForProvider(
  providerId: DesktopAgentProviderId | null,
): DesktopSelectOption[] {
  if (providerId === "codex") {
    return [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
    ];
  }
  if (providerId === "claude-code") {
    return [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra high" },
      { value: "max", label: "Max" },
    ];
  }
  return [];
}

function managedAgentEffortLabel(effort: DesktopManagedAgentEffort | string | null | undefined): string {
  if (effort === "low") return "Low";
  if (effort === "medium") return "Medium";
  if (effort === "high") return "High";
  if (effort === "xhigh") return "Extra high";
  if (effort === "max") return "Max";
  return "";
}

function managedAgentSessionDetail(session: DesktopManagedAgentSession): string {
  return [
    managedAgentSessionStatusLabel(session),
    managedAgentPermissionProfileLabel(session),
    session.providerId === "cursor" ? cursorMcpPolicyLabel(session.cursorMcpPolicy) : null,
    session.model || null,
    session.effort ? `${managedAgentEffortLabel(session.effort)} effort` : null,
    managedAgentRepoDetail(session, props.roomGitRoom),
  ].filter(Boolean).join(" - ");
}

function resetTransientState(): void {
  modalStateVersion += 1;
  preflightRequestId += 1;
  clearScheduledModelPreflight();
  loadingProviders.value = false;
  loadingPreflight.value = false;
  setupBusy.value = false;
  startingAgent.value = false;
  stoppingSessionId.value = null;
  stoppingSupervisorEntryId.value = null;
  stopSupervisedRuntimeRefreshTimer();
  supervisedConflict.value = null;
  supervisedConflictLookupError.value = null;
  supervisedCreationRequestId = null;
  copyingAuthCommand.value = false;
  copyingExternalPrompt.value = false;
  setupConfirmation.value = null;
  setupMessage.value = null;
  loadError.value = null;
  openModelApiKey.value = "";
  savingOpenModelSettings.value = false;
  resetModelSelection();
}

function upsertManagedSession(session: DesktopManagedAgentSession): void {
  emit("managed-sessions-updated", [
    session,
    ...props.managedSessions.filter((entry) => entry.id !== session.id),
  ]);
}

function startManagedSessionRefreshTimer(intervalMs = 4_000): void {
  stopManagedSessionRefreshTimer();
  managedSessionRefreshTimer = window.setInterval(() => {
    void loadManagedSessions({ quiet: true });
  }, intervalMs);
}

function stopManagedSessionRefreshTimer(): void {
  if (managedSessionRefreshTimer !== null) {
    window.clearInterval(managedSessionRefreshTimer);
    managedSessionRefreshTimer = null;
  }
}

function startSupervisedRuntimeRefresh(entryId: string, intervalMs = 1_000): void {
  stopSupervisedRuntimeRefreshTimer();
  const refresh = async (): Promise<void> => {
    if (!props.open || supervisedConflict.value?.id !== entryId) {
      stopSupervisedRuntimeRefreshTimer();
      return;
    }
    const requestVersion = modalStateVersion;
    const refreshed = await refreshSupervisedRuntimeEntry(
      desktopIpc.supervisor,
      props.roomIdentifier,
      entryId,
    );
    if (!isCurrentModalState(requestVersion) || supervisedConflict.value?.id !== entryId) return;
    if (refreshed.error) {
      supervisedConflictLookupError.value = refreshed.error;
      return;
    }
    if (!refreshed.entry) {
      supervisedConflictLookupError.value = "The supervised runtime is no longer listed by the daemon. It was not restarted.";
      stopSupervisedRuntimeRefreshTimer();
      return;
    }
    supervisedConflict.value = refreshed.entry;
    supervisedConflictLookupError.value = null;
    if (isSupervisedRuntimeSettled(refreshed.entry)) {
      stopSupervisedRuntimeRefreshTimer();
    }
  };
  void refresh();
  supervisedRuntimeRefreshTimer = window.setInterval(() => void refresh(), intervalMs);
}

function stopSupervisedRuntimeRefreshTimer(): void {
  if (supervisedRuntimeRefreshTimer !== null) {
    window.clearInterval(supervisedRuntimeRefreshTimer);
    supervisedRuntimeRefreshTimer = null;
  }
}

function isCurrentModalState(version: number): boolean {
  return props.open && version === modalStateVersion;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

async function runPreflight(options: { refreshModels?: boolean } = {}): Promise<void> {
  if (!selectedProviderId.value) return;
  clearScheduledModelPreflight();
  const requestProviderId = selectedProviderId.value;
  const requestVersion = modalStateVersion;
  const requestId = ++preflightRequestId;
  loadingPreflight.value = true;
  loadError.value = null;
  setupConfirmation.value = null;
  try {
    const result = await desktopIpc.workers.runAgentProviderPreflight(
      requestProviderId,
      {
        roomIdentifier: props.roomIdentifier,
        roomGitRoom: props.roomGitRoom,
        repoRootPath: props.repoRootPath,
        permissionProfileId: selectedPermissionProfile.value?.id ?? null,
        cursorMcpPolicy: requestProviderId === "cursor" ? selectedCursorMcpPolicy.value : null,
        model: selectedModel.value,
        modelSource: selectedModelSource.value,
        effort: selectedEffort.value || null,
        refreshModels: options.refreshModels,
      },
    );
    if (
      isCurrentModalState(requestVersion) &&
      requestId === preflightRequestId &&
      selectedProviderId.value === requestProviderId
    ) {
      preflight.value = result;
    }
  } catch (error) {
    if (
      isCurrentModalState(requestVersion) &&
      requestId === preflightRequestId &&
      selectedProviderId.value === requestProviderId
    ) {
      loadError.value = error instanceof Error ? error.message : "Could not check provider readiness.";
    }
  } finally {
    if (isCurrentModalState(requestVersion) && requestId === preflightRequestId) {
      loadingPreflight.value = false;
    }
  }
}

async function runSetupAction(action: DesktopAgentProviderSetupAction): Promise<void> {
  if (!selectedProviderId.value) return;
  const providerId = selectedProviderId.value;
  if (!isAgentSetupConfirmationActive(setupConfirmation.value, providerId, action)) {
    setupConfirmation.value = { providerId, action };
    setupMessage.value = agentSetupConfirmationMessage(action, selectedProvider.value);
    return;
  }

  setupBusy.value = true;
  setupMessage.value = null;
  const requestVersion = modalStateVersion;
  try {
    const result = await desktopIpc.workers.runAgentProviderSetup(
      providerId,
      {
        action,
        confirmed: true,
        roomIdentifier: props.roomIdentifier,
        repoRootPath: props.repoRootPath,
      },
    );
    if (!isCurrentModalState(requestVersion) || selectedProviderId.value !== providerId) return;
    setupMessage.value = result.message;
    setupConfirmation.value = null;
    await runPreflight();
  } catch (error) {
    if (!isCurrentModalState(requestVersion) || selectedProviderId.value !== providerId) return;
    setupMessage.value = error instanceof Error ? error.message : "Setup action failed.";
  } finally {
    if (isCurrentModalState(requestVersion) && selectedProviderId.value === providerId) {
      setupBusy.value = false;
    }
  }
}

function chooseWorktree(rootPath: string): void {
  const trimmed = rootPath.trim();
  if (!trimmed) return;
  emit("choose-worktree", trimmed);
}

async function createWorktree(): Promise<void> {
  const repoRoot = props.repoRootPath?.trim();
  const branch = expectedWorktreeBranch.value?.trim();
  if (!repoRoot || !branch || creatingWorktree.value) return;
  creatingWorktree.value = true;
  setupMessage.value = null;
  try {
    // On failure the modal stays open with the error visible and the button as
    // the retry path; on success the regular choose-worktree flow takes over.
    const errorMessage = await createManagedAgentWorktree({
      repoRoot,
      branch,
      createWorktree: (root, branchName) =>
        desktopIpc.repos.createWorktree(root, branchName),
      chooseWorktree: (rootPath) => emit("choose-worktree", rootPath),
    });
    if (errorMessage) {
      setupMessage.value = errorMessage;
    }
  } finally {
    creatingWorktree.value = false;
  }
}

function setupActionButtonText(action: DesktopAgentProviderSetupAction): string {
  return agentSetupActionButtonLabel(
    action,
    selectedProvider.value,
    isAgentSetupConfirmationActive(setupConfirmation.value, selectedProviderId.value, action),
    setupBusy.value,
  );
}

async function copyAgentAuthCommand(): Promise<void> {
  const command = authCommand.value;
  if (!command || copyingAuthCommand.value) return;

  const requestVersion = modalStateVersion;
  copyingAuthCommand.value = true;
  setupMessage.value = null;
  try {
    const copiedCommand = await copyTextToClipboard(command);
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = copiedCommand
      ? `Copied: ${command}`
      : `Clipboard unavailable. Run: ${command}`;
  } finally {
    if (isCurrentModalState(requestVersion)) {
      copyingAuthCommand.value = false;
    }
  }
}

async function copyExternalJoinPrompt(): Promise<void> {
  const prompt = externalJoinPrompt.value;
  if (!prompt || copyingExternalPrompt.value) return;

  const requestVersion = modalStateVersion;
  copyingExternalPrompt.value = true;
  setupMessage.value = null;
  try {
    const copiedPrompt = await copyTextToClipboard(prompt);
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = copiedPrompt
      ? "Copied the agent join prompt."
      : "Clipboard unavailable. Open Show full instructions, then copy the prompt manually.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      copyingExternalPrompt.value = false;
    }
  }
}
</script>
