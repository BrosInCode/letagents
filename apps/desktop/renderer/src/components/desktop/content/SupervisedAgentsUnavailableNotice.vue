<template>
  <p class="supervised-agents-unavailable" role="status" data-testid="supervised-agents-unavailable">
    <Bot class="supervised-agents-unavailable-icon" :size="16" aria-hidden="true" />
    <span>{{ message }}</span>
  </p>
</template>

<script setup lang="ts">
import { Bot } from "@lucide/vue";
import { supervisedAgentsUnavailableNotice } from "../../../domain/supervised-agents-support";

/** The one calm notice every agent entry point shows where this app cannot run agents. */
const message = supervisedAgentsUnavailableNotice();
</script>

<style scoped>
.supervised-agents-unavailable {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 0.86rem;
  line-height: 1.45;
}

.supervised-agents-unavailable-icon {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--text-tertiary);
}
</style>
