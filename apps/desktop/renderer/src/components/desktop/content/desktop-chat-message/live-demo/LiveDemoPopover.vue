<template>
  <Transition name="live-demo-pop">
    <div
      v-if="open"
      ref="root"
      class="live-demo-pop"
      :class="extraClass"
      :role="role"
      :aria-label="label"
      tabindex="-1"
      :style="{ top: `${place.top}px`, right: `${place.right}px` }"
      @keydown.escape.stop.prevent="close(true)"
    >
      <slot />
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

/**
 * A panel that grows from the header button that opened it and lies over the
 * demo, so opening it moves nothing. A click outside or Escape closes it.
 */
const props = withDefaults(defineProps<{
  open: boolean;
  /** The button that opened it, and the card it is placed in. */
  anchor: HTMLElement | null;
  container: HTMLElement | null;
  label: string;
  role?: string;
  extraClass?: string;
}>(), { role: "dialog", extraClass: "" });

const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const place = ref({ top: 0, right: 0 });

function measure(): void {
  const anchor = props.anchor;
  const container = props.container;
  if (!anchor || !container) return;
  const a = anchor.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  place.value = { top: Math.round(a.bottom - c.top + 6), right: Math.max(6, Math.round(c.right - a.right)) };
}

function close(focusAnchor: boolean): void {
  emit("close");
  if (focusAnchor) props.anchor?.focus({ preventScroll: true });
}

function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  // The opening button toggles the panel itself.
  if (root.value?.contains(target) || props.anchor?.contains(target)) return;
  close(false);
}

function listen(on: boolean): void {
  if (on) {
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", measure);
  } else {
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("resize", measure);
  }
}

watch(() => props.open, (open) => {
  listen(open);
  if (!open) return;
  measure();
  // The keyboard goes into the panel, but never onto an action it could set off by accident.
  void nextTick(() => {
    const target = root.value?.querySelector<HTMLElement>("[data-autofocus]") ?? root.value;
    target?.focus({ preventScroll: true });
  });
}, { immediate: true });

onBeforeUnmount(() => listen(false));
</script>
