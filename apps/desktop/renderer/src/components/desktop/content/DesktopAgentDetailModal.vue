<template>
  <Teleport to="body">
    <div
      v-if="open && target"
      class="desktop-agent-detail-backdrop"
      data-testid="desktop-agent-detail-modal"
      @click.self="emit('close')"
    >
      <section
        ref="dialogElement"
        class="desktop-agent-detail-modal"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        @keydown.esc.prevent="emit('close')"
        @keydown.tab="handleDialogTab"
      >
        <header class="desktop-agent-detail-header">
          <div class="desktop-agent-detail-title-block">
            <span>Agent</span>
            <div class="desktop-agent-detail-title-row">
              <span
                v-if="matchingManagedSessions.length"
                class="desktop-agent-detail-status-pulse"
                :data-state="isPrimaryAgentRunning ? 'running' : 'idle'"
                :title="isPrimaryAgentRunning ? 'Agent is running' : 'Agent is not currently running'"
                aria-hidden="true"
              />
              <h3 :id="titleId">{{ target.displayName }}</h3>
              <div
                v-if="matchingManagedSessions.length"
                class="desktop-agent-detail-agent-actions"
                aria-label="Agent controls"
              >
                <button
                  type="button"
                  class="desktop-agent-detail-icon-button"
                  :disabled="loadingManagedSessions"
                  :title="loadingManagedSessions ? 'Refreshing agent status' : 'Refresh agent status'"
                  aria-label="Refresh agent status"
                  @click="() => loadManagedSessions()"
                >
                  <RefreshCw :size="16" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="desktop-agent-detail-icon-button desktop-agent-detail-icon-button-stop"
                  data-testid="desktop-agent-detail-stop-managed-agent"
                  :disabled="!canStopPrimaryManagedSessionTurn || Boolean(stoppingSessionId)"
                  :title="stopTurnTitle"
                  aria-label="Stop turn"
                  @click="primaryManagedSession ? stopManagedSession(primaryManagedSession.id, 'turn') : undefined"
                >
                  <Square :size="14" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="desktop-agent-detail-icon-button desktop-agent-detail-icon-button-kill"
                  data-testid="desktop-agent-detail-stop-local-agent"
                  :disabled="!primaryManagedSession || !primaryManagedSession.canStop || Boolean(stoppingSessionId)"
                  :title="isStoppingPrimarySession('worker') ? 'Stopping agent' : 'Stop local agent'"
                  aria-label="Stop local agent"
                  @click="primaryManagedSession ? stopManagedSession(primaryManagedSession.id, 'worker') : undefined"
                >
                  <Power :size="14" aria-hidden="true" />
                </button>
              </div>
            </div>
            <p>{{ identityLine }}</p>
          </div>
          <div class="desktop-agent-detail-header-actions">
            <span
              v-if="matchingManagedSessions.length"
              class="desktop-agent-detail-local-pill"
            >
              Local
            </span>
            <button
              class="desktop-modal-close"
              type="button"
              aria-label="Close agent detail dialog"
              @click="emit('close')"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div class="desktop-agent-detail-body">
          <section class="desktop-agent-detail-panel">
            <header>
              <span>Local agent</span>
            </header>

            <div v-if="matchingManagedSessions.length" class="desktop-agent-detail-session-list">
              <article
                v-for="session in matchingManagedSessions"
                :key="session.id"
                class="desktop-agent-detail-session"
                data-testid="desktop-agent-detail-managed-session"
                :data-state="session.status"
              >
                <div>
                  <strong>{{ managedAgentSessionStatusLabel(session) }}</strong>
                  <small>{{ managedAgentSessionDisplayName(session) }}</small>
                </div>
                <div
                  v-if="session.failure"
                  class="desktop-agent-detail-error"
                  role="alert"
                  data-testid="desktop-agent-detail-managed-failure"
                >
                  <strong>Could not reply</strong>
                  <p>{{ session.failure.message }}</p>
                  <small v-if="session.status === 'blocked'">Update the provider settings, then retry the failed message.</small>
                  <small v-else>LetAgents will try again when the agent receives another room message.</small>
                  <button
                    v-if="session.status === 'blocked'"
                    type="button"
                    :disabled="retryingSessionId === session.id"
                    data-testid="desktop-agent-detail-retry-managed-agent"
                    @click="retryManagedSession(session.id)"
                  >
                    {{ retryingSessionId === session.id ? "Retrying..." : "Retry failed message" }}
                  </button>
                </div>
                <p>{{ session.repoRootPath }}</p>
                <div
                  class="desktop-agent-detail-permission-profile"
                  :data-risk="session.permissionProfile.risk"
                >
                  <span>Permissions</span>
                  <strong>{{ managedAgentPermissionProfileLabel(session) }}</strong>
                  <small>{{ managedAgentPermissionProfileSummary(session.permissionProfile) }}</small>
                </div>
                <ManagedAgentChangeSummaryCard
                  v-if="shouldTrackManagedAgentChanges(session)"
                  class="desktop-agent-detail-changes"
                  :summary="managedChangeSummary(session.id)"
                  :loading="isChangeSummaryLoading(session.id)"
                  :expanded="Boolean(expandedChangeSummaryIds[session.id])"
                  :retry-visible="Boolean(managedChangeSummary(session.id)?.error)"
                  @toggle-expanded="toggleExpandedChangeSummary(session.id)"
                  @retry="loadManagedAgentChangeSummary(session)"
                />
                <div
                  v-if="session.pendingPermissionRequests.length"
                  class="desktop-agent-detail-permissions"
                  data-testid="desktop-agent-detail-permissions"
                >
                  <article
                    v-for="request in session.pendingPermissionRequests"
                    :key="request.id"
                    class="desktop-agent-detail-permission"
                  >
                    <span>Permission request</span>
                    <strong>{{ request.title }}</strong>
                    <p>{{ permissionRequestSummary(request) }}</p>
                    <div class="desktop-agent-detail-permission-actions">
                      <button
                        type="button"
                        class="desktop-agent-detail-permission-allow"
                        :disabled="Boolean(resolvingPermissionIds[request.id])"
                        @click="resolveManagedPermission(request, 'allow')"
                      >
                        <ShieldCheck :size="14" aria-hidden="true" />
                        Allow
                      </button>
                      <button
                        type="button"
                        class="desktop-agent-detail-permission-deny"
                        :disabled="Boolean(resolvingPermissionIds[request.id])"
                        @click="resolveManagedPermission(request, 'deny')"
                      >
                        <Ban :size="14" aria-hidden="true" />
                        Deny
                      </button>
                    </div>
                  </article>
                </div>
                <div class="desktop-agent-detail-session-inspection">
                  <span>{{ inspectionStatusLabel(session.id) }}</span>
                  <button
                    type="button"
                    :disabled="Boolean(inspectingSessionIds[session.id])"
                    @click="inspectManagedSession(session.id)"
                  >
                    {{ inspectingSessionIds[session.id] ? "Refreshing..." : "Refresh transcript" }}
                  </button>
                </div>
                <ul
                  v-if="sessionRecentItems(session.id).length"
                  class="desktop-agent-detail-recent-items"
                  data-testid="desktop-agent-detail-recent-items"
                  aria-label="Public transcript preview"
                >
                  <li v-for="(item, index) in sessionRecentItems(session.id)" :key="`${session.id}-${index}`">
                    <span>{{ itemTypeLabel(item) }}</span>
                    <p>{{ itemText(item) }}</p>
                  </li>
                </ul>
              </article>
            </div>

            <div v-else class="desktop-agent-detail-empty">
              <strong>No local agent session matched this agent.</strong>
              <p>External agents still appear here through their published room activity.</p>
              <button type="button" @click="emit('open-add-agent')">Add agent</button>
            </div>

            <p v-if="stopStatusMessage" class="desktop-agent-detail-feedback">{{ stopStatusMessage }}</p>
            <p v-if="managedSessionError" class="desktop-agent-detail-error">{{ managedSessionError }}</p>
          </section>

          <section class="desktop-agent-detail-panel">
            <header>
              <span>Published reasoning</span>
              <button
                v-if="latestReasoning"
                type="button"
                @click="emit('open-reasoning', latestReasoning.id)"
              >
                Open stream
              </button>
            </header>

            <article v-if="latestReasoning" class="desktop-agent-detail-reasoning">
              <strong>{{ reasoningTitle(latestReasoning) }}</strong>
              <p>{{ reasoningSummary(latestReasoning) }}</p>
              <dl v-if="reasoningRows.length">
                <div v-for="row in reasoningRows" :key="row.label">
                  <dt>{{ row.label }}</dt>
                  <dd>{{ row.value }}</dd>
                </div>
              </dl>
              <small>{{ reasoningStatus(latestReasoning) }} - {{ formatTimestamp(latestReasoning.updatedAt || latestReasoning.createdAt) }}</small>
            </article>

            <div v-else class="desktop-agent-detail-empty">
              <strong>No published reasoning stream yet.</strong>
              <p>When this agent exposes readable progress, the latest summary appears here.</p>
            </div>
          </section>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Ban, Power, RefreshCw, ShieldCheck, Square, X } from "@lucide/vue";
