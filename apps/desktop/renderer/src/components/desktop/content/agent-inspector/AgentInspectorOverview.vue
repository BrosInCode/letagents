<template>
  <div class="agent-inspector-overview">
    <AgentInspectorNow :now="projection.now" />
    <AgentInspectorReadinessRail :facts="projection.readiness" />

    <section class="agent-inspector-overview-section" aria-labelledby="agent-inspector-charter-title">
      <div class="agent-inspector-section-heading">
        <p id="agent-inspector-charter-title">Charter</p>
      </div>
      <p class="agent-inspector-charter">{{ projection.charter || "No charter has been set for this agent." }}</p>
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
import AgentInspectorNow from "./AgentInspectorNow.vue";
import AgentInspectorReadinessRail from "./AgentInspectorReadinessRail.vue";

defineProps<{ projection: AgentInspectorProjection }>();
</script>
