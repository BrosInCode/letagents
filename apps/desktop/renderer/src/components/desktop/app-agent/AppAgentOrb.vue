<template>
  <button
    v-if="interactive"
    :class="['app-agent-orb', `app-agent-orb--${variant}`, rootClass]"
    :data-state="state"
    :data-show-label="showLabel"
    :data-testid="dataTestid"
    :disabled="disabled"
    :title="label"
    :aria-label="label"
    :type="buttonType"
    :style="orbStyle"
    @click="$emit('click', $event)"
    @pointerdown="$emit('pointerdown', $event)"
  >
    <svg
      class="app-agent-liquid-glass-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <filter
        :id="filterId"
        x="-24%"
        y="-24%"
        width="148%"
        height="148%"
        color-interpolation-filters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018 0.032"
          numOctaves="2"
          :seed="filterSeed"
          result="grain"
        />
        <feColorMatrix
          in="grain"
          type="matrix"
          values="1.18 0 0 0 -0.09  0 1.08 0 0 -0.04  0 0 0.92 0 0.02  0 0 0 1 0"
          result="map"
        />
        <feGaussianBlur in="map" stdDeviation="0.62" result="softMap" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softMap"
          scale="24"
          xChannelSelector="R"
          yChannelSelector="G"
          result="refracted"
        />
        <feColorMatrix in="refracted" type="saturate" values="1.12" />
      </filter>
    </svg>
    <span class="app-agent-orb-atmosphere" aria-hidden="true"></span>
    <span class="app-agent-orb-halo" aria-hidden="true"></span>
    <span class="app-agent-orb-dust" aria-hidden="true"></span>
    <span class="app-agent-orb-lens" aria-hidden="true">
      <span class="app-agent-orb-sheen" aria-hidden="true"></span>
      <component v-if="showIcon" :is="orbIcon" />
    </span>
    <span v-if="showLabel" class="app-agent-orb-label">{{ displayLabel || label }}</span>
  </button>

  <span
    v-else
    :class="['app-agent-orb', `app-agent-orb--${variant}`, rootClass]"
    :data-state="state"
    :data-show-label="showLabel"
    :aria-hidden="decorative ? 'true' : undefined"
    :aria-label="decorative ? undefined : label"
    :title="label"
    :style="orbStyle"
  >
    <svg
      class="app-agent-liquid-glass-defs"
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
    >
      <filter
        :id="filterId"
        x="-24%"
        y="-24%"
        width="148%"
        height="148%"
        color-interpolation-filters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018 0.032"
          numOctaves="2"
          :seed="filterSeed"
          result="grain"
        />
        <feColorMatrix
          in="grain"
          type="matrix"
          values="1.18 0 0 0 -0.09  0 1.08 0 0 -0.04  0 0 0.92 0 0.02  0 0 0 1 0"
          result="map"
        />
        <feGaussianBlur in="map" stdDeviation="0.62" result="softMap" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softMap"
          scale="24"
          xChannelSelector="R"
          yChannelSelector="G"
          result="refracted"
        />
        <feColorMatrix in="refracted" type="saturate" values="1.12" />
      </filter>
    </svg>
    <span class="app-agent-orb-atmosphere" aria-hidden="true"></span>
    <span class="app-agent-orb-halo" aria-hidden="true"></span>
    <span class="app-agent-orb-dust" aria-hidden="true"></span>
    <span class="app-agent-orb-lens" aria-hidden="true">
      <span class="app-agent-orb-sheen" aria-hidden="true"></span>
      <component v-if="showIcon" :is="orbIcon" />
    </span>
    <span v-if="showLabel" class="app-agent-orb-label">{{ displayLabel || label }}</span>
  </span>
</template>

<script setup lang="ts">
import {
  AlertTriangle,
  Check,
  LoaderCircle,
  Sparkles,
  X,
} from "@lucide/vue";
import { computed, type StyleValue } from "vue";
import type { AppAgentSurfaceState } from "../../../domain/app-agent";

let nextFilterId = 0;

const props = withDefaults(defineProps<{
  buttonType?: "button" | "submit";
  dataTestid?: string;
  decorative?: boolean;
  disabled?: boolean;
  displayLabel?: string;
  interactive?: boolean;
  label: string;
  rootClass?: string;
  showIcon?: boolean;
  showLabel?: boolean;
  state: AppAgentSurfaceState;
  variant?: "launcher" | "header" | "submit" | "live";
}>(), {
  buttonType: "button",
  dataTestid: undefined,
  decorative: false,
  disabled: false,
  displayLabel: undefined,
  interactive: false,
  rootClass: "",
  showIcon: true,
  showLabel: false,
  variant: "live",
});

defineEmits<{
  click: [event: MouseEvent];
  pointerdown: [event: PointerEvent];
}>();

const orbIcon = computed(() => {
  if (props.state === "running") return LoaderCircle;
  if (props.state === "success") return Check;
  if (props.state === "confirmation" || props.state === "configuration") return AlertTriangle;
  if (props.state === "error") return X;
  return Sparkles;
});

const filterId = `app-agent-liquid-glass-${++nextFilterId}`;
const filterSeed = computed(() => {
  if (props.variant === "launcher") return 17;
  if (props.variant === "header") return 23;
  if (props.variant === "live") return 31;
  return 29;
});
const orbStyle = computed<StyleValue>(() => ({
  "--app-agent-glass-filter": `url("#${filterId}")`,
}));
</script>
