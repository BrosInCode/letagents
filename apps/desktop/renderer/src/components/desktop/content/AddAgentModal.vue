<template>
  <Teleport to="body">
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
              Choose a provider, then complete any setup needed before it can join
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
            <button
              v-for="provider in providers"
              :key="provider.id"
              class="desktop-add-agent-provider"
              type="button"
              :data-selected="provider.id === selectedProviderId"
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
              <button type="button" :disabled="loadingPreflight || !selectedProviderId" @click="runPreflight">
                {{ loadingPreflight ? "Checking..." : "Check again" }}
              </button>
            </div>

            <p v-if="preflight?.detail">{{ preflight.detail }}</p>
            <p v-else-if="loadError">{{ loadError }}</p>
            <p v-else>Checking provider readiness...</p>

            <dl class="desktop-add-agent-checks">
              <div>
                <dt>Runtime</dt>
                <dd>{{ runtimeLabel }}</dd>
              </div>
              <div>
                <dt>Bridge</dt>
                <dd>{{ bridgeLabel }}</dd>
              </div>
              <div>
                <dt>Repository</dt>
                <dd>{{ repoLabel }}</dd>
              </div>
            </dl>

            <section
              v-if="preflight?.nextAction === 'authenticate' && authCommand"
              class="desktop-add-agent-auth-command"
              aria-label="Agent sign-in command"
            >
              <span>Sign-in command</span>
              <code>{{ authCommand }}</code>
            </section>

            <section
              v-if="selectedProvider?.capabilities.includes('desktop_managed_runtime')"
              class="desktop-add-agent-delivery"
              aria-label="Agent delivery mode"
            >
              <span>Delivery</span>
              <div>
                <button
                  type="button"
                  :data-selected="deliveryMode === 'mcp_polling'"
                  @click="deliveryMode = 'mcp_polling'"
                >
                  MCP loop
                </button>
                <button
                  type="button"
                  :data-selected="deliveryMode === 'desktop_events'"
                  @click="deliveryMode = 'desktop_events'"
                >
                  Desktop events
                </button>
              </div>
              <p>{{ deliveryModeDescription }}</p>
            </section>

            <section
              v-if="externalJoinPrompt"
              class="desktop-add-agent-external-prompt"
              data-testid="desktop-add-agent-external-prompt"
              aria-label="External agent join prompt"
            >
              <div>
                <span>CLI prompt</span>
                <button
                  type="button"
                  :disabled="copyingExternalPrompt"
                  @click="copyExternalJoinPrompt"
                >
                  {{ copyingExternalPrompt ? "Copying..." : "Copy" }}
                </button>
              </div>
              <pre><code>{{ externalJoinPrompt }}</code></pre>
            </section>

            <section v-if="activeManagedSessions.length" class="desktop-add-agent-managed-sessions">
              <article
                v-for="session in activeManagedSessions"
                :key="session.id"
                class="desktop-add-agent-managed-session"
              >
                <span>{{ session.deliveryMode === "desktop_events" ? "Desktop events" : "MCP loop" }}</span>
                <strong>{{ managedAgentSessionDisplayName(session) }}</strong>
                <small>{{ managedAgentSessionStatusLabel(session) }} - {{ session.repoRootPath }}</small>
                <div class="desktop-add-agent-managed-session-actions">
                  <button
                    type="button"
                    :disabled="!session.canStop || Boolean(stoppingSessionId)"
                    @click="stopManagedAgent(session.id, 'turn')"
                  >
                    {{ stoppingSessionId === session.id && stoppingSessionMode === "turn" ? "Stopping..." : "Stop turn" }}
                  </button>
                  <button
                    type="button"
                    class="desktop-add-agent-managed-session-danger"
                    :disabled="!session.canStop || Boolean(stoppingSessionId)"
                    @click="stopManagedAgent(session.id, 'worker')"
                  >
                    {{ stoppingSessionId === session.id && stoppingSessionMode === "worker" ? "Stopping..." : "Stop agent" }}
                  </button>
                </div>
              </article>
            </section>

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
                Choose repository
              </button>

              <button
                v-else-if="hasDesktopManagedRuntime(selectedProvider)"
                type="button"
                class="desktop-add-agent-primary"
                :disabled="!preflight?.canStart || startingAgent"
                @click="startManagedAgent"
              >
                {{ startingAgent ? "Starting..." : activeManagedSessions.length ? "Start another" : "Start agent" }}
              </button>

              <span v-if="activeSetupConfirmation" class="desktop-add-agent-confirmation">
                Review this action, then confirm to continue.
              </span>
              <span v-else-if="isExternalMcpProviderReady(selectedProvider, preflight)" class="desktop-add-agent-confirmation">
                {{ externalMcpProviderInstruction(selectedProvider) }}
              </span>
              <span v-else-if="activeManagedSessions.length" class="desktop-add-agent-confirmation">
                Each start creates a separate supervised worker.
              </span>
              <span
                v-else-if="preflight?.status === 'ready' && hasDesktopManagedRuntime(selectedProvider)"
                class="desktop-add-agent-confirmation"
              >
                Starts a supervised Codex worker for this room.
              </span>
            </div>

            <p v-if="setupMessage" class="desktop-add-agent-feedback">{{ setupMessage }}</p>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X } from "@lucide/vue";
