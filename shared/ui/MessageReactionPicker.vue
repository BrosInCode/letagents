<template>
  <Teleport to="body">
    <div
      v-if="anchor"
      ref="panel"
      class="message-reaction-picker"
      role="dialog"
      aria-label="Add a reaction"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      :data-side="position.side"
      :data-align="position.align"
      :data-placed="placed"
      :data-instant="instant"
      @keydown="handleKeydown"
      @focusout="handleFocusOut"
      @pointerdown.stop
      @contextmenu.stop
    >
      <div class="message-reaction-picker-grid" role="group" aria-label="Common reactions">
        <button
          v-for="(emoji, index) in MESSAGE_REACTION_QUICK_EMOJI"
          :key="emoji"
          class="message-reaction-picker-emoji"
          type="button"
          :tabindex="index === activeIndex ? 0 : -1"
          :aria-pressed="viewerReacted(emoji)"
          @click="choose(emoji)"
          @focus="activeIndex = index"
        >
          {{ emoji }}
        </button>
      </div>
      <form class="message-reaction-picker-custom" novalidate @submit.prevent="chooseCustom">
        <input
          ref="customInput"
          v-model="custom"
          class="message-reaction-picker-input"
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          maxlength="32"
          placeholder="Or type any emoji, then Enter"
          aria-label="React with any emoji"
          :aria-invalid="customInvalid"
          :aria-describedby="customInvalid ? hintId : undefined"
          @input="customInvalid = false"
        />
        <p v-if="customInvalid" :id="hintId" class="message-reaction-picker-hint" role="alert">
          Enter one emoji.
        </p>
      </form>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, ref, useId, watch } from "vue";
import { MESSAGE_REACTION_QUICK_EMOJI, normalizeMessageReactionEmoji } from "../message-reactions.mjs";

export interface MessageReactionPickerAnchor {
  element: HTMLElement;
  /** Context-menu position, kept relative to the message as it scrolls. */
  point?: { x: number; y: number };
}

const COLUMNS = 8;
const GAP = 6;
const MARGIN = 8;

const props = defineProps<{
  /** Live control or message anchoring the picker; null closes it. */
  anchor: MessageReactionPickerAnchor | null;
  viewerReacted: (emoji: string) => boolean;
  /** Opened from the keyboard: appear without motion. */
  instant?: boolean;
}>();

const emit = defineEmits<{
  select: [emoji: string];
  /**
   * `restoreFocus` is true when the person dismissed it from the keyboard or
   * chose an emoji. `pressed` is what a dismissing press landed on, so the
   * host can tell a press on the control that opened the picker.
   */
  close: [restoreFocus: boolean, pressed?: EventTarget | null];
}>();

const panel = ref<HTMLElement | null>(null);
const customInput = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const custom = ref("");
const customInvalid = ref(false);
const placed = ref(false);
const position = reactive({ left: 0, top: 0, side: "above" as "above" | "below", align: "start" as "start" | "end" });
const hintId = useId();
let frame: number | null = null;
let pointOffset: { x: number; y: number } | null = null;
let focusOnPlacement = false;
let scrollViewport: HTMLElement | null = null;

