<template>
  <label
    class="focus-room-quick-close-option"
    :class="{ selected: modelValue }"
    :data-disabled="disabled ? 'true' : undefined"
  >
    <input
      v-model="modelValue"
      type="checkbox"
      :disabled="disabled"
      :data-testid="testId"
    />
    <span class="focus-room-quick-close-copy">
      <strong>Quick close</strong>
      <span>
        {{ taskLinked
          ? "Close without an outcome summary or task closeout details. The linked parent task will remain unchanged."
          : "Close without adding an outcome summary."
        }}
      </span>
    </span>
  </label>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  taskLinked?: boolean;
  disabled?: boolean;
  testId?: string;
}>(), {
  taskLinked: false,
  disabled: false,
  testId: undefined,
});

const modelValue = defineModel<boolean>({ required: true });
</script>

<style scoped>
.focus-room-quick-close-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.025);
  cursor: pointer;
  transition:
    border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
}

.focus-room-quick-close-option.selected {
  border-color: color-mix(in srgb, var(--text) 22%, var(--border));
  background: rgba(255, 255, 255, 0.055);
}

.focus-room-quick-close-option:focus-within {
  border-color: color-mix(in srgb, var(--text) 34%, var(--border));
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.09);
}

.focus-room-quick-close-option[data-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
}

.focus-room-quick-close-option input[type="checkbox"] {
  flex: 0 0 auto;
  width: 17px;
  height: 17px;
  min-height: 0;
  margin: 2px 0 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  accent-color: var(--text);
}

.focus-room-quick-close-option input[type="checkbox"]:focus {
  border: 0;
  background: transparent;
  box-shadow: none;
}

.focus-room-quick-close-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.focus-room-quick-close-copy strong {
  color: var(--text);
  font-size: 0.86rem;
  line-height: 1.25;
}

.focus-room-quick-close-copy > span {
  color: var(--text-secondary);
  font-size: 0.78rem;
  line-height: 1.4;
}

@media (hover: hover) and (pointer: fine) {
  .focus-room-quick-close-option:not([data-disabled="true"]):hover {
    border-color: color-mix(in srgb, var(--text) 18%, var(--border));
    background: rgba(255, 255, 255, 0.045);
  }
}
</style>
