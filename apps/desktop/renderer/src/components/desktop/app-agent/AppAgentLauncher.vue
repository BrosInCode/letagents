<template>
  <div class="app-agent-launcher-wrap">
    <svg
      class="app-agent-liquid-glass-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <filter
        id="app-agent-launcher-liquid-glass"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        color-interpolation-filters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018 0.027"
          numOctaves="2"
          seed="17"
          result="texture"
        />
        <feGaussianBlur in="texture" stdDeviation="0.8" result="map" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="map"
          scale="38"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>

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
