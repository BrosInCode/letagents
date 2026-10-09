<template>
  <div class="agent-inspector-overview">
    <AgentInspectorDeliveryProgress v-if="projection.deliveryProgress?.requestedLocally" :progress="projection.deliveryProgress" />
    <AgentInspectorContinuationRecovery
      :entry-id="projection.entryId"
      :recovery="projection.continuationRecovery"
      :busy="busy"
      @restore="emit('restore-conversation', $event)"
      @skip="emit('skip-message', $event)"
    />
    <AgentInspectorWaiting :agent-key="projection.agentKey" />
    <details v-if="projection.turnControl" class="agent-inspector-correction" :open="projection.turnControl.status !== 'ready' || correctionRequest?.entryId === projection.entryId">
    <summary>{{ projection.turnControl.status === 'ready' ? 'Adjust this turn' : projection.turnControl.label }}</summary>
    <AgentInspectorTurnControl
      :entry-id="projection.entryId"
      :control="projection.turnControl"
      :busy="busy"
      :correction-request="correctionRequest"
      @stop="emit('stop-turn')"
      @correct="emit('correct-turn', $event)"
      @retry="emit('retry-turn-control')"
      @resolve="emit('resolve-turn-control', $event)"
    />
    </details>
    <section class="agent-inspector-overview-section agent-inspector-usage" aria-labelledby="agent-inspector-usage-title">
      <div class="agent-inspector-section-heading"><p id="agent-inspector-usage-title">Usage</p></div>
      <p class="agent-inspector-work-empty">Account limits aren’t reported by this connection.</p>
      <div class="agent-inspector-context-heading"><span>Context window</span><span>Not reported</span></div>
      <div class="agent-inspector-context-meter" :data-compacting="compacting" aria-hidden="true">
        <span v-for="bar in 48" :key="bar" :style="{ '--bar': bar }"></span>
      </div>
      <p v-if="compacting" class="agent-inspector-context-note">Compacting context…</p>
    </section>

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-context-title">
      <div class="agent-inspector-section-heading">
        <p id="agent-inspector-context-title">Room and work</p>
      </div>
      <dl class="agent-inspector-context-list">
        <div><dt>Current room</dt><dd>{{ roomName || friendlyRoomLabel(projection.roomId) }}</dd></div>
        <div>
          <dt>Assigned work</dt>
          <dd v-if="projection.assignedWork.length">
            <span v-for="task in projection.assignedWork" :key="task.id">{{ task.title }} · {{ task.status }}</span>
          </dd>
          <dd v-else>None</dd>
        </div>
      </dl>
    </section>
    <details class="agent-inspector-session-details">
      <summary>Session details</summary>
      <dl class="agent-inspector-context-list">
        <div>
          <dt>Agent app status</dt>
          <dd class="agent-inspector-provider-status" :data-state="runtimeControl?.state ?? 'unavailable'" :title="runtimeControl?.observedAt || undefined">
            <strong>{{ runtimeControl?.label ?? (runtimeControlPending ? "Checking agent app" : "Agent app status unavailable") }}</strong>
            <span>{{ runtimeControl?.detail ?? (runtimeControlPending ? "Checking whether the agent app is responding." : "The agent app has not been checked yet.") }}</span>
            <small :aria-hidden="!runtimeControl?.observedAt || undefined">{{ runtimeControl?.observedAt ? `Checked ${formatFullTimestamp(runtimeControl.observedAt)}` : "\u00a0" }}</small>
          </dd>
        </div>
      </dl>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { friendlyRoomLabel } from "../../../../domain/git-rooms";
import type { DesktopSupervisorAgentInspectorDetail } from "../../../../../../electron/ipc-types";
import type { AgentInspectorCorrectionRequest, AgentInspectorProjection } from "../../../../domain/agent-inspector";
import { describeAgentInspectorRuntimeControl } from "../../../../domain/agent-inspector-work";
import { formatFullTimestamp } from "../../../../domain/time";
import AgentInspectorDeliveryProgress from "./AgentInspectorDeliveryProgress.vue";
import { agentCompactionProgress } from "../../../../domain/managed-agents";
import AgentInspectorWaiting from "./AgentInspectorWaiting.vue";
import AgentInspectorContinuationRecovery from "./AgentInspectorContinuationRecovery.vue";
import AgentInspectorTurnControl from "./AgentInspectorTurnControl.vue";

const props = defineProps<{
  projection: AgentInspectorProjection;
  roomName?: string;
  busy: boolean;
  runtimeControl: DesktopSupervisorAgentInspectorDetail["runtime_control"] | null;
  runtimeControlPending: boolean;
  correctionRequest?: AgentInspectorCorrectionRequest | null;
}>();
const compacting = computed(() => props.projection.resourceFreshness === "fresh" && Boolean(agentCompactionProgress(props.projection.entry)));
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
