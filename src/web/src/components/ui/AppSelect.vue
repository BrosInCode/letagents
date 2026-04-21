<template>
  <div class="app-select" :data-disabled="disabled ? 'true' : 'false'">
    <select
      v-bind="$attrs"
      class="app-select__control"
      :value="modelValue ?? ''"
      :disabled="disabled"
      @change="handleChange"
    >
      <slot />
    </select>
  </div>
</template>

<script setup lang="ts">
defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<{
  modelValue?: string | null
  disabled?: boolean
}>(), {
  modelValue: '',
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function handleChange(event: Event) {
  emit('update:modelValue', (event.target as HTMLSelectElement).value)
}
</script>

<style scoped>
.app-select {
  --app-select-border: var(--line, #27272a);
  --app-select-bg: var(--bg-0, #09090b);
  --app-select-text: var(--text, #fafafa);
  --app-select-caret: #a1a1aa;
  --app-select-focus: rgba(96, 165, 250, 0.28);
  --app-select-radius: 10px;
  --app-select-height: 40px;
  --app-select-padding-left: 12px;
  --app-select-padding-right: 38px;
  position: relative;
  display: block;
  width: 100%;
}

.app-select::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 12px;
  width: 12px;
  height: 12px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-position: center;
  background-repeat: no-repeat;
  background-size: 12px 12px;
}

.app-select__control {
  width: 100%;
  min-width: 0;
  min-height: var(--app-select-height);
  padding: 0 var(--app-select-padding-right) 0 var(--app-select-padding-left);
  border: 1px solid var(--app-select-border);
  border-radius: var(--app-select-radius);
  background: var(--app-select-bg);
  color: var(--app-select-text);
  font: inherit;
  font-size: 0.78rem;
  line-height: 1.2;
  -webkit-appearance: none;
  appearance: none;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}

.app-select__control:focus {
  outline: none;
}

.app-select__control:focus-visible {
  border-color: color-mix(in srgb, var(--app-select-focus) 85%, var(--app-select-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-select-focus) 70%, transparent);
}

.app-select[data-disabled='true']::after {
  opacity: 0.55;
}

.app-select__control:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}
</style>
