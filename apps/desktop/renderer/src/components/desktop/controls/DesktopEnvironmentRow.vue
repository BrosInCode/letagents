<template>
  <button
    v-if="actionable"
    class="desktop-environment-row"
    type="button"
    :disabled="disabled"
    :data-tone="tone"
    :data-muted="muted"
    :data-wrap-label="wrapLabel"
    :data-testid="testId"
    @click="emit('select')"
  >
    <span class="desktop-environment-row-icon">
      <slot name="icon" />
    </span>
    <span class="desktop-environment-row-main">
      <span class="desktop-environment-row-label" :title="label">{{ label }}</span>
      <small v-if="description" :title="description">{{ description }}</small>
    </span>
    <span v-if="value || $slots.trailing" class="desktop-environment-row-trailing">
      <slot name="trailing">{{ value }}</slot>
    </span>
  </button>

  <div
    v-else
    class="desktop-environment-row"
    :data-tone="tone"
    :data-muted="muted"
    :data-wrap-label="wrapLabel"
    :data-testid="testId"
  >
    <span class="desktop-environment-row-icon">
      <slot name="icon" />
    </span>
    <span class="desktop-environment-row-main">
      <span class="desktop-environment-row-label" :title="label">{{ label }}</span>
      <small v-if="description" :title="description">{{ description }}</small>
    </span>
    <span v-if="value || $slots.trailing" class="desktop-environment-row-trailing">
      <slot name="trailing">{{ value }}</slot>
    </span>
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  label: string;
  value?: string | null;
  description?: string | null;
  tone?: "neutral" | "positive" | "attention" | "danger";
  actionable?: boolean;
  disabled?: boolean;
  muted?: boolean;
  wrapLabel?: boolean;
  testId?: string;
}>(), {
  value: null,
  description: null,
  tone: "neutral",
  actionable: false,
  disabled: false,
  muted: false,
  wrapLabel: false,
  testId: undefined,
});

const emit = defineEmits<{
  select: [];
}>();
</script>

<style scoped>
.desktop-environment-row {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  min-height: 38px;
  width: 100%;
  padding: 0;
  border: 0;
  appearance: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font: inherit;
  text-align: left;
}

button.desktop-environment-row {
  cursor: pointer;
}

button.desktop-environment-row:disabled {
  cursor: not-allowed;
}

.desktop-environment-row[data-muted="true"] {
  color: rgba(255, 255, 255, 0.42);
}

.desktop-environment-row-icon {
  display: inline-grid;
  place-items: center;
  width: 26px;
  color: currentColor;
}

.desktop-environment-row-main {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.desktop-environment-row-label {
  min-width: 0;
  overflow: hidden;
  color: currentColor;
  font-size: 0.92rem;
  font-weight: 520;
  line-height: 1.16;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-environment-row[data-wrap-label="true"] .desktop-environment-row-label {
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}

.desktop-environment-row-main small {
  min-width: 0;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.38);
  font-size: 0.72rem;
  font-weight: 620;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-environment-row-trailing {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  min-width: 0;
  color: rgba(255, 255, 255, 0.56);
  font-size: 0.82rem;
  font-weight: 680;
  line-height: 1.2;
  white-space: nowrap;
}

.desktop-environment-row[data-tone="positive"] .desktop-environment-row-trailing {
  color: #76f56f;
}

.desktop-environment-row[data-tone="positive"] .desktop-environment-row-icon {
  color: #76f56f;
}

.desktop-environment-row[data-tone="attention"] .desktop-environment-row-trailing {
  color: #f4c06a;
}

.desktop-environment-row[data-tone="attention"] .desktop-environment-row-icon {
  color: #f4c06a;
}

.desktop-environment-row[data-tone="danger"] .desktop-environment-row-trailing {
  color: #ff6b82;
}

.desktop-environment-row[data-tone="danger"] .desktop-environment-row-icon {
  color: #ff6b82;
}

button.desktop-environment-row:hover:not(:disabled) .desktop-environment-row-label,
button.desktop-environment-row:focus-visible:not(:disabled) .desktop-environment-row-label {
  color: rgba(255, 255, 255, 0.9);
}
</style>
