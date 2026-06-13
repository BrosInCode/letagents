<template>
  <div
    class="desktop-segmented-control"
    :data-size="size"
    :role="mode === 'tabs' ? 'tablist' : 'group'"
    :aria-label="label"
  >
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      :role="mode === 'tabs' ? 'tab' : undefined"
      :aria-selected="mode === 'tabs' ? modelValue === option.id : undefined"
      :aria-pressed="mode === 'filters' ? modelValue === option.id : undefined"
      :data-active="modelValue === option.id"
      :disabled="option.disabled"
      @click="emit('update:modelValue', option.id)"
    >
      <span class="desktop-segmented-label">{{ option.label }}</span>
      <span v-if="option.count !== undefined" class="desktop-segmented-count">{{ option.count }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
export interface DesktopSegmentedOption {
  id: string;
  label: string;
  count?: number | string;
  disabled?: boolean;
}

withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly DesktopSegmentedOption[];
    label: string;
    mode?: "filters" | "tabs";
    size?: "compact" | "large";
  }>(),
  {
    mode: "filters",
    size: "compact",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<style scoped>
.desktop-segmented-control {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--desktop-segmented-gap, 4px);
  min-width: 0;
  padding: var(--desktop-segmented-padding, 4px);
  border: 1px solid rgba(255, 255, 255, 0.075);
  border-radius: var(--desktop-segmented-radius, 14px);
  background: rgba(255, 255, 255, 0.032);
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out);
}

.desktop-segmented-control[data-size="large"] {
  --desktop-segmented-gap: 12px;
  --desktop-segmented-padding: 8px;
  --desktop-segmented-radius: 22px;
  --desktop-segmented-button-height: 40px;
  --desktop-segmented-button-padding: 0 22px;
  --desktop-segmented-button-radius: 16px;
  --desktop-segmented-button-gap: 8px;
  --desktop-segmented-label-size: 1rem;
  --desktop-segmented-count-min-width: 22px;
  --desktop-segmented-count-padding: 2px 7px;
  --desktop-segmented-count-size: 0.72rem;
  background: rgba(255, 255, 255, 0.024);
}

.desktop-segmented-control button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--desktop-segmented-button-gap, 6px);
  min-height: var(--desktop-segmented-button-height, 34px);
  padding: var(--desktop-segmented-button-padding, 0 11px);
  border: 1px solid transparent;
  border-radius: var(--desktop-segmented-button-radius, 10px);
  background: transparent;
  color: var(--text-tertiary);
  font: inherit;
  font-size: var(--desktop-segmented-label-size, 0.75rem);
  font-weight: 850;
  cursor: pointer;
  transition:
    transform 150ms var(--ease-out),
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    color 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out);
}

.desktop-segmented-control button:disabled {
  cursor: default;
  opacity: 0.48;
}

.desktop-segmented-control button:not(:disabled):hover {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
}

.desktop-segmented-control button:not(:disabled):active {
  transform: translateY(0) scale(0.98);
}

.desktop-segmented-control button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.075);
}

.desktop-segmented-control button[data-active="true"] {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}

.desktop-segmented-control button[data-active="true"]:hover {
  color: var(--text);
}

.desktop-segmented-label {
  line-height: 1;
}

.desktop-segmented-count {
  min-width: var(--desktop-segmented-count-min-width, 18px);
  padding: var(--desktop-segmented-count-padding, 1px 5px);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.07);
  color: var(--text-secondary);
  font-size: var(--desktop-segmented-count-size, 0.68rem);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: center;
  transition:
    background 150ms var(--ease-out),
    color 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.desktop-segmented-control button[data-active="true"] .desktop-segmented-count {
  background: rgba(147, 197, 253, 0.18);
  color: #bfdbfe;
  transform: scale(1.03);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-segmented-control *,
  .desktop-segmented-control *::before,
  .desktop-segmented-control *::after {
    transition-duration: 1ms !important;
  }

  .desktop-segmented-control button:hover,
  .desktop-segmented-control button:active,
  .desktop-segmented-control button[data-active="true"] .desktop-segmented-count {
    transform: none;
  }
}
</style>
