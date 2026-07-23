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
        <p v-if="actionMessage" class="agent-inspector-action-message" :data-state="actionError ? 'error' : 'success'">{{ actionMessage }}</p>
      </div>
    </template>

    <div v-else class="agent-inspector-scroll-region agent-inspector-participant-scroll">
      <section class="agent-inspector-overview-section">
        <div class="agent-inspector-section-heading"><p>Room participant</p></div>
        <p class="agent-inspector-charter">You can read this participant’s published room activity, but this desktop has no authority to change its runtime, permissions, or work.</p>
      </section>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { DesktopManagedAgentPermissionDecisionBehavior, DesktopManagedAgentInspectResult } from "../../../../../../electron/ipc-types";
import {
  agentInspectorParticipantInspection,
  agentInspectorParticipantPermissionLabel,
  agentInspectorTranscriptText,
  type AgentInspectorParticipantProjection,
} from "../../../../domain/agent-inspector-participant";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";
import { desktopIpc } from "../../../../ipc/index.js";
import { useManagedAgentSessionsContext } from "../add-agent/managed-agent-sessions-context";

const props = defineProps<{
  compact: boolean;
  projection: AgentInspectorParticipantProjection;
  busy?: boolean;
}>();
const emit = defineEmits<{ close: []; status: [message: string] }>();
const surfaceElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const managedSessionsContext = useManagedAgentSessionsContext();
const inspections = ref<Record<string, DesktopManagedAgentInspectResult>>({});
const activeOperation = ref<string | null>(null);
const actionMessage = ref<string | null>(null);
const actionError = ref(false);
let operationVersion = 0;
const inspection = computed(() => props.projection.kind === "local_managed"
  ? agentInspectorParticipantInspection(inspections.value, props.projection.session.id)
  : null);
const transcriptItems = computed(() => inspection.value?.recentItems
  .map(agentInspectorTranscriptText)
  .filter((item): item is string => Boolean(item))
  .slice(-8) ?? []);
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

watch(() => props.projection.kind === "local_managed" ? props.projection.session.id : null, () => {
  operationVersion += 1;
  activeOperation.value = null;
  actionMessage.value = null;
  actionError.value = false;
});

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

function currentSessionId(): string | null {
  return props.projection.kind === "local_managed" ? props.projection.session.id : null;
}

async function runSessionAction(
  operation: string,
  execute: (sessionId: string) => Promise<void>,
  successMessage: string,
): Promise<void> {
  const sessionId = currentSessionId();
  if (!sessionId || busy.value) return;
  const version = ++operationVersion;
  activeOperation.value = `${operation}:${sessionId}`;
  actionMessage.value = null;
  actionError.value = false;
  emit("status", "Updating local agent status.");
  try {
    await execute(sessionId);
    if (version !== operationVersion || currentSessionId() !== sessionId) return;
    actionMessage.value = successMessage;
    emit("status", successMessage);
  } catch (error) {
    if (version !== operationVersion || currentSessionId() !== sessionId) return;
    actionError.value = true;
    actionMessage.value = error instanceof Error ? error.message : "This local agent action could not be completed.";
    emit("status", actionMessage.value);
  } finally {
    if (version === operationVersion && currentSessionId() === sessionId) activeOperation.value = null;
  }
}

function refreshSession(): Promise<void> {
  return runSessionAction("refresh", async () => { await managedSessionsContext.refresh(); }, "Agent status refreshed.");
}

function inspectSession(): Promise<void> {
  return runSessionAction("inspect", async (sessionId) => {
    const result = await desktopIpc.workers.inspectManagedAgent(sessionId, props.projection.kind === "local_managed" ? props.projection.session.roomIdentifier : null);
    if (!result) throw new Error("The local agent session is no longer available.");
    inspections.value = { ...inspections.value, [sessionId]: result };
    managedSessionsContext.upsert(result.session);
  }, "Public transcript refreshed.");
}

function stopSession(stopMode: "turn" | "worker"): Promise<void> {
  return runSessionAction(`stop_${stopMode}`, async (sessionId) => {
    const result = await desktopIpc.workers.stopManagedAgent({ sessionId, stopMode });
    if (result) managedSessionsContext.upsert(result);
  }, stopMode === "turn" ? "Turn stopped." : "Local agent stopped.");
}

function retrySession(): Promise<void> {
  return runSessionAction("retry", async (sessionId) => {
    const result = await desktopIpc.workers.retryManagedAgent({ sessionId });
    if (result) managedSessionsContext.upsert(result);
  }, "Retry started.");
}

function resolvePermission(requestId: string, behavior: DesktopManagedAgentPermissionDecisionBehavior): Promise<void> {
  return runSessionAction(`permission:${requestId}`, async (sessionId) => {
    const result = await desktopIpc.workers.resolveManagedAgentPermission({ requestId, sessionId, behavior });
    if (result.session) managedSessionsContext.upsert(result.session);
    if (!result.accepted) throw new Error(result.message);
  }, behavior === "allow" ? "Permission allowed." : "Permission denied.");
}
</script>
