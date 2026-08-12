<template>
  <div class="agent-inspector-diagnostics">
    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-diagnostics-title">
      <div class="agent-inspector-section-heading">
        <p id="agent-inspector-diagnostics-title">Safe diagnostic snapshot</p>
        <button type="button" class="agent-inspector-diagnostics-copy" :disabled="copying" @click="copyReport">{{ copyLabel }}</button>
      </div>
      <p class="agent-inspector-settings-note">This is a bounded local report. Credentials, raw terminal records, and durable payload references are excluded.</p>
      <p v-if="copyState === 'failed'" class="agent-inspector-settings-error" role="status">Couldn’t copy the report. Clipboard access is unavailable.</p>
    </section>

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-diagnostics-runtime-title">
      <div class="agent-inspector-section-heading"><p id="agent-inspector-diagnostics-runtime-title">Runtime</p></div>
      <dl class="agent-inspector-context-list">
        <div v-for="item in runtimeFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
      </dl>
    </section>

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-diagnostics-recovery-title">
      <div class="agent-inspector-section-heading"><p id="agent-inspector-diagnostics-recovery-title">Recovery</p></div>
      <dl class="agent-inspector-context-list">
        <div v-for="item in recoveryFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
      </dl>
    </section>

    <section v-if="continuationRepairFacts.length" class="agent-inspector-overview-section" aria-labelledby="agent-inspector-diagnostics-continuation-title">
      <div class="agent-inspector-section-heading"><p id="agent-inspector-diagnostics-continuation-title">Conversation repair</p></div>
      <dl class="agent-inspector-context-list">
        <div v-for="item in continuationRepairFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
      </dl>
    </section>

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-diagnostics-events-title">
      <div class="agent-inspector-section-heading"><p id="agent-inspector-diagnostics-events-title">Recent runtime events</p><span>{{ diagnostics.activity.length }} retained</span></div>
      <p v-if="diagnostics.activityTruncated" class="agent-inspector-settings-note">Only the newest retained events are shown.</p>
      <ol v-if="diagnostics.activity.length" class="agent-inspector-diagnostics-events">
        <li v-for="event in diagnostics.activity" :key="`${event.sequence}:${event.observedAt}`">
          <div><strong>{{ event.summary || event.method || 'Runtime event' }}</strong><span>{{ event.observedAt }} · {{ event.provider }} · {{ event.status }}</span></div>
          <p>{{ event.kind }} · {{ event.method }}</p>
          <div v-if="event.payloadPreview" class="agent-inspector-diagnostics-payload"><span v-if="event.redacted || event.truncated">{{ event.redacted ? 'Redacted' : '' }}{{ event.redacted && event.truncated ? ' · ' : '' }}{{ event.truncated ? 'Truncated' : '' }}</span><pre>{{ event.payloadPreview }}</pre></div>
          <span v-else-if="event.redacted || event.truncated" class="agent-inspector-diagnostics-flags">{{ event.redacted ? 'Redacted' : '' }}{{ event.redacted && event.truncated ? ' · ' : '' }}{{ event.truncated ? 'Truncated' : '' }}</span>
        </li>
      </ol>
      <p v-else class="agent-inspector-settings-note">No recent runtime events are retained for this agent.</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { copyTextToClipboard } from "../../../../domain/clipboard";
import { agentInspectorDiagnosticsReport, projectAgentInspectorDiagnostics } from "../../../../domain/agent-inspector-diagnostics";
import type { AgentInspectorProjection } from "../../../../domain/agent-inspector";
import type { AgentInspectorWorkResource } from "../../../../domain/agent-inspector-work";

const props = defineProps<{ projection: AgentInspectorProjection; workResource: AgentInspectorWorkResource }>();
const copying = ref(false);
const copyState = ref<"idle" | "copied" | "failed">("idle");
const diagnostics = computed(() => projectAgentInspectorDiagnostics(props.projection));
const copyLabel = computed(() => copying.value ? "Copying…" : copyState.value === "copied" ? "Copied" : "Copy diagnostics");
const runtimeFacts = computed(() => [
  { label: "Entry", value: diagnostics.value.identity.entryId }, { label: "Room", value: diagnostics.value.identity.roomId },
  { label: "Provider", value: [diagnostics.value.identity.provider, diagnostics.value.identity.model].filter(Boolean).join(" · ") },
  { label: "Desired / observed", value: `${diagnostics.value.runtime.desiredState} / ${diagnostics.value.runtime.observedState}` },
  { label: "Binding", value: diagnostics.value.runtime.bindingState }, { label: "Provider process", value: diagnostics.value.runtime.providerPid === null ? "Not running" : String(diagnostics.value.runtime.providerPid) },
  { label: "Execution generation", value: diagnostics.value.runtime.executionGenerationId || "None" }, { label: "Restarts", value: String(diagnostics.value.runtime.restartCount) },
  { label: "Liveness", value: `${diagnostics.value.runtime.workplaceLiveness} / ${diagnostics.value.runtime.nativeLiveness}` },
]);
const recoveryFacts = computed(() => [
  { label: "Condition", value: diagnostics.value.recovery.condition }, { label: "Connection", value: diagnostics.value.recovery.connection || "Unavailable" },
  { label: "Observation", value: diagnostics.value.recovery.ingress || "Unavailable" }, { label: "Inbox", value: diagnostics.value.recovery.inbox || "Unavailable" },
  { label: "Turn", value: diagnostics.value.recovery.turn || "Unavailable" }, { label: "Turn recovery", value: diagnostics.value.recovery.turnControl || "None" },
  ...(diagnostics.value.recovery.lastError ? [{ label: "Latest error", value: diagnostics.value.recovery.lastError }] : []),
]);
const continuationRepairFacts = computed(() => {
  const repair = props.workResource.detail?.continuation_repair;
  if (!repair) return [];
  return [
    { label: "Phase", value: repair.phase },
    { label: "Repair", value: repair.repair_id },
    { label: "Inbox item", value: repair.inbox_item_id },
    { label: "Missing thread", value: repair.missing_continuation },
    { label: "Replacement thread", value: repair.replacement_continuation || "Not created" },
    { label: "Attempts", value: String(repair.attempt_count) },
    ...(repair.last_error ? [{ label: "Repair error", value: repair.last_error }] : []),
  ];
});
async function copyReport(): Promise<void> { copying.value = true; copyState.value = "idle"; copyState.value = await copyTextToClipboard(agentInspectorDiagnosticsReport(diagnostics.value)) ? "copied" : "failed"; copying.value = false; }
</script>
