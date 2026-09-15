<template>
  <div ref="rootElement" class="agent-inspector-diagnostics" :aria-busy="checking" :data-motion="motionEnabled" @pointerdown.capture="motionEnabled = true" @keydown.capture="motionEnabled = false">
    <header class="diagnostics-heading">
      <button v-if="selectedCheck" type="button" class="diagnostics-back" :disabled="busy || checking" @click="closeCheck"><ArrowLeft :size="14" aria-hidden="true" />All checks</button>
      <div v-else class="diagnostics-eyebrow"><Activity :size="14" aria-hidden="true" /> Agent health</div>
      <button type="button" class="diagnostics-refresh" :disabled="checking || busy || !refreshDiagnostics" @click="refresh()">
        <RefreshCw :size="14" :class="{ 'diagnostics-spinning': checking }" aria-hidden="true" />{{ checking ? 'Checking…' : 'Refresh checks' }}
      </button>
    </header>

    <section class="diagnostics-path" aria-label="Agent health checks">
      <div class="diagnostics-path-caption"><span>Connection checks</span><span>{{ assessment.passedCount }} / {{ assessment.checks.length }} clear</span></div>
      <div class="diagnostics-path-nodes">
        <button v-for="check in assessment.checks" :key="check.id" type="button" class="diagnostics-check" :data-state="check.state" :data-check="check.id" :aria-pressed="selectedId === check.id" :title="check.summary" :disabled="busy || checking" @click="openCheck(check.id)">
          <span class="diagnostics-check-icon"><component :is="checkIcons[check.id]" :size="19" aria-hidden="true" /></span>
          <strong>{{ check.label }}</strong>
          <span class="diagnostics-state" :data-state="check.state"><component :is="stateIcons[check.state]" :size="11" aria-hidden="true" />{{ stateLabels[check.state] }}</span>
        </button>
      </div>
    </section>

    <div v-if="!selectedCheck" class="diagnostics-overview diagnostics-view">
      <section class="diagnostics-intro" :data-state="assessment.state" aria-labelledby="diagnostics-headline">
        <span class="diagnostics-status-label"><component :is="stateIcons[assessment.state]" :size="15" aria-hidden="true" />{{ assessment.state === 'passed' ? 'Checks clear' : assessment.state === 'attention' ? 'Needs attention' : assessment.state === 'paused' ? 'On hold' : 'Current observation' }}</span>
        <h3 id="diagnostics-headline">{{ assessment.headline }}</h3>
        <p>{{ assessment.detail }}</p>
        <button v-if="assessment.state !== 'passed'" type="button" class="diagnostics-primary diagnostics-start" @click="openCheck(assessment.primaryCheckId)">
          {{ assessment.state === 'attention' ? 'Troubleshoot this issue' : 'Explore the next step' }}<ArrowRight :size="15" aria-hidden="true" />
        </button>
      </section>

      <button type="button" class="diagnostics-trace" @click="emit('navigate', 'work')">
        <span class="diagnostics-trace-icon"><Route :size="18" aria-hidden="true" /></span>
        <span><strong>Missing a reply?</strong><span>Trace a message from receipt to response.</span></span>
        <ArrowUpRight :size="16" aria-hidden="true" />
      </button>
    </div>

    <section v-else class="diagnostics-guide diagnostics-view" aria-labelledby="diagnostics-guide-title">
      <ol class="diagnostics-steps" aria-label="Troubleshooting progress">
        <li><span><Check :size="12" aria-hidden="true" /></span>Check</li>
        <li :aria-current="stage === 'resolve' ? 'step' : undefined" :data-complete="stage === 'verify'"><span><Check v-if="stage === 'verify'" :size="12" aria-hidden="true" /><template v-else>2</template></span>Resolve</li>
        <li :aria-current="stage === 'verify' ? 'step' : undefined" :data-complete="verification === 'passed'"><span><Check v-if="verification === 'passed'" :size="12" aria-hidden="true" /><template v-else>3</template></span>Verify</li>
      </ol>
      <div class="diagnostics-guide-heading"><component :is="checkIcons[selectedCheck.id]" :size="20" aria-hidden="true" /><h3 id="diagnostics-guide-title" ref="guideTitle" tabindex="-1">{{ selectedCheck.label }}</h3></div>
      <div class="diagnostics-finding" :data-state="selectedCheck.state">
        <div><component :is="stateIcons[selectedCheck.state]" :size="16" aria-hidden="true" /><strong>{{ selectedCheck.summary }}</strong></div>
        <p>{{ selectedCheck.detail }}</p>
        <time v-if="selectedCheck.observedAt" :datetime="selectedCheck.observedAt">Observed {{ formatFullTimestamp(selectedCheck.observedAt) }}</time>
      </div>
      <div v-if="stage === 'resolve'" key="resolve" class="diagnostics-step-content">
        <div class="diagnostics-next"><p class="diagnostics-eyebrow">Next step</p><p>{{ selectedCheck.nextStep }}</p></div>
        <p v-if="selectedCheck.id === 'delivery' && assessment.nextAttemptAt" class="diagnostics-retry-time"><Clock3 :size="14" aria-hidden="true" /> Retry scheduled for {{ formatFullTimestamp(assessment.nextAttemptAt) }}</p>
        <div v-if="selectedCheck.action" class="diagnostics-remedy">
          <p>{{ selectedCheck.actionImpact }}</p>
          <button type="button" class="diagnostics-primary" :disabled="busy || checking" @click="runRecovery"><Wrench :size="15" aria-hidden="true" />{{ selectedCheck.action.label }}<ArrowRight :size="15" aria-hidden="true" /></button>
        </div>
        <button v-if="selectedCheck.destination" type="button" class="diagnostics-secondary" @click="emit('navigate', selectedCheck.destination)">{{ selectedCheck.destination === 'work' ? 'Inspect message history' : 'Review turn controls' }}<ArrowUpRight :size="14" aria-hidden="true" /></button>
        <button type="button" class="diagnostics-secondary" :disabled="checking || busy || !refreshDiagnostics" @click="verify"><RefreshCw :size="14" aria-hidden="true" />{{ selectedCheck.action ? 'Check again' : 'Refresh and verify' }}</button>
      </div>
      <div v-else key="verify" class="diagnostics-step-content">
        <div class="diagnostics-next" role="status" aria-live="polite">
          <p class="diagnostics-eyebrow"><span v-if="verification === 'passed'" class="diagnostics-confirmation" aria-hidden="true"><Check :size="14" /></span>{{ busy ? 'Applying recovery' : recoveryError ? 'Recovery needs attention' : verification === 'passed' ? 'Check confirmed' : 'Verify the result' }}</p>
          <p>{{ verificationMessage }}</p>
        </div>
        <p v-if="recoveryError" class="diagnostics-error" role="alert">{{ recoveryError }}</p>
        <button v-if="verification === 'passed'" type="button" class="diagnostics-primary" @click="closeCheck">Back to all checks<ArrowRight :size="15" aria-hidden="true" /></button>
        <button v-else type="button" class="diagnostics-primary" :disabled="checking || busy || !refreshDiagnostics" @click="verify"><RefreshCw :size="15" :class="{ 'diagnostics-spinning': checking }" aria-hidden="true" />{{ checking ? 'Checking…' : 'Check again' }}</button>
        <button type="button" class="diagnostics-secondary" :disabled="checking || busy" @click="reviewCheck">{{ verification === 'passed' ? 'Review this check' : 'Back to recovery' }}</button>
      </div>
    </section>

    <p v-if="refreshMessage" class="diagnostics-refresh-result" :data-error="refreshFailed" role="status">{{ refreshMessage }}</p>

    <details class="diagnostics-technical">
      <summary><FileText :size="15" aria-hidden="true" /><span>Technical details<span>Runtime, retained errors, and recent events</span></span><ChevronRight :size="15" class="diagnostics-chevron" aria-hidden="true" /></summary>
      <div class="diagnostics-technical-content">
        <div class="diagnostics-report-heading"><span>Local diagnostic report</span><button type="button" class="agent-inspector-diagnostics-copy" :disabled="copying" @click="copyReport"><Copy :size="13" aria-hidden="true" />{{ copyLabel }}</button></div>
        <p class="diagnostics-footnote">Credentials and raw terminal records are excluded. Review the report before sharing it.</p>
        <p v-if="copyState === 'failed'" class="diagnostics-error" role="status">Couldn’t copy the report. Clipboard access is unavailable.</p>
        <dl class="diagnostics-facts"><div v-for="item in runtimeFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl>
        <div v-if="diagnostics.recovery.lastError" class="diagnostics-retained-error"><strong>Latest retained error</strong><p>{{ diagnostics.recovery.lastError }}</p></div>
        <div v-if="repairFacts.length"><h4>Conversation repair</h4><dl class="diagnostics-facts"><div v-for="item in repairFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl></div>
        <h4>Recent runtime events <span>{{ diagnostics.activity.length }} retained</span></h4>
        <p v-if="diagnostics.activityTruncated" class="diagnostics-footnote">Only the newest retained events are shown.</p>
        <ol v-if="diagnostics.activity.length" class="diagnostics-events">
          <li v-for="event in diagnostics.activity" :key="`${event.sequence}:${event.observedAt}`"><details>
            <summary><span><strong>{{ event.summary || event.method || 'Runtime event' }}</strong><time :datetime="event.observedAt">{{ formatFullTimestamp(event.observedAt) }}</time></span><ChevronRight :size="13" aria-hidden="true" /></summary>
            <p>{{ event.provider }} · {{ event.kind }} · {{ event.method }}</p>
            <span v-if="event.redacted || event.truncated" class="diagnostics-footnote">{{ event.redacted ? 'Redacted' : '' }}{{ event.redacted && event.truncated ? ' · ' : '' }}{{ event.truncated ? 'Truncated' : '' }}</span>
            <pre v-if="event.payloadPreview">{{ event.payloadPreview }}</pre>
          </details></li>
        </ol>
        <p v-else class="diagnostics-footnote">No runtime events are retained. This alone does not mean the agent is inactive.</p>
      </div>
    </details>
    <p class="diagnostics-footer"><ShieldCheck :size="13" aria-hidden="true" />Based on available observations. Recovery runs only when you choose it.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, Copy, Cpu, FileText, Inbox, Pause, Radio, RefreshCw, Route, Server, ShieldCheck, TriangleAlert, Wrench } from "@lucide/vue";
