<template>
  <aside
    ref="surfaceElement"
    class="agent-inspector-surface agent-inspector-participant-surface"
    :data-compact="compact"
    :data-kind="projection.kind"
    :role="compact ? 'dialog' : 'complementary'"
    :aria-modal="compact ? 'true' : undefined"
    aria-labelledby="agent-inspector-participant-title"
    @keydown="handleKeydown"
  >
    <header class="agent-inspector-header">
      <div class="agent-inspector-identity">
        <ProviderBadge
          v-if="projection.kind === 'local_managed'"
          :label="projection.session.providerId"
          :agent-key="projection.session.agentKey"
        />
        <div>
          <div class="agent-inspector-name-line">
            <h2 id="agent-inspector-participant-title">{{ projection.title }}</h2>
            <span v-if="projection.kind === 'local_managed'" class="agent-inspector-state-label" :data-state="sessionState">
              <span aria-hidden="true"></span>{{ projection.heading }}
            </span>
          </div>
          <p>{{ projection.eyebrow }}</p>
        </div>
      </div>
      <button ref="closeButton" type="button" class="agent-inspector-close" aria-label="Close agent inspector" @click="emit('close')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    </header>

    <div class="agent-inspector-status-copy">
      <strong>{{ projection.heading }}</strong>
      <p>{{ projection.detail }}</p>
    </div>

    <template v-if="projection.kind === 'local_managed'">
      <div class="agent-inspector-actions" aria-label="Local agent actions">
        <button type="button" :disabled="busy" data-testid="participant-inspector-refresh" @click="refreshSession">
          Refresh status
        </button>
        <button v-if="projection.canStopTurn" type="button" :disabled="busy" data-testid="participant-inspector-stop-turn" @click="stopSession('turn')">
          Stop turn
        </button>
        <button v-if="projection.canRetry" type="button" :disabled="busy" data-testid="participant-inspector-retry" @click="retrySession">
          Retry failed message
        </button>
        <button v-if="projection.canStopWorker" type="button" :disabled="busy" data-testid="participant-inspector-stop-worker" @click="stopSession('worker')">
          Stop local agent
        </button>
      </div>

      <div class="agent-inspector-scroll-region agent-inspector-participant-scroll">
        <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-participant-runtime-heading">
          <div class="agent-inspector-section-heading">
            <p id="agent-inspector-participant-runtime-heading">Runtime</p>
          </div>
          <dl class="agent-inspector-context-list">
            <div><dt>Provider</dt><dd>{{ projection.session.providerId }}{{ projection.session.model ? ` · ${projection.session.model}` : '' }}</dd></div>
            <div><dt>Room delivery</dt><dd>{{ deliveryLabel }}</dd></div>
            <div><dt>Current work</dt><dd>{{ projection.session.activeWork?.summary || 'None' }}</dd></div>
            <div><dt>Permissions</dt><dd><span>{{ permission.label }}</span><span>{{ permission.detail }}</span></dd></div>
          </dl>
        </section>

        <section v-if="tracksWorkingTree" class="agent-inspector-overview-section" aria-labelledby="agent-inspector-participant-changes-heading">
          <div class="agent-inspector-section-heading"><p id="agent-inspector-participant-changes-heading">Working tree</p></div>
          <ManagedAgentChangeSummaryCard
            :summary="changeSummary"
            :loading="changeSummaryLoading"
            :expanded="changeSummaryExpanded"
            :unavailable="changeSummaryUnavailable"
            :retry-visible="changeSummaryUnavailable"
            @toggle-expanded="changeSummaryExpanded = !changeSummaryExpanded"
            @retry="loadChangeSummary"
          />
        </section>

        <section v-if="projection.permissionRequests.length" class="agent-inspector-overview-section" aria-labelledby="agent-inspector-participant-permissions-heading">
          <div class="agent-inspector-section-heading"><p id="agent-inspector-participant-permissions-heading">Needs your approval</p></div>
          <article v-for="request in projection.permissionRequests" :key="request.id" class="agent-inspector-participant-permission">
            <strong>{{ request.title }}</strong>
            <p>{{ request.description || request.inputSummary || 'This action needs a decision before it can continue.' }}</p>
            <div class="agent-inspector-settings-actions">
              <button type="button" :disabled="busy" @click="resolvePermission(request.id, 'allow')">Allow</button>
              <button type="button" :disabled="busy" @click="resolvePermission(request.id, 'deny')">Deny</button>
            </div>
          </article>
        </section>

        <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-participant-transcript-heading">
          <div class="agent-inspector-section-heading">
            <p id="agent-inspector-participant-transcript-heading">Recent public activity</p>
            <button type="button" class="agent-inspector-inline-action" :disabled="busy || inspecting" @click="inspectSession">
              {{ inspecting ? 'Refreshing…' : 'Refresh' }}
            </button>
          </div>
          <p v-if="!inspection" class="agent-inspector-work-empty">Refresh to load this agent’s recent public transcript.</p>
          <p v-else-if="!inspection.serverReachable" class="agent-inspector-work-empty">The local runtime is not reachable right now.</p>
          <ul v-else-if="transcriptItems.length" class="agent-inspector-participant-transcript" aria-label="Recent public transcript">
            <li v-for="(item, index) in transcriptItems" :key="`${projection.session.id}-${index}`">{{ item }}</li>
          </ul>
          <p v-else class="agent-inspector-work-empty">No public transcript items are available yet.</p>
        </section>
        <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-participant-progress-heading">
          <div class="agent-inspector-section-heading">
            <p id="agent-inspector-participant-progress-heading">Published progress</p>
            <button v-if="reasoning" type="button" class="agent-inspector-inline-action" @click="emit('open-reasoning', reasoning.id)">Open stream</button>
          </div>
          <article v-if="reasoning" class="agent-inspector-participant-reasoning">
            <strong>{{ reasoningTitle(reasoning) }}</strong>
            <p>{{ reasoningSummary(reasoning) }}</p>
            <dl v-if="reasoningRows.length" class="agent-inspector-context-list">
              <div v-for="row in reasoningRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
            </dl>
            <small>{{ reasoningStatus(reasoning) }} · {{ reasoningTimestamp }}</small>
          </article>
          <p v-else class="agent-inspector-work-empty">No readable progress has been published for this participant.</p>
        </section>
        <p v-if="actionMessage" class="agent-inspector-action-message" :data-state="actionError ? 'error' : 'success'">{{ actionMessage }}</p>
      </div>
    </template>

    <div v-else class="agent-inspector-scroll-region agent-inspector-participant-scroll">
      <section class="agent-inspector-overview-section">
        <div class="agent-inspector-section-heading"><p>{{ projection.kind === 'unavailable' ? 'Identity' : 'Room participant' }}</p></div>
        <p class="agent-inspector-charter">
          {{ projection.kind === 'unavailable'
            ? 'This desktop will not expose controls until one exact local identity can be confirmed.'
            : 'This desktop has no authority to change this participant’s runtime, permissions, or work.' }}
        </p>
      </section>
      <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-external-progress-heading">
        <div class="agent-inspector-section-heading">
          <p id="agent-inspector-external-progress-heading">Published progress</p>
          <button v-if="reasoning" type="button" class="agent-inspector-inline-action" @click="emit('open-reasoning', reasoning.id)">Open stream</button>
        </div>
        <article v-if="reasoning" class="agent-inspector-participant-reasoning">
          <strong>{{ reasoningTitle(reasoning) }}</strong>
          <p>{{ reasoningSummary(reasoning) }}</p>
          <dl v-if="reasoningRows.length" class="agent-inspector-context-list">
            <div v-for="row in reasoningRows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
          </dl>
          <small>{{ reasoningStatus(reasoning) }} · {{ reasoningTimestamp }}</small>
        </article>
        <p v-else class="agent-inspector-work-empty">No readable progress has been published for this participant.</p>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopManagedAgentInspectResult,
  DesktopManagedAgentSession,
  DesktopReasoningSession,
} from "../../../../../../electron/ipc-types";
import {
  agentInspectorManagedSessionIdentity,
  agentInspectorParticipantInspection,
  agentInspectorParticipantPermissionLabel,
  agentInspectorTranscriptText,
  type AgentInspectorParticipantSessionUpdate,
  type AgentInspectorParticipantProjection,
} from "../../../../domain/agent-inspector-participant";
import { managedAgentSessionMatchesRoom } from "../../../../domain/managed-agents";
import {
  reasoningFieldRows,
  reasoningStatus,
  reasoningSummary,
  reasoningTitle,
} from "../../../../domain/reasoning";
import { formatShortDateTime } from "../../../../domain/time";
import ManagedAgentChangeSummaryCard from "../ManagedAgentChangeSummaryCard.vue";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import { desktopIpc } from "../../../../ipc/index.js";

