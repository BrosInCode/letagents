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
      :id="tabId(option.id)"
      :role="mode === 'tabs' ? 'tab' : undefined"
      :aria-selected="mode === 'tabs' ? modelValue === option.id : undefined"
      :aria-controls="tabPanelId(option.id)"
      :aria-pressed="mode === 'filters' ? modelValue === option.id : undefined"
      :tabindex="tabIndexFor(option)"
      :data-active="modelValue === option.id"
      :disabled="option.disabled"
      @click="emit('update:modelValue', option.id)"
      @keydown="handleKeydown"
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

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly DesktopSegmentedOption[];
    label: string;
    mode?: "filters" | "tabs";
    size?: "compact" | "large";
    tabPanelIdPrefix?: string;
  }>(),
  {
    mode: "filters",
    size: "compact",
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function tabId(optionId: string): string | undefined {
  if (props.mode !== "tabs" || !props.tabPanelIdPrefix) return undefined;
  return `${props.tabPanelIdPrefix}-tab-${optionId}`;
}

function tabPanelId(optionId: string): string | undefined {
  if (props.mode !== "tabs" || !props.tabPanelIdPrefix) return undefined;
  return `${props.tabPanelIdPrefix}-panel-${optionId}`;
}

function tabIndexFor(option: DesktopSegmentedOption): number | undefined {
  if (props.mode !== "tabs") return undefined;
  return props.modelValue === option.id ? 0 : -1;
}

function handleKeydown(event: KeyboardEvent): void {
  if (props.mode !== "tabs") return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

  const current = event.currentTarget as HTMLButtonElement;
  const tabs = Array.from(
    current.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') || []
  );
  const currentIndex = tabs.indexOf(current);
  if (currentIndex < 0 || tabs.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  const nextTab = tabs[nextIndex];
  nextTab.focus();
  nextTab.click();
}
</script>

<style scoped>
.desktop-segmented-control {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--desktop-segmented-gap, 4px);
  min-width: 0;
  padding: var(--desktop-segmented-padding, 4px);
  border: 1px solid var(--border);
  border-radius: var(--desktop-segmented-radius, 14px);
  background: var(--accent-dim);
  transition:
    border-color var(--duration-fast) ease,
    background-color var(--duration-fast) ease;
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
  background: var(--accent-dim);
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
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--desktop-segmented-label-size, 0.75rem);
  font-weight: 600;
  cursor: pointer;
  transition:
    transform 100ms ease-out,
    border-color var(--duration-fast) ease,
    background-color var(--duration-fast) ease,
    color var(--duration-fast) ease;
}

.desktop-segmented-control button:disabled {
  cursor: default;
  opacity: 0.48;
}

.desktop-segmented-control button:not(:disabled):active {
  transform: translateY(0) scale(0.98);
}

.desktop-segmented-control button:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
  box-shadow: none;
}

.desktop-segmented-control button[data-active="true"] {
  border-color: var(--border-strong);
  background: var(--accent-active);
  color: var(--text);
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
  background: var(--accent-hover);
  color: var(--text-secondary);
  font-size: var(--desktop-segmented-count-size, 0.68rem);
  font-variant-numeric: tabular-nums;
  line-height: 1;
  text-align: center;
  transition:
    background-color var(--duration-fast) ease,
    color var(--duration-fast) ease,
    transform 100ms ease-out;
}

.desktop-segmented-control button[data-active="true"] .desktop-segmented-count {
  background: var(--blue-dim);
  color: var(--blue);
}

@media (hover: hover) and (pointer: fine) {
  .desktop-segmented-control button:not(:disabled):hover {
    border-color: var(--border-strong);
    background: var(--accent-hover);
    color: var(--text);
  }
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

@media (prefers-contrast: more) {
  .desktop-segmented-control button:focus-visible {
    outline-width: 3px;
    outline-color: var(--text);
  }
}
</style>
