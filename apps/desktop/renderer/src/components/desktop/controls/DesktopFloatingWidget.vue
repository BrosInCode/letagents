<template>
  <div
    ref="widgetRoot"
    class="desktop-floating-widget"
    :data-open="open"
    :data-anchor="anchor"
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
  testId?: string;
}>(), {
  summary: null,
  anchor: "right",
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
  border: 1px solid var(--border-strong);
  border-radius: 12px;
  appearance: none;
  background: var(--bg-card);
  color: var(--text);
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
  border-color: var(--border-strong);
  background: var(--bg-card);
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.38),
    inset 0 1px 0 rgba(255, 255, 255, 0.045);
  color: var(--text);
}

.desktop-floating-widget-trigger:hover,
.desktop-floating-widget-trigger:focus-visible {
  transform: translateY(-1px);
  border-color: var(--border-accent);
  background: var(--bg-elevated);
  color: var(--text);
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
  color: var(--text-secondary);
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
  color: var(--text-tertiary);
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

@media (hover: none), (pointer: coarse) {
  .desktop-floating-widget-trigger:hover {
    transform: none;
    border-color: var(--border-strong);
  }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-floating-widget-trigger,
  .desktop-floating-widget-panel-enter-active,
  .desktop-floating-widget-panel-leave-active {
    transition-property: opacity, border-color, background-color, color;
  }

  .desktop-floating-widget-panel-enter-from,
  .desktop-floating-widget-panel-leave-to,
  .desktop-floating-widget-panel-enter-to,
  .desktop-floating-widget-panel-leave-from {
    transform: none;
  }
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .desktop-floating-widget-trigger {
    background: var(--bg-elevated);
    backdrop-filter: none;
  }
}
</style>
