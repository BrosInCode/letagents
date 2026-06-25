<template>
  <span
    class="desktop-status-indicator"
    :data-tone="tone"
    :data-pulse="pulse"
    :data-mode="mode"
    :aria-label="ariaLabel"
    :title="ariaLabel"
  >
    <span class="desktop-status-indicator-dot" aria-hidden="true"></span>
    <span v-if="showCount" class="desktop-status-indicator-count">{{ countLabel }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    label: string;
    count?: number | null;
    tone?: "info" | "success" | "warning" | "danger";
    pulse?: boolean;
    mode?: "dot" | "count";
  }>(),
  {
    count: null,
    tone: "info",
    pulse: false,
    mode: "dot",
  },
);

const countLabel = computed(() => {
  if (typeof props.count !== "number" || props.count <= 0) return "";
  return props.count > 99 ? "99+" : String(props.count);
});

const showCount = computed(() => props.mode === "count" && countLabel.value.length > 0);

const ariaLabel = computed(() => {
  if (!countLabel.value) return props.label;
  return `${props.label}: ${countLabel.value}`;
});
</script>

<style scoped>
.desktop-status-indicator {
  --desktop-status-indicator-color: #8ec7ff;
  --desktop-status-indicator-fill: rgba(142, 199, 255, 0.18);
  --desktop-status-indicator-ring: rgba(142, 199, 255, 0.14);

  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 8px;
  min-height: 8px;
}

.desktop-status-indicator[data-tone="success"] {
  --desktop-status-indicator-color: #73d49d;
  --desktop-status-indicator-fill: rgba(115, 212, 157, 0.18);
  --desktop-status-indicator-ring: rgba(115, 212, 157, 0.14);
}

.desktop-status-indicator[data-tone="warning"] {
  --desktop-status-indicator-color: #ffbd75;
  --desktop-status-indicator-fill: rgba(255, 189, 117, 0.18);
  --desktop-status-indicator-ring: rgba(255, 189, 117, 0.14);
}

.desktop-status-indicator[data-tone="danger"] {
  --desktop-status-indicator-color: #ff9ea3;
  --desktop-status-indicator-fill: rgba(255, 158, 163, 0.18);
  --desktop-status-indicator-ring: rgba(255, 158, 163, 0.14);
}

.desktop-status-indicator-dot {
  position: relative;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--desktop-status-indicator-color);
  box-shadow: 0 0 0 3px var(--desktop-status-indicator-ring);
}

.desktop-status-indicator[data-pulse="true"] .desktop-status-indicator-dot::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--desktop-status-indicator-color);
  content: "";
  opacity: 0.24;
  animation: desktop-status-indicator-pulse 1.7s var(--ease-out) infinite;
}

.desktop-status-indicator-count {
  min-width: 18px;
  border-radius: 999px;
  padding: 2px 6px;
  background: var(--desktop-status-indicator-fill);
  color: var(--desktop-status-indicator-color);
  font-size: 0.66rem;
  font-weight: 820;
  line-height: 1;
  text-align: center;
}

.desktop-status-indicator[data-mode="count"] .desktop-status-indicator-dot {
  display: none;
}

@keyframes desktop-status-indicator-pulse {
  from {
    opacity: 0.26;
    transform: scale(1);
  }

  to {
    opacity: 0;
    transform: scale(2.6);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-status-indicator-dot::after {
    animation: none;
  }
}
</style>
