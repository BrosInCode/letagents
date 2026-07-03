<template>
  <label class="desktop-select-field">
    <span v-if="label" class="desktop-select-label">{{ label }}</span>
    <span class="desktop-select-control">
      <select
        :id="id"
        :value="modelValue"
        :disabled="disabled"
        :aria-label="label || undefined"
        :aria-describedby="describedBy || undefined"
        :data-testid="testId || undefined"
        @change="handleChange"
      >
        <option v-if="placeholder" value="" :disabled="placeholderDisabled">
          {{ placeholder }}
        </option>
        <option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :disabled="option.disabled"
        >
          {{ option.label }}
        </option>
      </select>
      <ChevronDown class="desktop-select-caret" :size="16" aria-hidden="true" />
    </span>
  </label>
</template>

<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";

export interface DesktopSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

withDefaults(
  defineProps<{
    modelValue: string;
    options: readonly DesktopSelectOption[];
    label?: string;
    disabled?: boolean;
    id?: string;
    describedBy?: string;
    testId?: string;
    placeholder?: string;
    placeholderDisabled?: boolean;
  }>(),
  {
    label: "",
    disabled: false,
    id: undefined,
    describedBy: "",
    testId: "",
    placeholder: "",
    placeholderDisabled: true,
  }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function handleChange(event: Event): void {
  emit("update:modelValue", (event.target as HTMLSelectElement).value);
}
</script>

<style scoped>
.desktop-select-field {
  --desktop-select-height: 38px;
  --desktop-select-radius: 12px;
  --desktop-select-padding-x: 12px;
  --desktop-select-caret-inset: 14px;
  --desktop-select-caret-size: 16px;
  --desktop-select-caret-gap: 12px;
  --desktop-select-background: rgba(255, 255, 255, 0.05);
  --desktop-select-border: var(--border);
  --desktop-select-focus-border: rgba(255, 255, 255, 0.24);
  --desktop-select-focus-ring: rgba(255, 255, 255, 0.08);

  display: grid;
  gap: 5px;
  min-width: 0;
}

.desktop-select-label {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-size: 0.78rem;
  font-weight: 750;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 150ms var(--ease-out);
}

.desktop-select-control {
  position: relative;
  display: block;
  min-width: 0;
}

.desktop-select-control select {
  width: 100%;
  min-width: 0;
  min-height: var(--desktop-select-height);
  padding: 0
    calc(
      var(--desktop-select-caret-inset) + var(--desktop-select-caret-size) +
        var(--desktop-select-caret-gap)
    )
    0 var(--desktop-select-padding-x);
  border: 1px solid var(--desktop-select-border);
  border-radius: var(--desktop-select-radius);
  outline: none;
  appearance: none;
  overflow: hidden;
  background: var(--desktop-select-background);
  color: var(--text);
  font: inherit;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    border-color 150ms var(--ease-out),
    background 150ms var(--ease-out),
    box-shadow 150ms var(--ease-out),
    color 150ms var(--ease-out);
}

.desktop-select-control select:not(:disabled) {
  cursor: pointer;
}

.desktop-select-field:has(select:not(:disabled)):hover .desktop-select-label {
  color: var(--text-secondary);
}

.desktop-select-control select:not(:disabled):hover {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.07);
}

.desktop-select-control select:disabled {
  cursor: default;
  opacity: 0.55;
}

.desktop-select-control select:focus-visible {
  border-color: var(--desktop-select-focus-border);
  box-shadow: 0 0 0 3px var(--desktop-select-focus-ring);
}

.desktop-select-field:focus-within .desktop-select-label {
  color: var(--text-secondary);
}

.desktop-select-caret {
  position: absolute;
  top: 50%;
  right: var(--desktop-select-caret-inset);
  color: var(--text);
  opacity: 0.88;
  pointer-events: none;
  transform: translateY(-50%);
  transition:
    color 150ms var(--ease-out),
    opacity 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.desktop-select-field:hover .desktop-select-caret,
.desktop-select-field:focus-within .desktop-select-caret {
  opacity: 1;
  transform: translateY(-50%) translateY(-1px);
}

@media (prefers-reduced-motion: reduce) {
  .desktop-select-field *,
  .desktop-select-field *::before,
  .desktop-select-field *::after {
    transition-duration: 1ms !important;
  }

  .desktop-select-field:hover .desktop-select-caret,
  .desktop-select-field:focus-within .desktop-select-caret {
    transform: translateY(-50%);
  }
}
</style>
