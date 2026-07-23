<template>
  <section class="agent-inspector-readiness" aria-labelledby="agent-inspector-readiness-title">
    <div class="agent-inspector-section-heading">
      <p id="agent-inspector-readiness-title">Readiness</p>
      <span>Live facts</span>
    </div>
    <ol class="agent-inspector-readiness-rail">
      <li
        v-for="fact in facts"
        :key="fact.key"
        :data-tone="fact.tone"
      >
        <span class="agent-inspector-rail-marker" aria-hidden="true">
          <svg viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="4.25" />
            <path v-if="fact.tone === 'ready'" d="m3.7 6.1 1.5 1.5 3.2-3.2" />
            <path v-else-if="fact.tone === 'active'" d="M4 6h4M6 4v4" />
            <path v-else-if="fact.tone === 'blocked'" d="M4.2 4.2 7.8 7.8M7.8 4.2 4.2 7.8" />
          </svg>
        </span>
        <div>
          <span>{{ fact.label }}</span>
          <strong>{{ fact.value }}</strong>
          <small v-if="fact.detail">{{ fact.detail }}</small>
        </div>
      </li>
    </ol>
  </section>
</template>

<script setup lang="ts">
import type { AgentInspectorReadinessFact } from "../../../../domain/agent-inspector";

defineProps<{ facts: readonly AgentInspectorReadinessFact[] }>();
</script>