import type {
  DesktopAgentProvider,
  DesktopAgentProviderId,
  DesktopAgentProviderPreflight,
  DesktopAgentProviderSetupAction,
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentSession,
} from "../../../../../electron/ipc-types";
import {
  agentSetupActionButtonLabel,
  agentSetupConfirmationMessage,
  agentAuthCommand,
  agentProviderNeedsDesktopRepo,
  externalMcpProviderJoinPrompt,
  externalMcpProviderInstruction,
  hasDesktopManagedRuntime,
  isAgentSetupConfirmationActive,
  isExternalMcpProviderReady,
  isVisibleManagedAgentSession,
  managedAgentSessionDisplayName,
  managedAgentSessionMatchesRoom,
  managedAgentSessionStatusLabel,
  managedAgentStopResultMessage,
  type AgentSetupConfirmation,
} from "../../../domain/managed-agents";
import McpHarnessIcon from "../setup/McpHarnessIcon.vue";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string;
  roomDisplayName: string | null;
  repoRootPath: string | null;
  managedSessions: DesktopManagedAgentSession[];
}>();

const emit = defineEmits<{
  close: [];
  "choose-repo": [];
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
const stoppingSessionId = ref<string | null>(null);
const stoppingSessionMode = ref<"turn" | "worker" | null>(null);
const copyingAuthCommand = ref(false);
const copyingExternalPrompt = ref(false);
const setupConfirmation = ref<AgentSetupConfirmation | null>(null);
const loadError = ref<string | null>(null);
const setupMessage = ref<string | null>(null);
const deliveryMode = ref<DesktopManagedAgentDeliveryMode>("desktop_events");
const dialogElement = ref<HTMLElement | null>(null);
let previousFocusElement: HTMLElement | null = null;
let preflightRequestId = 0;
let modalStateVersion = 0;
let managedSessionRefreshTimer: number | null = null;

const selectedProvider = computed(() =>
  providers.value.find((provider) => provider.id === selectedProviderId.value) || null
);

const activeManagedSessions = computed(() =>
  props.managedSessions.filter((session) =>
    session.providerId === selectedProviderId.value
    && managedAgentSessionMatchesRoom(session, props.roomIdentifier)
    && isVisibleManagedAgentSession(session)
  )
);

const authCommand = computed(() => agentAuthCommand(selectedProvider.value));
const roomLabel = computed(() => props.roomDisplayName?.trim() || props.roomIdentifier);
const externalJoinPrompt = computed(() =>
  isExternalMcpProviderReady(selectedProvider.value, preflight.value)
    ? externalMcpProviderJoinPrompt(selectedProvider.value, props.roomIdentifier)
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
  return props.repoRootPath || "Required for local agents";
});

const deliveryModeDescription = computed(() =>
  deliveryMode.value === "desktop_events"
    ? "The desktop room stream feeds new room events into Codex."
    : "Codex joins the room and waits through the LetAgents MCP bridge."
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      previousFocusElement = currentFocusableElement();
      void loadProviders();
      void loadManagedSessions();
      startManagedSessionRefreshTimer();
      void nextTick(() => dialogElement.value?.focus());
    } else {
      resetTransientState();
      stopManagedSessionRefreshTimer();
      restoreFocus(previousFocusElement);
      previousFocusElement = null;
    }
  },
  { immediate: true },
);

watch(
  () => [selectedProviderId.value, props.repoRootPath, props.roomIdentifier] as const,
  () => {
    if (props.open && selectedProviderId.value) {
      void runPreflight();
      void loadManagedSessions();
    }
  },
);

onBeforeUnmount(() => {
  stopManagedSessionRefreshTimer();
});

async function loadManagedSessions(options: { quiet?: boolean } = {}): Promise<void> {
  if (!props.open) return;
  const requestVersion = modalStateVersion;
  try {
    const sessions = await window.letagentsDesktop.workers.listManagedAgentSessions(props.roomIdentifier);
    if (!isCurrentModalState(requestVersion)) return;
    emit("managed-sessions-updated", sessions);
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    if (!options.quiet) {
      setupMessage.value = error instanceof Error ? error.message : "Could not load managed agent sessions.";
    }
  }
}