import type { DesktopSupervisorDaemonStatus } from "../../../../../../electron/ipc-types";
import { copyTextToClipboard } from "../../../../domain/clipboard";
import { agentInspectorDiagnosticsReport, projectAgentInspectorDiagnostics } from "../../../../domain/agent-inspector-diagnostics";
import { projectAgentTroubleshooting, safeDiagnosticText, type DiagnosticCheckId } from "../../../../domain/agent-inspector-troubleshooting";
import type { AgentInspectorActionIntent, AgentInspectorActionState, AgentInspectorProjection } from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";
import { formatFullTimestamp } from "../../../../domain/time";
import "./agent-inspector-diagnostics.css";

const props = defineProps<{
  projection: AgentInspectorProjection;
  workResource: AgentInspectorWorkResource;
  daemonStatus?: DesktopSupervisorDaemonStatus | null;
  actionState?: AgentInspectorActionState | null;
  busy?: boolean;
  refreshDiagnostics?: () => Promise<boolean>;
}>();
const emit = defineEmits<{ action: [intent: AgentInspectorActionIntent]; navigate: [tab: "overview" | "work"] }>();
const checkIcons = { service: Server, provider: Cpu, room: Radio, delivery: Inbox };
const stateIcons = { passed: Check, attention: TriangleAlert, pending: Clock3, unknown: CircleHelp, paused: Pause };
const stateLabels = { passed: "Clear", attention: "Attention", pending: "In progress", unknown: "Unknown", paused: "On hold" };
const assessment = computed(() => projectAgentTroubleshooting(props.projection, props.workResource, props.daemonStatus));
const diagnostics = computed(() => projectAgentInspectorDiagnostics(props.projection));
const selectedId = ref<DiagnosticCheckId | null>(null);
const selectedCheck = computed(() => assessment.value.checks.find(check => check.id === selectedId.value) ?? null);
const stage = ref<"resolve" | "verify">("resolve");
const verification = ref<"idle" | "passed" | "unresolved">("idle");
const guideTitle = ref<HTMLElement | null>(null);
const rootElement = ref<HTMLElement | null>(null);
const checking = ref(false);
const motionEnabled = ref(false);
const refreshMessage = ref("");
const refreshFailed = ref(false);
const recoveryRequested = ref(false);
let requestVersion = 0;
const recoveryError = computed(() => recoveryRequested.value && props.actionState?.status === "error" ? safeDiagnosticText(props.actionState.message) : null);
const verificationMessage = computed(() => props.busy ? "LetAgents is processing the request. Wait for it to finish before checking again."
  : recoveryError.value ? "LetAgents could not confirm this recovery request. Review the error below before trying again."
  : verification.value === "passed" && selectedCheck.value?.state === "passed" ? "A fresh observation confirms this check is clear. The other checks still describe their own part of the connection."
  : verification.value === "unresolved" && refreshFailed.value ? "Fresh verification is unavailable. The finding above may be from an earlier observation. Try again when the background service is reachable."
  : verification.value === "unresolved" ? "This check is not clear yet. The finding above shows the latest available state. Review the recovery guidance if it still needs attention."
  : "Refresh the observations to see whether this check recovered. An accepted request alone does not confirm the problem is resolved.");