import type {
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopManagedAgentPermissionRequest,
  DesktopManagedAgentSession,
  DesktopReasoningSession,
} from "../../../../../electron/ipc-types";
import {
  latestReasoningSessionForTarget,
  isIdleReasoningSession,
  reasoningFieldRows,
  reasoningStatus,
  reasoningSummary,
  reasoningTitle,
} from "../../../domain/reasoning";
import {
  isVisibleManagedAgentSession,
  canStopManagedAgentTurn,
  managedAgentSessionMatchesTarget,
  managedAgentSessionMatchesReasoning,
  managedAgentSessionDisplayName,
  managedAgentPermissionProfileLabel,
  managedAgentPermissionProfileSummary,
  managedAgentSessionStatusLabel,
  managedAgentStopResultNeedsAttention,
  managedAgentStopResultMessage,
} from "../../../domain/managed-agents";
import { formatShortDateTime } from "../../../domain/time";
import type { AgentModalTarget } from "./desktop-chat-message/types";
import ManagedAgentChangeSummaryCard from "./ManagedAgentChangeSummaryCard.vue";
import { desktopIpc } from "../../../ipc/index.js";
import {
  currentFocusableElement,
  restoreFocus,
  trapFocusInDialog,
} from "./modal-focus";

const props = defineProps<{
  open: boolean;
  roomIdentifier: string;
  target: AgentModalTarget | null;
  reasoningSessions: DesktopReasoningSession[];
}>();

