<template>
  <section v-if="now" class="agent-inspector-now" :data-kind="now.kind" aria-labelledby="agent-inspector-now-title">
    <div class="agent-inspector-now-marker" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none">
        <path v-if="now.kind === 'progress'" d="M3 10.5 6.4 7l2.1 2.1L13 4.5" />
        <path v-else d="M8 3v6M8 12.2v.1" />
      </svg>
    </div>
    <div>
      <p id="agent-inspector-now-title">{{ now.label }}</p>
      <strong>{{ now.summary }}</strong>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AgentInspectorNowProjection } from "../../../../domain/agent-inspector";

defineProps<{ now: AgentInspectorNowProjection | null }>();
</script>
