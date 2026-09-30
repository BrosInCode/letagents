<template>
  <WakeRulesPanel
    v-if="context && agentKey"
    :key="agentKey"
    class="agent-inspector-waiting"
    :room-id="context.roomIdentifier.value"
    :rules="context.activeByAgentKey.value.get(agentKey) ?? []"
    :recent="context.recentByAgentKey.value.get(agentKey) ?? []"
    :api="context.api"
    @open-message="context.openMessage"
  />
</template>

<script setup lang="ts">
import WakeRulesPanel from "../../../../../../../../shared/ui/WakeRulesPanel.vue";
import { injectRoomWakeRules } from "../../../../composables/useRoomWakeRules";

defineProps<{ agentKey: string | null }>();
const context = injectRoomWakeRules();
</script>
