<template>
  <div class="agent-inspector-overview">
    <AgentInspectorDeliveryProgress :progress="projection.deliveryProgress" />
    <AgentInspectorContinuationRecovery
      :entry-id="projection.entryId"
      :recovery="projection.continuationRecovery"
      :busy="busy"
      @restore="emit('restore-conversation', $event)"
      @skip="emit('skip-message', $event)"
    />
    <AgentInspectorNow :now="projection.now" />
    <AgentInspectorTurnControl
      :entry-id="projection.entryId"
      :control="projection.turnControl"
      :busy="busy"
      @stop="emit('stop-turn')"
      @correct="emit('correct-turn', $event)"
      @retry="emit('retry-turn-control')"
      @resolve="emit('resolve-turn-control', $event)"
    />
    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-charter-title">
      <div class="agent-inspector-section-heading">
        <p id="agent-inspector-charter-title">Initial message</p>
      </div>
      <p class="agent-inspector-charter">{{ projection.charter || "No initial message was recorded for this agent." }}</p>
    </section>

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-context-title">
      <div class="agent-inspector-section-heading">
        <p id="agent-inspector-context-title">Room and work</p>
      </div>
      <dl class="agent-inspector-context-list">
        <div>
          <dt>Provider status</dt>
          <dd class="agent-inspector-provider-status" :data-state="runtimeControl?.state ?? 'unavailable'" :title="runtimeControl?.observedAt || undefined">
            <strong>{{ runtimeControl?.label ?? (runtimeControlPending ? "Checking provider" : "Provider status unavailable") }}</strong>
            <span>{{ runtimeControl?.detail ?? (runtimeControlPending ? "Waiting for a fresh provider check." : "No current provider check is available.") }}</span>
            <small :aria-hidden="!runtimeControl?.observedAt || undefined">{{ runtimeControl?.observedAt ? `Checked ${formatFullTimestamp(runtimeControl.observedAt)}` : "\u00a0" }}</small>
          </dd>
        </div>
        <div><dt>Current room</dt><dd>{{ projection.roomId }}</dd></div>
        <div>
          <dt>Assigned work</dt>
          <dd v-if="projection.assignedWork.length">
            <span v-for="task in projection.assignedWork" :key="task.id">{{ task.title }} · {{ task.status }}</span>
          </dd>
          <dd v-else>None</dd>
        </div>
        <div v-if="projection.recentOutcome">
          <dt>Recent outcome</dt>
          <dd>{{ projection.recentOutcome.label }}</dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopSupervisorAgentInspectorDetail } from "../../../../../../electron/ipc-types";
import type { AgentInspectorProjection } from "../../../../domain/agent-inspector";
import { describeAgentInspectorRuntimeControl } from "../../../../domain/agent-inspector-work";
import { formatFullTimestamp } from "../../../../domain/time";
import AgentInspectorDeliveryProgress from "./AgentInspectorDeliveryProgress.vue";
import AgentInspectorNow from "./AgentInspectorNow.vue";
import AgentInspectorContinuationRecovery from "./AgentInspectorContinuationRecovery.vue";
import AgentInspectorTurnControl from "./AgentInspectorTurnControl.vue";

const props = defineProps<{
  projection: AgentInspectorProjection;
  busy: boolean;
  runtimeControl: DesktopSupervisorAgentInspectorDetail["runtime_control"] | null;
  runtimeControlPending: boolean;
}>();
const runtimeControl = computed(() => describeAgentInspectorRuntimeControl(props.runtimeControl));
const emit = defineEmits<{
  "stop-turn": [];
  "correct-turn": [correction: string];
  "retry-turn-control": [];
  "resolve-turn-control": [resolution: "not_applied" | "applied"];
  "restore-conversation": [sourceMessageId: string];
  "skip-message": [sourceMessageId: string];
}>();
</script>
