<template>
  <div class="app-agent-launcher-wrap">
    <AppAgentOrb
      label="Open App Agent"
      root-class="app-agent-launcher"
      variant="launcher"
      :interactive="true"
      :show-icon="false"
      :state="surfaceState"
      data-testid="app-agent-launcher"
      @click="$emit('open')"
      @pointerdown="$emit('drag-start', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import type { AppAgentSurfaceState } from "../../../domain/app-agent";
import AppAgentOrb from "./AppAgentOrb.vue";

defineProps<{
  surfaceState: AppAgentSurfaceState;
}>();

defineEmits<{
  open: [];
  "drag-start": [event: PointerEvent];
}>();
</script>
