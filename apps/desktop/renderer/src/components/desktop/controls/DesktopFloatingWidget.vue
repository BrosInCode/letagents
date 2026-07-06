<template>
  <div
    ref="widgetRoot"
    class="desktop-floating-widget"
    :data-open="open"
    :data-anchor="anchor"
    :data-tone="tone"
    :data-testid="testId"
    @keydown.escape.stop="closeWidget"
  >
    <button
      class="desktop-floating-widget-trigger"
      type="button"
      :aria-expanded="open"
      :aria-label="open ? `Hide ${label}` : `Show ${label}`"
      @click="emit('update:open', !open)"
    >
      <span class="desktop-floating-widget-trigger-icon">
        <slot name="icon" />
      </span>
      <span class="desktop-floating-widget-trigger-copy">
        <strong>{{ label }}</strong>
        <small v-if="summary">{{ summary }}</small>
      </span>
    </button>

    <Transition name="desktop-floating-widget-panel">
      <div v-if="open" class="desktop-floating-widget-panel">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = withDefaults(defineProps<{
  open: boolean;
  label: string;
  summary?: string | null;
  anchor?: "right" | "left";
  tone?: "neutral" | "attention";
  testId?: string;
}>(), {
  summary: null,
  anchor: "right",
  tone: "neutral",
  testId: "desktop-floating-widget",
});

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();

const widgetRoot = ref<HTMLElement | null>(null);

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown);
});

function closeWidget(): void {
  if (!props.open) return;
  emit("update:open", false);
}

function handleDocumentPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (widgetRoot.value?.contains(target)) return;
  closeWidget();
}
</script>

<style scoped>
.desktop-floating-widget {
  display: grid;
  justify-items: end;
  gap: 8px;
}

.desktop-floating-widget[data-anchor="left"] {
  justify-items: start;
}

.desktop-floating-widget-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 40px;
  max-width: min(260px, calc(100vw - 44px));
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  appearance: none;
  background: rgba(18, 18, 18, 0.94);
  color: rgba(255, 255, 255, 0.8);
  box-shadow:
    0 16px 38px rgba(0, 0, 0, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  cursor: pointer;
  backdrop-filter: blur(18px) saturate(1.12);
  transition:
    border-color var(--duration-fast) var(--ease-out),
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}

.desktop-floating-widget[data-open="true"] .desktop-floating-widget-trigger {
  width: auto;
  min-width: 142px;
  justify-content: flex-start;
  border-color: rgba(125, 211, 252, 0.36);
  background:
    linear-gradient(135deg, rgba(56, 189, 248, 0.14), rgba(255, 255, 255, 0.04)),
    rgba(26, 26, 26, 0.97);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.38),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.94);
}

.desktop-floating-widget[data-tone="attention"][data-open="false"] .desktop-floating-widget-trigger {
  border-color: rgba(245, 158, 11, 0.34);
  background:
    linear-gradient(135deg, rgba(245, 158, 11, 0.13), rgba(255, 255, 255, 0.035)),
    rgba(22, 18, 12, 0.96);
}

.desktop-floating-widget[data-tone="attention"][data-open="false"] .desktop-floating-widget-trigger-icon {
  color: rgba(251, 191, 36, 0.86);
}

.desktop-floating-widget-trigger:hover,
.desktop-floating-widget-trigger:focus-visible {
  transform: translateY(-1px);
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(26, 26, 26, 0.96);
  color: rgba(255, 255, 255, 0.9);
}

.desktop-floating-widget-trigger:focus-visible {
  outline: 2px solid rgba(147, 197, 253, 0.6);
  outline-offset: 2px;
}

.desktop-floating-widget[data-open="false"] .desktop-floating-widget-trigger-copy {
  display: none;
}

.desktop-floating-widget-trigger-icon {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: rgba(255, 255, 255, 0.64);
}

.desktop-floating-widget-trigger-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
  text-align: left;
}

.desktop-floating-widget-trigger-copy strong,
.desktop-floating-widget-trigger-copy small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.desktop-floating-widget-trigger-copy strong {
  font-size: 0.76rem;
  font-weight: 860;
  line-height: 1;
}

.desktop-floating-widget-trigger-copy small {
  color: rgba(255, 255, 255, 0.44);
  font-size: 0.62rem;
  font-weight: 720;
}

.desktop-floating-widget-panel {
  min-width: 0;
}

.desktop-floating-widget-panel-enter-active,
.desktop-floating-widget-panel-leave-active {
  transition:
    opacity 160ms var(--ease-out),
    transform 160ms var(--ease-out);
}

.desktop-floating-widget-panel-enter-from,
.desktop-floating-widget-panel-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.985);
}

.desktop-floating-widget-panel-enter-to,
.desktop-floating-widget-panel-leave-from {
  opacity: 1;
  transform: translateY(0) scale(1);
}
</style>