const emit = defineEmits<{
  close: [];
  "open-add-agent": [];
  "open-reasoning": [sessionId: string];
}>();

const dialogElement = ref<HTMLElement | null>(null);
const managedSessions = ref<DesktopManagedAgentSession[]>([]);
const loadingManagedSessions = ref(false);
const stoppingSessionId = ref<string | null>(null);
const stoppingSessionMode = ref<"turn" | "worker" | null>(null);
const retryingSessionId = ref<string | null>(null);
const stopStatusMessage = ref<string | null>(null);
const managedSessionError = ref<string | null>(null);
const managedSessionInspections = ref<Record<string, DesktopManagedAgentInspectResult>>({});
const inspectingSessionIds = ref<Record<string, boolean>>({});
const managedChangeSummaries = ref<Record<string, DesktopManagedAgentChangeSummary | null>>({});
const loadingChangeSummaryIds = ref<Record<string, boolean>>({});
const expandedChangeSummaryIds = ref<Record<string, boolean>>({});
const resolvingPermissionIds = ref<Record<string, DesktopManagedAgentPermissionDecisionBehavior>>({});
let refreshTimer: number | null = null;
let modalStateVersion = 0;
let previousFocusElement: HTMLElement | null = null;

const titleId = computed(() =>
  `desktop-agent-detail-${sanitizeId(props.target?.actorLabel || props.target?.sender || "agent")}`
);

const identityLine = computed(() => {
  const target = props.target;
  if (!target) return "Agent";
  return [
    target.ownerAttribution,
    target.ideLabel,
    target.actorLabel && target.actorLabel !== target.sender ? target.actorLabel : null,
  ].filter(Boolean).join(" - ") || target.sender;
});

const latestReasoning = computed(() =>
  props.target ? latestReasoningSessionForTarget(props.target, props.reasoningSessions) : null
);

const reasoningRows = computed(() =>
  latestReasoning.value ? reasoningFieldRows(latestReasoning.value) : []
);

const matchingManagedSessions = computed(() => {
  const activeSessions = managedSessions.value.filter(isVisibleManagedAgentSession);
  if (!props.target) return [];

  const reasoningSession = latestReasoning.value;
  return activeSessions.filter((session) =>
    managedAgentSessionMatchesTarget(session, props.target!) ||
    managedAgentSessionMatchesReasoning(session, reasoningSession)
  );
});
const primaryManagedSession = computed(() =>
  matchingManagedSessions.value.find((session) => session.canStop) ?? matchingManagedSessions.value[0] ?? null
);
const isPrimaryAgentRunning = computed(() =>
  matchingManagedSessions.value.some((session) => session.status === "running" || session.status === "starting")
);
const latestReasoningIsIdle = computed(() => isIdleReasoningSession(latestReasoning.value));
const canStopPrimaryManagedSessionTurn = computed(() =>
  canStopManagedAgentTurn(primaryManagedSession.value) && !latestReasoningIsIdle.value
);
const stopTurnTitle = computed(() => {
  if (latestReasoningIsIdle.value) {
    return "No active turn to stop";
  }
  return isStoppingPrimarySession("turn") ? "Checking turn" : "Stop active turn";
});
const targetInspectionKey = computed(() => [
  props.target?.agentSessionId,
  props.target?.agentKey,
  props.target?.actorLabel,
  props.target?.displayName,
  props.target?.sender,
].filter(Boolean).join("|"));

