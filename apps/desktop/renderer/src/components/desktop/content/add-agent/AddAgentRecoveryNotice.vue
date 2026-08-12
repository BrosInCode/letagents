<template>
  <aside
    class="desktop-add-agent-recovery-notice"
    data-testid="desktop-add-agent-recovery-notice"
    aria-labelledby="desktop-add-agent-recovery-title"
  >
    <span class="desktop-add-agent-recovery-glyph" aria-hidden="true">
      <History :size="17" :stroke-width="1.8" />
    </span>
    <div class="desktop-add-agent-recovery-copy">
      <span>Previous launch found</span>
      <strong id="desktop-add-agent-recovery-title">
        A previous {{ providerName }} agent is available to recover
      </strong>
      <p>
        Recovering shows its latest progress here; it does not start another agent.
      </p>
    </div>
    <span class="desktop-add-agent-recovery-state">Available</span>
  </aside>
</template>

<script setup lang="ts">
import { History } from "@lucide/vue";

defineProps<{ providerName: string }>();
</script>

<style scoped src="./AddAgentRecoveryNotice.css"></style>
