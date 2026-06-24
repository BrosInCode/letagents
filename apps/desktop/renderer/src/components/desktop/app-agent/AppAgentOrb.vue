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
    @click="$emit('click', $event)"
    @pointerdown="$emit('pointerdown', $event)"
  >
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
  >
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
import { computed } from "vue";
import type { AppAgentSurfaceState } from "../../../domain/app-agent";

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
</script>
