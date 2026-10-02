<template>
  <!-- Always mounted so the live region exists before a chip is announced. -->
  <TransitionGroup
    name="desktop-presence-chip"
    tag="div"
    class="desktop-presence-chips"
    role="status"
    aria-atomic="false"
    aria-relevant="additions"
    data-testid="desktop-presence-chips"
  >
    <div
      v-for="chip in chips"
      :key="chip.id"
      class="desktop-presence-chip"
      :data-kind="chip.kind"
    >
      <ProviderBadge v-if="chip.ideLabel" :label="chip.ideLabel" :agent-key="chip.agentKey" />
      <span v-else class="desktop-presence-chip-dot" aria-hidden="true"></span>
      <span class="desktop-presence-chip-copy">
        <strong>{{ chip.displayName }}</strong>
        {{ chip.kind === "connected" ? "connected" : "disconnected" }}
      </span>
    </div>
  </TransitionGroup>
</template>

<script setup lang="ts">
import type { PresenceChip } from "../../../../domain/presence-chips";
import ProviderBadge from "../desktop-chat-message/ProviderBadge.vue";

defineProps<{ chips: PresenceChip[] }>();
</script>
