<template>
  <nav v-if="pins.length && !pinnedMessagesHidden" ref="rail" class="message-pin-rail" aria-label="Pinned messages"
    :data-expanded="expanded" @keydown="onKeydown" @pointerenter="onPointerEnter" @pointerleave="scheduleClose"
    @focusin="openPanel" @focusout="onFocusOut">
    <button v-for="(pin, index) in pins" :key="pin.message_id" type="button" class="message-pin-tick"
      data-pin-entry :data-pinned-message-id="pin.message_id" :tabindex="index === active ? 0 : -1"
      :aria-label="`Pinned message from ${senderLabel(pin.sender)}: ${previewText(pin.snippet)}`"
      :aria-current="selectedId === pin.message_id ? 'location' : undefined"
      :data-active="selectedId === pin.message_id" @focus="active = index" @click="choose(pin.message_id)">
      <span class="message-pin-bar" aria-hidden="true" />
      <span v-if="expanded" class="message-pin-title" aria-hidden="true">{{ previewText(pin.snippet) }}</span>
    </button>
    <p v-if="expanded && loading" class="message-pin-status" role="status">Updating pins…</p>
    <p v-if="expanded && error" class="message-pin-status" role="alert">{{ error }}</p>
    <button v-if="error" type="button" class="message-pin-retry" :aria-label="`${error} Retry loading pinned messages`"
      @click="$emit('refresh')">Retry</button>
  </nav>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { MessagePin } from "../message-pins.mjs";
import { usePinnedMessageVisibility } from "./usePinnedMessageVisibility";

const props = defineProps<{ pins: readonly MessagePin[]; loading?: boolean; error?: string | null }>();
const emit = defineEmits<{ reveal: [messageId: string]; refresh: [] }>();
const { pinnedMessagesHidden } = usePinnedMessageVisibility();
const rail = ref<HTMLElement | null>(null);
const active = ref(0);
const selectedId = ref<string | null>(null);
const expanded = ref(false);
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function cancelClose(): void { clearTimeout(closeTimer); }
function openPanel(): void { cancelClose(); expanded.value = true; }
function closePanel(): void { cancelClose(); expanded.value = false; }
function onPointerEnter(event: PointerEvent): void {
  cancelClose();
  if (event.pointerType === "mouse" && window.matchMedia("(hover: hover) and (pointer: fine)").matches) openPanel();
}
function onFocusOut(event: FocusEvent): void {
  if (!rail.value?.contains(event.relatedTarget as Node | null)) closePanel();
}
function scheduleClose(): void {
  cancelClose();
  closeTimer = setTimeout(() => {
    if (!rail.value?.contains(document.activeElement)) closePanel();
  }, 100);
}
function dismissOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closePanel();
}
function onOutsidePress(event: PointerEvent): void {
  if (!rail.value?.contains(event.target as Node | null)) closePanel();
}
function choose(id: string): void {
  selectedId.value = id;
  closePanel();
  emit("reveal", id);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") { dismissOnEscape(event); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !props.pins.length) return;
  event.preventDefault();
  active.value = event.key === "Home" ? 0 : event.key === "End" ? props.pins.length - 1
    : (active.value + (event.key === "ArrowDown" ? 1 : -1) + props.pins.length) % props.pins.length;
  rail.value?.querySelectorAll<HTMLButtonElement>("[data-pin-entry]")[active.value]?.focus();
}
function senderLabel(value: string): string { return value.split("|")[0].trim(); }
function previewText(value: string): string {
  return value.replace(/!?\[([^\]]*)\]\([^)]*(?:\)|$)/g, "$1")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|~~|`+/g, "").replace(/\s+/g, " ").trim() || "Message without text";
}
watch(expanded, (open) => {
  if (open) {
    document.addEventListener("keydown", dismissOnEscape, true);
    document.addEventListener("pointerdown", onOutsidePress, true);
  } else {
    document.removeEventListener("keydown", dismissOnEscape, true);
    document.removeEventListener("pointerdown", onOutsidePress, true);
  }
});
watch([() => props.pins.map(pin => pin.message_id), pinnedMessagesHidden], ([ids, hidden], [previousIds]) => {
  const focusWasInside = rail.value?.contains(document.activeElement);
  const region = rail.value?.parentElement;
  if (hidden || !ids.length) closePanel();
  if (!ids.includes(selectedId.value || "")) selectedId.value = null;
  const retainedIndex = ids.indexOf(previousIds[active.value]);
  active.value = retainedIndex >= 0 ? retainedIndex : Math.min(active.value, Math.max(0, ids.length - 1));
  if (focusWasInside) {
    void nextTick(() => {
      if (!hidden && ids.length) rail.value?.querySelectorAll<HTMLButtonElement>("[data-pin-entry]")[active.value]?.focus();
      else if (region) { region.tabIndex = -1; region.focus({ preventScroll: true }); }
    });
  }
});
onBeforeUnmount(() => {
  cancelClose();
  document.removeEventListener("keydown", dismissOnEscape, true);
  document.removeEventListener("pointerdown", onOutsidePress, true);
});
</script>

<style>
.message-pin-rail { position: absolute; grid-area: 1 / 1 / 2 / 2; top: 8px; left: 4px; z-index: 4; display: flex; flex-direction: column; box-sizing: border-box; width: 36px; max-height: calc(100% - 16px); padding: 4px; border: 1px solid transparent; border-radius: 10px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
.message-pin-rail::-webkit-scrollbar { display: none; }
.message-pin-rail[data-expanded="true"] { width: min(420px, calc(100% - 8px)); border-color: var(--border-strong); background: var(--bg-elevated); box-shadow: var(--shadow-lg); }
.message-pin-tick { display: flex; align-items: center; gap: 10px; flex: 0 0 28px; width: 100%; height: 28px; min-width: 0; padding: 0 3px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.message-pin-bar { display: flex; align-items: center; flex: 0 0 20px; }
.message-pin-bar::before { content: ""; width: 12px; height: 2px; border-radius: 2px; background: currentColor; opacity: .55; }
.message-pin-tick[data-active="true"] .message-pin-bar::before, .message-pin-tick:focus-visible .message-pin-bar::before { width: 20px; opacity: 1; }
.message-pin-title { min-width: 0; padding-right: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.message-pin-tick:focus-visible, .message-pin-retry:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.message-pin-rail[data-expanded="true"] .message-pin-tick:focus-visible { background: var(--accent-hover); }
.message-pin-tick:active { background: var(--accent-active); }
.message-pin-retry { flex: 0 0 auto; border: 0; padding: 8px 0; border-radius: 4px; background: var(--bg-elevated); color: var(--text); font: inherit; font-size: 10px; cursor: pointer; }
.message-pin-status { flex: 0 0 auto; margin: 8px; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) {
  .message-pin-rail[data-expanded="true"] .message-pin-tick:hover { background: var(--accent-hover); }
  .message-pin-tick:hover .message-pin-bar::before { width: 20px; opacity: 1; }
}
@media (pointer: coarse) { .message-pin-tick { flex-basis: 44px; height: 44px; } }
.message-pin-marker { display: inline-flex; vertical-align: middle; color: var(--text-secondary); margin-inline: 4px; }
.message-pin-marker svg { display: block; width: 13px; height: 13px; flex: 0 0 auto; }
</style>
