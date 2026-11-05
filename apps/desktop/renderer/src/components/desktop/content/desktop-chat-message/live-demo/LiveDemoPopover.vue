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
  // Under its button, right edges lined up, and never past the card's left edge.
  const width = root.value?.offsetWidth ?? 0;
  const right = Math.max(6, Math.round(c.right - a.right));
  place.value = { top: Math.round(a.bottom - c.top + 6), right: width ? Math.min(right, Math.max(6, Math.round(c.width - width - 6))) : right };
}

/** Escape gives the keyboard back to the button, once it is enabled again; or to the first tool that is. */
function close(focusAnchor: boolean): void {
  emit("close");
  if (!focusAnchor) return;
  void nextTick(() => {
    const anchor = props.anchor;
    const target = anchor && !anchor.matches(":disabled")
      ? anchor
      : props.container?.querySelector<HTMLElement>(".live-demo-tool:not(:disabled)");
    target?.focus({ preventScroll: true });
  });
}

// A click in the demo goes to its own page, not this one; the demo taking the keyboard is the sign.
function onFocusIn(event: FocusEvent): void {
  const target = event.target;
  if (!(target instanceof Node) || root.value?.contains(target) || props.anchor?.contains(target)) return;
  if (target instanceof HTMLElement && target.tagName === "WEBVIEW") close(false);
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
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("resize", measure);
  } else {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("resize", measure);
  }
}

watch(() => props.open, (open) => {
  listen(open);
  if (!open) return;
  measure();
  // The keyboard goes into the panel, but never onto an action it could set off by accident.
  void nextTick(() => {
    // Measured again with its width, so a narrow card keeps it inside.
    measure();
    const target = root.value?.querySelector<HTMLElement>("[data-autofocus]") ?? root.value;
    target?.focus({ preventScroll: true });
  });
}, { immediate: true });

onBeforeUnmount(() => listen(false));
</script>