watch(
  () => props.open,
  (open) => {
    if (!open) {
      resetTransientState();
      restoreFocus(previousFocusElement);
      previousFocusElement = null;
      return;
    }
    previousFocusElement = currentFocusableElement();
    modalStateVersion += 1;
    clearTransientState();
    void nextTick(() => dialogElement.value?.focus());
    void loadManagedSessions();
    startRefreshTimer();
  },
  { immediate: true },
);

watch(
  () => props.roomIdentifier,
  () => {
    if (props.open) {
      modalStateVersion += 1;
      clearTransientState();
      managedSessions.value = [];
      void loadManagedSessions();
    }
  },
);

watch(
  targetInspectionKey,
  () => {
    if (props.open) {
      modalStateVersion += 1;
      clearTransientState();
      void loadManagedSessions({ quiet: true, refreshChanges: true });
    }
  },
);

onBeforeUnmount(() => {
  stopRefreshTimer();
});

function startRefreshTimer(): void {
  stopRefreshTimer();
  refreshTimer = window.setInterval(() => {
    void loadManagedSessions({ quiet: true });
  }, 4_000);
}

function stopRefreshTimer(): void {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function clearTransientState(): void {
  loadingManagedSessions.value = false;
  stoppingSessionId.value = null;
  stoppingSessionMode.value = null;
  retryingSessionId.value = null;
  stopStatusMessage.value = null;
  managedSessionError.value = null;
  managedSessionInspections.value = {};
  inspectingSessionIds.value = {};
  managedChangeSummaries.value = {};
  loadingChangeSummaryIds.value = {};
  expandedChangeSummaryIds.value = {};
  resolvingPermissionIds.value = {};
}

function resetTransientState(): void {
  modalStateVersion += 1;
  stopRefreshTimer();
  clearTransientState();
  managedSessions.value = [];
}

function isCurrentModalState(version: number): boolean {
  return props.open && version === modalStateVersion;
}

function handleDialogTab(event: KeyboardEvent): void {
  trapFocusInDialog(event, dialogElement.value);
}

async function loadManagedSessions(options: { quiet?: boolean; refreshChanges?: boolean } = {}): Promise<void> {
  if (!props.open) return;
  const requestVersion = modalStateVersion;
  if (!options.quiet) {
    loadingManagedSessions.value = true;
  }
  managedSessionError.value = null;
  try {
    const sessions = await desktopIpc.workers.listManagedAgentSessions(props.roomIdentifier);
    if (!isCurrentModalState(requestVersion)) return;
    managedSessions.value = sessions;
    await refreshMatchingManagedSessionDetails({
      quiet: options.quiet,
      version: requestVersion,
      refreshChanges: options.refreshChanges ?? !options.quiet,
    });
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    managedSessionError.value = error instanceof Error ? error.message : "Could not load local agent sessions.";
  } finally {
    if (isCurrentModalState(requestVersion) && !options.quiet) {
      loadingManagedSessions.value = false;
    }
  }
}

async function refreshMatchingManagedSessionDetails(
  options: { quiet?: boolean; version?: number; refreshChanges?: boolean } = {},
): Promise<void> {
  const requestVersion = options.version ?? modalStateVersion;
  if (!isCurrentModalState(requestVersion)) return;
  await Promise.all(matchingManagedSessions.value.flatMap((session) => {
    const tasks: Array<Promise<void>> = [
      inspectManagedSession(session.id, { quiet: options.quiet, version: requestVersion }),
    ];
    if (options.refreshChanges) {
      tasks.push(loadManagedAgentChangeSummary(session, { version: requestVersion }));
    }
    return tasks;
  }));
}

async function inspectManagedSession(
  sessionId: string,
  options: { quiet?: boolean; version?: number } = {},
): Promise<void> {
  const requestVersion = options.version ?? modalStateVersion;
  if (!isCurrentModalState(requestVersion)) return;
  if (inspectingSessionIds.value[sessionId]) return;
  if (!options.quiet) {
    managedSessionError.value = null;
  }
  inspectingSessionIds.value = {
    ...inspectingSessionIds.value,
    [sessionId]: true,
  };
  try {
    const inspected = await desktopIpc.workers.inspectManagedAgent(sessionId, props.roomIdentifier);
    if (!isCurrentModalState(requestVersion)) return;
    if (!inspected) {
      return;
    }
    managedSessionInspections.value = {
      ...managedSessionInspections.value,
      [sessionId]: inspected,
    };
    managedSessions.value = [
      inspected.session,
      ...managedSessions.value.filter((session) => session.id !== inspected.session.id),
    ];
  } catch (error) {
    if (isCurrentModalState(requestVersion) && !options.quiet) {
      managedSessionError.value = error instanceof Error ? error.message : "Could not inspect this agent.";
    }
  } finally {
    if (!isCurrentModalState(requestVersion)) return;
    const { [sessionId]: _ignored, ...remaining } = inspectingSessionIds.value;
    inspectingSessionIds.value = remaining;
  }
}

async function loadManagedAgentChangeSummary(
  session: DesktopManagedAgentSession,
  options: { version?: number } = {},
): Promise<void> {
  const requestVersion = options.version ?? modalStateVersion;
  if (!isCurrentModalState(requestVersion) || !shouldTrackManagedAgentChanges(session)) return;
  if (loadingChangeSummaryIds.value[session.id]) return;
  loadingChangeSummaryIds.value = {
    ...loadingChangeSummaryIds.value,
    [session.id]: true,
  };
  try {
    const summary = await desktopIpc.workers.getManagedAgentChangeSummary(session.id, props.roomIdentifier);
    if (!isCurrentModalState(requestVersion)) return;
    managedChangeSummaries.value = {
      ...managedChangeSummaries.value,
      [session.id]: summary,
    };
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    managedChangeSummaries.value = {
      ...managedChangeSummaries.value,
      [session.id]: {
        sessionId: session.id,
        providerId: session.providerId,
        repoRootPath: session.repoRootPath,
        repoBranch: session.repoBranch,
        changedFileCount: 0,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        additions: 0,
        deletions: 0,
        files: [],
        hiddenFileCount: 0,
        isGitRepo: false,
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Could not inspect this agent's file changes.",
      },
    };
  } finally {
    if (!isCurrentModalState(requestVersion)) return;
    const { [session.id]: _ignored, ...remaining } = loadingChangeSummaryIds.value;
    loadingChangeSummaryIds.value = remaining;
  }
}

function isStoppingPrimarySession(mode: "turn" | "worker"): boolean {
  return Boolean(
    primaryManagedSession.value &&
    stoppingSessionId.value === primaryManagedSession.value.id &&
    stoppingSessionMode.value === mode
  );
}

async function stopManagedSession(sessionId: string, stopMode: "turn" | "worker"): Promise<void> {
  if (stoppingSessionId.value) return;
  if (stopMode === "turn" && primaryManagedSession.value?.id === sessionId && !canStopPrimaryManagedSessionTurn.value) {
    stopStatusMessage.value = "No current turn is running.";
    managedSessionError.value = null;
    return;
  }
  const requestVersion = modalStateVersion;
  stoppingSessionId.value = sessionId;
  stoppingSessionMode.value = stopMode;
  stopStatusMessage.value = stopMode === "worker"
    ? "Stopping local agent..."
    : "Checking current turn...";
  managedSessionError.value = null;
  try {
    const stopped = await desktopIpc.workers.stopManagedAgent({
      sessionId,
      stopMode,
    });
    if (!isCurrentModalState(requestVersion)) return;
    const stopResultMessage = stopped && managedAgentStopResultNeedsAttention(stopped)
      ? managedAgentStopResultMessage(stopped)
      : null;
    if (stopped) {
      managedSessions.value = [
        stopped,
        ...managedSessions.value.filter((session) => session.id !== stopped.id),
      ];
    }
    await loadManagedSessions({ quiet: true });
    if (stopResultMessage && !managedSessionError.value) {
      managedSessionError.value = stopResultMessage;
    }
    stopStatusMessage.value = stopMode === "worker"
      ? "Local agent stopped."
      : stopped?.status === "completed"
        ? "No current turn is running."
        : "Active turn stopped.";
  } catch (error) {
    if (!isCurrentModalState(requestVersion)) return;
    managedSessionError.value = error instanceof Error
      ? error.message
      : stopMode === "worker"
        ? "Could not stop this local agent."
        : "Could not stop this agent turn.";
    stopStatusMessage.value = null;
  } finally {
    if (isCurrentModalState(requestVersion)) {
      stoppingSessionId.value = null;
      stoppingSessionMode.value = null;
    }
  }
}

async function retryManagedSession(sessionId: string): Promise<void> {
  if (retryingSessionId.value) return;
  retryingSessionId.value = sessionId;
  managedSessionError.value = null;
  stopStatusMessage.value = "Retrying the failed room message...";
  try {
    const resumed = await desktopIpc.workers.retryManagedAgent({ sessionId });
    if (!resumed) {
      throw new Error("This failed message is no longer available to retry.");
    }
    managedSessions.value = [
      resumed,
      ...managedSessions.value.filter((session) => session.id !== resumed.id),
    ];
    stopStatusMessage.value = "Retry started.";
  } catch (error) {
    managedSessionError.value = error instanceof Error ? error.message : "Could not retry this message.";
    stopStatusMessage.value = null;
  } finally {
    retryingSessionId.value = null;
  }
}

async function resolveManagedPermission(
  request: DesktopManagedAgentPermissionRequest,
  behavior: DesktopManagedAgentPermissionDecisionBehavior,
): Promise<void> {
  if (resolvingPermissionIds.value[request.id]) return;
  resolvingPermissionIds.value = {
    ...resolvingPermissionIds.value,
    [request.id]: behavior,
  };
  managedSessionError.value = null;
  try {
    const result = await desktopIpc.workers.resolveManagedAgentPermission({
      requestId: request.id,
      sessionId: request.sessionId,
      behavior,
      message: behavior === "deny" ? "Denied from LetAgents Desktop." : null,
    });
    if (result.session) {
      managedSessions.value = [
        result.session,
        ...managedSessions.value.filter((session) => session.id !== result.session?.id),
      ];
    }
    stopStatusMessage.value = result.message;
  } catch (error) {
    managedSessionError.value = error instanceof Error
      ? error.message
      : "Could not resolve this permission request.";
  } finally {
    const { [request.id]: _ignored, ...remaining } = resolvingPermissionIds.value;
    resolvingPermissionIds.value = remaining;
  }
}

function inspectionStatusLabel(sessionId: string): string {
  if (stoppingSessionId.value === sessionId) {
    return stoppingSessionMode.value === "worker"
      ? "Stopping local agent"
      : "Checking current turn";
  }
  if (inspectingSessionIds.value[sessionId]) {
    return "Refreshing transcript preview";
  }
  const inspected = managedSessionInspections.value[sessionId];
  if (!inspected) {
    return "Transcript preview not loaded";
  }
  return inspected.serverReachable ? "Public transcript preview" : "App-server offline";
}

function sessionRecentItems(sessionId: string): Array<Record<string, unknown>> {
  return managedSessionInspections.value[sessionId]?.recentItems ?? [];
}

function itemTypeLabel(item: Record<string, unknown>): string {
  const type = String(item.type || "item");
  if (type === "agentMessage") return "Agent message";
  if (type === "userMessage") return "Room event";
  return type.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function itemText(item: Record<string, unknown>): string {
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (text) return text;
  const phase = typeof item.phase === "string" ? item.phase.trim() : "";
  return phase || "No text payload";
}

function permissionRequestSummary(request: DesktopManagedAgentPermissionRequest): string {
  return [
    request.toolName,
    request.inputSummary,
    request.description,
  ].filter(Boolean).join(" - ") || "Tool approval required.";
}

function shouldTrackManagedAgentChanges(session: DesktopManagedAgentSession): boolean {
  return session.providerId === "codex" && Boolean(session.repoRootPath.trim());
}

function managedChangeSummary(sessionId: string): DesktopManagedAgentChangeSummary | null {
  return managedChangeSummaries.value[sessionId] ?? null;
}

function isChangeSummaryLoading(sessionId: string): boolean {
  return Boolean(loadingChangeSummaryIds.value[sessionId]);
}

function toggleExpandedChangeSummary(sessionId: string): void {
  expandedChangeSummaryIds.value = {
    ...expandedChangeSummaryIds.value,
    [sessionId]: !expandedChangeSummaryIds.value[sessionId],
  };
}

function formatTimestamp(value: string | null | undefined): string {
  return formatShortDateTime(value) ?? "unknown";
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-") || "agent";
}
</script>