async function focusGuide(): Promise<void> {
  await nextTick();
  rootElement.value?.parentElement?.scrollTo({ top: 0 });
  guideTitle.value?.focus({ preventScroll: true });
}
function openCheck(id: DiagnosticCheckId): void {
  refreshMessage.value = ""; refreshFailed.value = false;
  selectedId.value = id; stage.value = "resolve"; verification.value = "idle"; recoveryRequested.value = false;
  void focusGuide();
}
function closeCheck(): void {
  const id = selectedId.value;
  selectedId.value = null;
  void nextTick(() => rootElement.value?.querySelector<HTMLButtonElement>(`.diagnostics-check[data-check="${id}"]`)?.focus({ preventScroll: true }));
}
function reviewCheck(): void {
  stage.value = "resolve";
  void focusGuide();
}
function runRecovery(): void {
  const action = selectedCheck.value?.action;
  if (!action || props.busy || checking.value || props.projection.resourceFreshness !== "fresh") return;
  const current = props.projection.actions.find(candidate => candidate.available && candidate.kind === action.kind && candidate.sourceMessageId === action.sourceMessageId);
  if (!current) return;
  refreshMessage.value = ""; refreshFailed.value = false;
  recoveryRequested.value = true; stage.value = "verify"; verification.value = "idle";
  void focusGuide();
  emit("action", { entryId: props.projection.entryId, roomId: props.projection.roomId, kind: current.kind,
    ...(current.sourceMessageId ? { sourceMessageId: current.sourceMessageId } : {}) });
}
async function refresh(verifyResult = false): Promise<void> {
  if (!props.refreshDiagnostics || checking.value || props.busy) return;
  const version = ++requestVersion;
  checking.value = true; refreshMessage.value = ""; verification.value = "idle";
  try {
    const fresh = await props.refreshDiagnostics();
    if (version !== requestVersion) return;
    await nextTick();
    if (version !== requestVersion) return;
    refreshFailed.value = !fresh;
    refreshMessage.value = fresh ? "Checks refreshed from the latest available observations." : "Couldn’t confirm fresh checks. The available evidence is shown above.";
    if (verifyResult) {
      verification.value = fresh && selectedCheck.value?.state === "passed" ? "passed" : "unresolved";
      if (verification.value === "passed") recoveryRequested.value = false;
    }
  } catch {
    if (version !== requestVersion) return;
    refreshFailed.value = true; refreshMessage.value = "Couldn’t refresh checks. Try again when the background service is reachable.";
    if (verifyResult) verification.value = "unresolved";
  } finally { if (version === requestVersion) checking.value = false; }
}
async function verify(): Promise<void> {
  stage.value = "verify";
  await focusGuide();
  await refresh(true);
}
watch(() => selectedCheck.value?.state, state => {
  if (verification.value === "passed" && state !== "passed") {
    verification.value = "unresolved";
    refreshMessage.value = "The agent’s state changed after verification. Review the latest finding above.";
  }
});
watch([() => props.projection.entryId, () => props.projection.roomId], () => {
  requestVersion++; selectedId.value = null; checking.value = false; refreshMessage.value = "";
  verification.value = "idle"; recoveryRequested.value = false; copyState.value = "idle"; copying.value = false;
});
onBeforeUnmount(() => { requestVersion++; });

