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
    <AgentInspectorReadinessRail :facts="projection.readiness" />

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
import type { AgentInspectorProjection } from "../../../../domain/agent-inspector";
import AgentInspectorDeliveryProgress from "./AgentInspectorDeliveryProgress.vue";
import AgentInspectorNow from "./AgentInspectorNow.vue";
import AgentInspectorContinuationRecovery from "./AgentInspectorContinuationRecovery.vue";
import AgentInspectorReadinessRail from "./AgentInspectorReadinessRail.vue";
import AgentInspectorTurnControl from "./AgentInspectorTurnControl.vue";

defineProps<{ projection: AgentInspectorProjection; busy: boolean }>();
const emit = defineEmits<{
  "stop-turn": [];
  "correct-turn": [correction: string];
  "retry-turn-control": [];
  "resolve-turn-control": [resolution: "not_applied" | "applied"];
  "restore-conversation": [sourceMessageId: string];
  "skip-message": [sourceMessageId: string];
}>();
</script>
