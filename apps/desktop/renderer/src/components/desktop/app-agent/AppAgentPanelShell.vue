<template>
  <section
    class="app-agent-panel"
    :data-state="surfaceState"
    data-testid="app-agent-panel"
  >
    <header class="app-agent-header" @pointerdown="$emit('drag-start', $event)">
      <AppAgentOrb
        :label="`${kicker}: ${statusLabel}`"
        root-class="app-agent-liquid-orb"
        :show-icon="false"
        :state="surfaceState"
        decorative
        variant="header"
      />
      <div class="app-agent-identity">
        <p>App Agent</p>
        <span>
          <strong>{{ kicker }}</strong>
          <small>{{ statusLabel }}</small>
        </span>
      </div>
      <button
        class="app-agent-icon-button"
        type="button"
        title="Close"
        aria-label="Close App Agent"
        @pointerdown.stop
        @click="$emit('close')"
      >
        <X aria-hidden="true" />
      </button>
    </header>
    <slot />
  </section>
</template>

<script setup lang="ts">
import { X } from "@lucide/vue";
import type { AppAgentSurfaceState } from "../../../domain/app-agent";
import AppAgentOrb from "./AppAgentOrb.vue";

defineProps<{
  kicker: string;
  statusLabel: string;
  surfaceState: AppAgentSurfaceState;
}>();

defineEmits<{
  close: [];
  "drag-start": [event: PointerEvent];
}>();
</script>