const runtimeFacts = computed(() => [
  { label: "Background service", value: props.daemonStatus ? `v${props.daemonStatus.implementationVersion} · PID ${props.daemonStatus.pid}` : "Unavailable" },
  { label: "Service started", value: formatFullTimestamp(props.daemonStatus?.startedAt) },
  { label: "Observation", value: props.projection.resourceFreshness === "fresh" ? "Current agent snapshot" : "Last known agent snapshot" },
  { label: "Agent", value: diagnostics.value.identity.entryId }, { label: "Room", value: diagnostics.value.identity.roomId },
  { label: "Desired / observed", value: `${diagnostics.value.runtime.desiredState} / ${diagnostics.value.runtime.observedState}` },
  { label: "Binding", value: diagnostics.value.runtime.bindingState },
  { label: "Provider process", value: diagnostics.value.runtime.providerPid === null ? "No local process ID reported" : String(diagnostics.value.runtime.providerPid) },
  { label: "Execution generation", value: diagnostics.value.runtime.executionGenerationId || "None" },
  { label: "Recorded restarts", value: String(diagnostics.value.runtime.restartCount) },
  { label: "Condition", value: diagnostics.value.recovery.condition },
]);
const repairFacts = computed(() => {
  const repair = props.workResource.detail?.entry_id === props.projection.entryId && props.workResource.detail.room_id === props.projection.roomId
    ? props.workResource.detail.continuation_repair : null;
  return repair ? [
    { label: "Phase", value: safeDiagnosticText(repair.phase) },
    { label: "Missing conversation", value: safeDiagnosticText(repair.missing_continuation) },
    { label: "Replacement", value: safeDiagnosticText(repair.replacement_continuation) || "Not created" },
    { label: "Attempts", value: String(repair.attempt_count) },
    ...(repair.last_error ? [{ label: "Repair error", value: safeDiagnosticText(repair.last_error) }] : []),
  ] : [];
});
const copying = ref(false);
const copyState = ref<"idle" | "copied" | "failed">("idle");
const copyLabel = computed(() => copying.value ? "Copying…" : copyState.value === "copied" ? "Copied" : "Copy report");
async function copyReport(): Promise<void> {
  const identity = `${props.projection.entryId}:${props.projection.roomId}`;
  copying.value = true; copyState.value = "idle";
  const copied = await copyTextToClipboard(agentInspectorDiagnosticsReport(diagnostics.value, {
    checks: assessment.value.checks.map(({ id, state, summary, detail, observedAt }) => ({ id, state, summary, detail, observedAt })),
    runtime: runtimeFacts.value, conversationRepair: repairFacts.value,
  }));
  if (identity !== `${props.projection.entryId}:${props.projection.roomId}`) return;
  copyState.value = copied ? "copied" : "failed";
  copying.value = false;
}
</script>