const props = defineProps<{
  compact: boolean;
  projection: AgentInspectorParticipantProjection;
  roomIdentifier: string;
  requestVersion: number;
  selectionKey: string;
  reasoning: DesktopReasoningSession | null;
  busy?: boolean;
}>();
const emit = defineEmits<{
  close: [];
  status: [message: string];
  "session-updated": [update: AgentInspectorParticipantSessionUpdate];
  "open-reasoning": [sessionId: string];
}>();
const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const inspections = ref<Record<string, DesktopManagedAgentInspectResult>>({});
const activeOperation = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
const changeSummary = ref<DesktopManagedAgentChangeSummary | null>(null);
const changeSummaryLoading = ref(false);
const changeSummaryUnavailable = ref(false);
const changeSummaryExpanded = ref(false);
let lifecycleVersion = 0;
let nextOperationId = 0;
let changeSummaryOperationId: number | null = null;
let mounted = false;
const inspection = computed(() => props.projection.kind === "local_managed"
  ? agentInspectorParticipantInspection(inspections.value, props.projection.session.id)
  : null);
const transcriptItems = computed(() => inspection.value?.recentItems
  .map(agentInspectorTranscriptText)
  .filter((item): item is string => Boolean(item))
  .slice(-8) ?? []);
const reasoningRows = computed(() => props.reasoning ? reasoningFieldRows(props.reasoning) : []);
const reasoningTimestamp = computed(() =>
  formatShortDateTime(props.reasoning?.updatedAt || props.reasoning?.createdAt) || "time unavailable"
);
const permission = computed(() => props.projection.kind === "local_managed"
  ? agentInspectorParticipantPermissionLabel(props.projection.session)
  : { label: "", detail: "" });
