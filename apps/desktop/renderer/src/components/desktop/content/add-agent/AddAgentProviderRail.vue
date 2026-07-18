<template>
  <section class="desktop-add-agent-providers" aria-label="Agent providers">
    <span class="desktop-add-agent-providers-label">Provider</span>
    <button
      v-for="provider in providers"
      :key="provider.id"
      class="desktop-add-agent-provider"
      type="button"
      :data-selected="provider.id === selectedProviderId"
      :aria-pressed="provider.id === selectedProviderId"
      :data-testid="`desktop-add-agent-provider-${provider.id}`"
      @click="emit('select', provider.id)"
    >
      <span class="desktop-add-agent-provider-icon" aria-hidden="true">
        <McpHarnessIcon :target-id="provider.mcpTargetId" />
      </span>
      <span>
        <strong>{{ provider.name }}</strong>
        <small>{{ provider.description }}</small>
      </span>
    </button>
  </section>
</template>

<script setup lang="ts">
import type { DesktopAgentProvider, DesktopAgentProviderId } from "../../../../../../electron/ipc-types";
import McpHarnessIcon from "../../setup/McpHarnessIcon.vue";

defineProps<{
  providers: DesktopAgentProvider[];
  selectedProviderId: DesktopAgentProviderId | null;
}>();
const emit = defineEmits<{ select: [providerId: DesktopAgentProviderId] }>();
</script>
<style scoped src="./AddAgentProviderRail.css"></style>