async function loadProviders(): Promise<void> {
  if (!props.open || loadingProviders.value) return;
  const requestVersion = modalStateVersion;
  loadingProviders.value = true;
  loadError.value = null;
  try {
    const nextProviders = await window.letagentsDesktop.workers.listAgentProviders();
    if (!isCurrentModalState(requestVersion)) return;
    providers.value = nextProviders;
    await loadManagedSessions();
    if (!isCurrentModalState(requestVersion)) return;
    selectedProviderId.value = selectedProviderId.value
      && providers.value.some((provider) => provider.id === selectedProviderId.value)
      ? selectedProviderId.value
      : providers.value.find((provider) => provider.id === "codex")?.id || providers.value[0]?.id || null;
    if (selectedProviderId.value) {
      await runPreflight();
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
    const result = await window.letagentsDesktop.workers.startManagedAgent({
      providerId: selectedProviderId.value,
      roomIdentifier: props.roomIdentifier,
      roomDisplayName: props.roomDisplayName,
      repoRootPath: props.repoRootPath,
      deliveryMode: deliveryMode.value,
    });
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = result.message;
    upsertManagedSession(result.session);
    emit("managed-session-started", result.session);
    await loadManagedSessions();
    await runPreflight();
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = error instanceof Error ? error.message : "Could not start this agent.";
  } finally {
    if (isCurrentModalState(requestVersion)) {
      startingAgent.value = false;
      startManagedSessionRefreshTimer();
    }
  }
}

async function stopManagedAgent(sessionId: string, stopMode: "turn" | "worker"): Promise<void> {
  if (stoppingSessionId.value) return;
  const requestVersion = modalStateVersion;
  stoppingSessionId.value = sessionId;
  stoppingSessionMode.value = stopMode;
  setupMessage.value = stopMode === "worker"
    ? "Stopping local agent..."
    : "Stopping current turn...";
  try {
    const session = await window.letagentsDesktop.workers.stopManagedAgent({
      sessionId,
      stopMode,
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
      stoppingSessionMode.value = null;
    }
  }
}

function selectProvider(providerId: DesktopAgentProviderId): void {
  modalStateVersion += 1;
  selectedProviderId.value = providerId;
  preflight.value = null;
  preflightRequestId += 1;
  loadingPreflight.value = false;
  setupBusy.value = false;
  startingAgent.value = false;
  stoppingSessionId.value = null;
  stoppingSessionMode.value = null;
  copyingAuthCommand.value = false;
  copyingExternalPrompt.value = false;
  setupConfirmation.value = null;
  setupMessage.value = null;
}

function resetTransientState(): void {
  modalStateVersion += 1;
  preflightRequestId += 1;
  loadingProviders.value = false;
  loadingPreflight.value = false;
  setupBusy.value = false;
  startingAgent.value = false;
  stoppingSessionId.value = null;
  stoppingSessionMode.value = null;
  copyingAuthCommand.value = false;
  copyingExternalPrompt.value = false;
  setupConfirmation.value = null;
  setupMessage.value = null;
  loadError.value = null;
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

function isCurrentModalState(version: number): boolean {
  return props.open && version === modalStateVersion;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

async function runPreflight(): Promise<void> {
  if (!selectedProviderId.value) return;
  const requestProviderId = selectedProviderId.value;
  const requestVersion = modalStateVersion;
  const requestId = ++preflightRequestId;
  loadingPreflight.value = true;
  loadError.value = null;
  setupConfirmation.value = null;
  try {
    const result = await window.letagentsDesktop.workers.runAgentProviderPreflight(
      requestProviderId,
      {
        roomIdentifier: props.roomIdentifier,
        repoRootPath: props.repoRootPath,
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
    const result = await window.letagentsDesktop.workers.runAgentProviderSetup(
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
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable.");
    }
    await navigator.clipboard.writeText(command);
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = `Copied: ${command}`;
  } catch {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = `Clipboard unavailable. Run: ${command}`;
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
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard is unavailable.");
    }
    await navigator.clipboard.writeText(prompt);
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = "Copied the agent join prompt.";
  } catch {
    if (!isCurrentModalState(requestVersion)) return;
    setupMessage.value = `Clipboard unavailable. Prompt: ${prompt}`;
  } finally {
    if (isCurrentModalState(requestVersion)) {
      copyingExternalPrompt.value = false;
    }
  }
}
</script>