const deliveryLabel = computed(() => props.projection.kind === "local_managed"
  ? props.projection.session.deliveryMode.replaceAll("_", " ")
  : "");
const sessionState = computed(() => {
  if (props.projection.kind !== "local_managed") return "disconnected";
  if (props.projection.session.status === "running") return "responding";
  if (props.projection.session.status === "starting") return "starting";
  if (props.projection.session.status === "blocked" || props.projection.session.status === "failed") return "needs_attention";
  return "listening";
});
const busy = computed(() => Boolean(props.busy || activeOperation.value));
const inspecting = computed(() => props.projection.kind === "local_managed" && activeOperation.value === `inspect:${props.projection.session.id}`);
const tracksWorkingTree = computed(() =>
  props.projection.kind === "local_managed"
  && ["codex", "open-model"].includes(props.projection.session.providerId)
  && Boolean(props.projection.session.repoRootPath.trim())
);
const actionFenceKey = computed(() => JSON.stringify([
  props.roomIdentifier,
  props.requestVersion,
  props.selectionKey,
  props.projection.kind === "local_managed"
    ? agentInspectorManagedSessionIdentity(props.projection.session)
    : props.projection.kind,
]));

watch(actionFenceKey, () => {
  invalidateActions();
  if (mounted && tracksWorkingTree.value) void loadChangeSummary();
});

onMounted(() => {
  mounted = true;
  if (tracksWorkingTree.value) void loadChangeSummary();
});

onBeforeUnmount(() => {
  mounted = false;
  lifecycleVersion += 1;
});