function nearestScrollViewport(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/^(auto|scroll)$/.test(window.getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

function place(): void {
  const element = panel.value;
  const source = props.anchor;
  if (!element || !source) return;
  if (!source.element.isConnected) {
    dismiss();
    return;
  }
  // All geometry is read in this animation frame, before reactive style writes.
  const rect = source.element.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const clip = scrollViewport?.getBoundingClientRect();
  const visible = {
    left: Math.max(0, clip?.left ?? 0),
    right: Math.min(viewportWidth, clip?.right ?? viewportWidth),
    top: Math.max(0, clip?.top ?? 0),
    bottom: Math.min(viewportHeight, clip?.bottom ?? viewportHeight),
  };
  if (source.point && !pointOffset) {
    pointOffset = { x: source.point.x - rect.left, y: source.point.y - rect.top };
  }
  const anchor = pointOffset
    ? { left: rect.left + pointOffset.x, right: rect.left + pointOffset.x,
        top: rect.top + pointOffset.y, bottom: rect.top + pointOffset.y }
    : rect;
  // A context menu follows its click point, even when the rest of a tall
  // message is still visible. Controls stay anchored while partially visible.
  if (anchor.bottom <= visible.top || anchor.top >= visible.bottom
    || anchor.right <= visible.left || anchor.left >= visible.right
    || visible.bottom <= visible.top || visible.right <= visible.left) {
    dismiss();
    return;
  }
  const { width, height } = element.getBoundingClientRect();
  const fitsAbove = anchor.top - GAP - height >= MARGIN;
  const fitsBelow = anchor.bottom + GAP + height <= viewportHeight - MARGIN;
  position.side = fitsAbove || !fitsBelow ? "above" : "below";
  const top = position.side === "above" ? anchor.top - GAP - height : anchor.bottom + GAP;
  // Grow away from whichever edge of the window the control is nearer to.
  position.align = (anchor.left + anchor.right) / 2 > viewportWidth / 2 ? "end" : "start";
  const left = position.align === "end" ? anchor.right - width : anchor.left;
  position.left = Math.round(Math.min(Math.max(left, MARGIN), Math.max(MARGIN, viewportWidth - width - MARGIN)));
  position.top = Math.round(Math.min(Math.max(top, MARGIN), Math.max(MARGIN, viewportHeight - height - MARGIN)));
  placed.value = true;
}

function schedulePlace(): void {
  if (frame !== null || !listening) return;
  frame = window.requestAnimationFrame(() => {
    frame = null;
    place();
    if (focusOnPlacement && placed.value) {
      focusOnPlacement = false;
      // Position must be rendered before the initially hidden picker can focus.
      void nextTick(() => { if (listening && props.anchor) focusEmoji(0); });
    }
  });
}

function focusEmoji(index: number): void {
  const count = MESSAGE_REACTION_QUICK_EMOJI.length;
  activeIndex.value = Math.min(Math.max(index, 0), count - 1);
  panel.value?.querySelectorAll<HTMLButtonElement>(".message-reaction-picker-emoji")[activeIndex.value]?.focus();
}

function choose(emoji: string): void {
  emit("select", emoji);
  emit("close", true);
}

function chooseCustom(): void {
  const emoji = normalizeMessageReactionEmoji(custom.value);
  if (!emoji) {
    customInvalid.value = true;
    return;
  }
  choose(emoji);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("close", true);
    return;
  }
  const inInput = event.target === customInput.value;
  // There are two tab stops: the active emoji and the custom input. Exiting
  // either end returns to the opener instead of losing focus in the teleport.
  if (event.key === "Tab" && (event.shiftKey ? !inInput : inInput)) {
    event.preventDefault();
    event.stopPropagation();
    emit("close", true);
    return;
  }
  if (inInput) {
    // Leave the caret keys to the text field, except the way back up to the grid.
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusEmoji(activeIndex.value);
    }
    return;
  }
  const index = activeIndex.value;
  const last = MESSAGE_REACTION_QUICK_EMOJI.length - 1;
  const moves: Record<string, number | "input"> = {
    ArrowRight: Math.min(index + 1, last),
    ArrowLeft: Math.max(index - 1, 0),
    ArrowUp: index - COLUMNS >= 0 ? index - COLUMNS : index,
    ArrowDown: index + COLUMNS <= last ? index + COLUMNS : "input",
    Home: 0,
    End: last,
  };
  const move = moves[event.key];
  if (move === undefined) return;
  event.preventDefault();
  if (move === "input") customInput.value?.focus();
  else focusEmoji(move);
}

function handleFocusOut(event: FocusEvent): void {
  // Focus left the picker for something else in the app: it is done.
  const next = event.relatedTarget;
  if (next instanceof Node && !panel.value?.contains(next)) emit("close", false);
}

function dismiss(): void {
  emit("close", false);
}

// These listen in the capture phase, so they also see events from inside the picker.
function dismissUnlessInside(event: Event): void {
  if (event.target instanceof Node && panel.value?.contains(event.target)) return;
  emit("close", false, event.type === "pointerdown" ? event.target : null);
}

let listening = false;
function listen(on: boolean): void {
  if (on === listening) return;
  listening = on;
  if (on) {
    window.addEventListener("pointerdown", dismissUnlessInside, true);
    window.addEventListener("scroll", schedulePlace, true);
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("blur", dismiss);
  } else {
    window.removeEventListener("pointerdown", dismissUnlessInside, true);
    window.removeEventListener("scroll", schedulePlace, true);
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("blur", dismiss);
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    focusOnPlacement = false;
    scrollViewport = null;
  }
}

watch(
  () => props.anchor,
  async (anchor, previous) => {
    if (anchor && !previous) {
      placed.value = false;
      custom.value = "";
      customInvalid.value = false;
      activeIndex.value = 0;
      pointOffset = null;
      scrollViewport = nearestScrollViewport(anchor.element);
      focusOnPlacement = true;
      listen(true);
      await nextTick();
      schedulePlace();
    } else if (!anchor && previous) {
      listen(false);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => listen(false));
</script>

<style src="./message-reactions.css"></style>
