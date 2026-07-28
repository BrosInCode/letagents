<template>
  <Transition name="agent-inspector-delivery-progress">
    <section
      v-if="progress"
      class="agent-inspector-delivery-progress"
      :data-phase="progress.phase"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="agent-inspector-delivery-progress-indicator" aria-hidden="true">
        <span></span>
      </span>
      <div>
        <p>Delivery</p>
        <strong>{{ progress.label }}</strong>
        <span>{{ progress.detail }}</span>
      </div>
    </section>
  </Transition>
</template>

<script setup lang="ts">
import type { AgentInspectorDeliveryProgressProjection } from "../../../../domain/agent-inspector";

defineProps<{ progress?: AgentInspectorDeliveryProgressProjection | null }>();
</script>