function invalidateActions(): void {
  lifecycleVersion += 1;
  activeOperation.value = null;
  actionMessage.value = null;
  actionError.value = false;
  inspections.value = {};
  changeSummary.value = null;
  changeSummaryLoading.value = false;
  changeSummaryUnavailable.value = false;
  changeSummaryExpanded.value = false;
  changeSummaryOperationId = null;
}

function focusInitial(): void { closeButton.value?.focus({ preventScroll: true }); }
function containsFocus(): boolean { return Boolean(surfaceElement.value?.contains(document.activeElement)); }
defineExpose({ focusInitial, containsFocus });

function handleKeydown(event: KeyboardEvent): void {
  if (!props.compact && event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (!props.compact || event.key !== "Tab" || !surfaceElement.value) return;
  const focusable = [...surfaceElement.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

interface ParticipantActionFence {
  lifecycleVersion: number;
  operationId: number;
  roomIdentifier: string;
  requestVersion: number;
  selectionKey: string;
  sessionId: string;
  sessionIdentity: string;
}

function captureFence(): ParticipantActionFence | null {
  if (
    !mounted
    || props.projection.kind !== "local_managed"
    || !managedAgentSessionMatchesRoom(props.projection.session, props.roomIdentifier)
  ) return null;
  return {
    lifecycleVersion,
    operationId: ++nextOperationId,
    roomIdentifier: props.roomIdentifier,
    requestVersion: props.requestVersion,
    selectionKey: props.selectionKey,
    sessionId: props.projection.session.id,
    sessionIdentity: agentInspectorManagedSessionIdentity(props.projection.session),
  };
}

function fenceIsCurrent(fence: ParticipantActionFence): boolean {
  return mounted
    && fence.lifecycleVersion === lifecycleVersion
    && props.roomIdentifier === fence.roomIdentifier
    && props.requestVersion === fence.requestVersion
    && props.selectionKey === fence.selectionKey
    && props.projection.kind === "local_managed"
    && managedAgentSessionMatchesRoom(props.projection.session, fence.roomIdentifier)
    && agentInspectorManagedSessionIdentity(props.projection.session) === fence.sessionIdentity;
}

function resultMatchesFence(
  session: DesktopManagedAgentSession,
  fence: ParticipantActionFence,
): boolean {
  return managedAgentSessionMatchesRoom(session, fence.roomIdentifier)
    && agentInspectorManagedSessionIdentity(session) === fence.sessionIdentity;
}

function emitSessionUpdate(session: DesktopManagedAgentSession, fence: ParticipantActionFence): boolean {
  if (!fenceIsCurrent(fence) || !resultMatchesFence(session, fence)) return false;
  emit("session-updated", {
    roomIdentifier: fence.roomIdentifier,
    inspectorRequestVersion: fence.requestVersion,
    selectionKey: fence.selectionKey,
    expectedSessionIdentity: fence.sessionIdentity,
    session,
  });
  return true;
}

async function runSessionAction(
  operation: string,
  execute: (fence: ParticipantActionFence) => Promise<boolean>,
  successMessage: string,
): Promise<void> {
  if (busy.value) return;
  const fence = captureFence();
  if (!fence) return;
  activeOperation.value = `${operation}:${fence.sessionId}`;
  actionMessage.value = null;
  actionError.value = false;
  emit("status", "Updating local agent status.");
  try {
    if (!fenceIsCurrent(fence) || !await execute(fence) || !fenceIsCurrent(fence)) return;
    actionMessage.value = successMessage;
    emit("status", successMessage);
  } catch (error) {
    if (!fenceIsCurrent(fence)) return;
    actionError.value = true;
    actionMessage.value = error instanceof Error ? error.message : "This local agent action could not be completed.";
    emit("status", actionMessage.value);
  } finally {
    if (fenceIsCurrent(fence) && activeOperation.value === `${operation}:${fence.sessionId}`) {
      activeOperation.value = null;
    }
  }
}

function refreshSession(): Promise<void> {
  return runSessionAction("refresh", inspectAndUpdateSession, "Agent status refreshed.");
}

function inspectSession(): Promise<void> {
  return runSessionAction("inspect", inspectAndUpdateSession, "Public transcript refreshed.");
}

async function inspectAndUpdateSession(fence: ParticipantActionFence): Promise<boolean> {
  if (!fenceIsCurrent(fence)) return false;
  const result = await desktopIpc.workers.inspectManagedAgent(fence.sessionId, fence.roomIdentifier);
  if (!fenceIsCurrent(fence)) return false;
  if (!result) throw new Error("The local agent session is no longer available.");
  if (!resultMatchesFence(result.session, fence)) {
    throw new Error("The local agent identity changed before the refresh completed.");
  }
  inspections.value = { ...inspections.value, [fence.sessionId]: result };
  return emitSessionUpdate(result.session, fence);
}

function stopSession(stopMode: "turn" | "worker"): Promise<void> {
  return runSessionAction(`stop_${stopMode}`, async (fence) => {
    if (!fenceIsCurrent(fence)) return false;
    const result = await desktopIpc.workers.stopManagedAgent({ sessionId: fence.sessionId, stopMode });
    if (!fenceIsCurrent(fence)) return false;
    if (!result) throw new Error(stopMode === "turn" ? "No active turn was stopped." : "The local agent could not be stopped.");
    if (!emitSessionUpdate(result, fence)) throw new Error("The local agent identity changed before the stop completed.");
    return true;
  }, stopMode === "turn" ? "Turn stopped." : "Local agent stopped.");
}

function retrySession(): Promise<void> {
  return runSessionAction("retry", async (fence) => {
    if (!fenceIsCurrent(fence)) return false;
    const result = await desktopIpc.workers.retryManagedAgent({ sessionId: fence.sessionId });
    if (!fenceIsCurrent(fence)) return false;
    if (!result) throw new Error("The failed message could not be retried.");
    if (!emitSessionUpdate(result, fence)) throw new Error("The local agent identity changed before the retry completed.");
    return true;
  }, "Retry started.");
}

function resolvePermission(requestId: string, behavior: DesktopManagedAgentPermissionDecisionBehavior): Promise<void> {
  return runSessionAction(`permission:${requestId}`, async (fence) => {
    if (
      !fenceIsCurrent(fence)
      || props.projection.kind !== "local_managed"
      || !props.projection.permissionRequests.some((request) => request.id === requestId)
    ) return false;
    const result = await desktopIpc.workers.resolveManagedAgentPermission({
      requestId,
      sessionId: fence.sessionId,
      behavior,
    });
    if (!fenceIsCurrent(fence)) return false;
    if (!result.accepted) throw new Error(result.message);
    if (result.session && !emitSessionUpdate(result.session, fence)) {
      throw new Error("The local agent identity changed before the permission response completed.");
    }
    return true;
  }, behavior === "allow" ? "Permission allowed." : "Permission denied.");
}

async function loadChangeSummary(): Promise<void> {
  if (!tracksWorkingTree.value || changeSummaryLoading.value) return;
  const fence = captureFence();
  if (!fence || !fenceIsCurrent(fence)) return;
  changeSummaryOperationId = fence.operationId;
  changeSummaryLoading.value = true;
  changeSummaryUnavailable.value = false;
  try {
    const summary = await desktopIpc.workers.getManagedAgentChangeSummary(
      fence.sessionId,
      fence.roomIdentifier,
    );
    if (!fenceIsCurrent(fence) || changeSummaryOperationId !== fence.operationId) return;
    if (!summary || summary.sessionId !== fence.sessionId) {
      changeSummary.value = null;
      changeSummaryUnavailable.value = true;
      return;
    }
    changeSummary.value = summary;
  } catch {
    if (!fenceIsCurrent(fence) || changeSummaryOperationId !== fence.operationId) return;
    changeSummary.value = null;
    changeSummaryUnavailable.value = true;
  } finally {
    if (fenceIsCurrent(fence) && changeSummaryOperationId === fence.operationId) {
      changeSummaryLoading.value = false;
      changeSummaryOperationId = null;
    }
  }
}
</script>
