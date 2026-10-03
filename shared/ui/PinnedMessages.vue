<template>
  <nav v-if="pins.length && !pinnedMessagesHidden" ref="rail" class="message-pin-rail" aria-label="Pinned messages"
    @keydown="onKeydown" @pointerleave="scheduleClose" @scroll.passive="onRailScroll">
    <button v-for="(pin, index) in pins" :key="pin.message_id" type="button" class="message-pin-tick"
      data-pin-entry :data-pinned-message-id="pin.message_id" :tabindex="index === active ? 0 : -1"
      :aria-label="`Pinned message from ${senderLabel(pin.sender)}: ${previewText(pin.snippet)}`"
      :aria-describedby="previewId === pin.message_id ? tooltipId : undefined"
      :aria-current="selectedId === pin.message_id ? 'location' : undefined"
      :data-active="previewId === pin.message_id || selectedId === pin.message_id"
      @pointerenter="showPreview(pin.message_id, $event)" @focus="active = index; showPreview(pin.message_id, $event)"
      @blur="closePreview" @click="choose(pin.message_id)">
      <span aria-hidden="true" />
    </button>
    <button v-if="error" type="button" class="message-pin-retry" :aria-label="`${error} Retry loading pinned messages`"
      @click="$emit('refresh')">Retry</button>
    <Teleport to="body">
      <aside v-if="preview" :id="tooltipId" ref="panel" class="message-pin-preview" role="tooltip"
        :style="position" @pointerenter="cancelClose" @pointerleave="scheduleClose">
        <div class="message-pin-byline"><strong>{{ senderLabel(preview.sender) }}</strong><time :datetime="preview.timestamp">{{ timeLabel(preview.timestamp) }}</time></div>
        <p class="message-pin-snippet">{{ previewText(preview.snippet) }}</p>
        <span class="message-pin-attribution">Pinned by {{ preview.pinned_by.name }}</span>
        <span class="message-pin-hint">Click the marker to jump to this message</span>
        <p v-if="loading" role="status">Updating pins…</p>
        <p v-if="error" role="alert">{{ error }}</p>
      </aside>
    </Teleport>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import type { MessagePin } from "../message-pins.mjs";
import { usePinnedMessageVisibility } from "./usePinnedMessageVisibility";

const props = defineProps<{ pins: readonly MessagePin[]; loading?: boolean; error?: string | null }>();
const emit = defineEmits<{ reveal: [messageId: string]; refresh: [] }>();
const { pinnedMessagesHidden } = usePinnedMessageVisibility();
const rail = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const active = ref(0);
const selectedId = ref<string | null>(null);
const previewId = ref<string | null>(null);
const preview = computed(() => props.pins.find(pin => pin.message_id === previewId.value));
const tooltipId = `pin-preview-${useId()}`;
const left = ref(8), top = ref(8), maxHeight = ref(360);
const position = computed(() => ({ left: `${left.value}px`, top: `${top.value}px`, maxHeight: `${maxHeight.value}px` }));
let anchor: HTMLElement | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function place(): void {
  const bounds = anchor?.getBoundingClientRect();
  if (!bounds) return;
  const width = Math.min(340, window.innerWidth - 16);
  left.value = Math.max(8, Math.min(bounds.right + 8, window.innerWidth - width - 8));
  const height = panel.value?.offsetHeight || 180;
  top.value = Math.max(8, Math.min(bounds.top, window.innerHeight - height - 8));
  maxHeight.value = Math.max(0, window.innerHeight - top.value - 8);
}
function cancelClose(): void { clearTimeout(closeTimer); }
async function showPreview(id: string, event: Event): Promise<void> {
  cancelClose();
  anchor = event.currentTarget as HTMLElement;
  previewId.value = id;
  place();
  await nextTick();
  place();
}
function closePreview(): void { cancelClose(); previewId.value = null; anchor = null; }
function onRailScroll(): void {
  const bounds = anchor?.getBoundingClientRect();
  const viewport = rail.value?.getBoundingClientRect();
  if (anchor === document.activeElement && bounds && viewport && bounds.bottom > viewport.top && bounds.top < viewport.bottom) place();
  else closePreview();
}
function dismissOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  closePreview();
}
function scheduleClose(): void {
  cancelClose();
  closeTimer = setTimeout(() => {
    if (!rail.value?.contains(document.activeElement) && !panel.value?.contains(document.activeElement)) closePreview();
  }, 100);
}
function choose(id: string): void {
  selectedId.value = id;
  closePreview();
  emit("reveal", id);
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePreview(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !props.pins.length) return;
  event.preventDefault();
  active.value = event.key === "Home" ? 0 : event.key === "End" ? props.pins.length - 1
    : (active.value + (event.key === "ArrowDown" ? 1 : -1) + props.pins.length) % props.pins.length;
  rail.value?.querySelectorAll<HTMLButtonElement>("[data-pin-entry]")[active.value]?.focus();
}
function senderLabel(value: string): string { return value.split("|")[0].trim(); }
function previewText(value: string): string {
  return value.replace(/!?\[([^\]]*)\]\([^)]*(?:\)|$)/g, "$1").replace(/\*\*|__|~~|`+/g, "") || "Message without text";
}
function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
watch(previewId, (id) => {
  if (id) {
    window.addEventListener("resize", place);
    document.addEventListener("keydown", dismissOnEscape, true);
  } else {
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", dismissOnEscape, true);
  }
});
watch([() => props.pins.map(pin => pin.message_id), pinnedMessagesHidden], ([ids, hidden], [previousIds]) => {
  const focusWasInside = rail.value?.contains(document.activeElement) || panel.value?.contains(document.activeElement);
  const region = rail.value?.parentElement;
  if (hidden || !ids.includes(previewId.value || "")) closePreview();
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
  window.removeEventListener("resize", place);
  document.removeEventListener("keydown", dismissOnEscape, true);
});
</script>

<style>
.message-pin-rail { position: absolute; grid-area: 1 / 1 / 2 / 2; top: 12px; left: 4px; z-index: 4; display: flex; flex-direction: column; width: 32px; max-height: calc(100% - 24px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
.message-pin-rail::-webkit-scrollbar { display: none; }
.message-pin-tick { display: flex; align-items: center; flex: 0 0 24px; width: 32px; height: 24px; padding: 0 6px; border: 0; border-radius: 4px; background: transparent; color: var(--text-secondary); cursor: pointer; }
.message-pin-tick > span { width: 12px; height: 2px; border-radius: 2px; background: currentColor; opacity: .55; }
.message-pin-tick[data-active="true"] > span, .message-pin-tick:focus-visible > span { width: 20px; opacity: 1; }
.message-pin-tick:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
.message-pin-tick:active { background: var(--accent-active); }
.message-pin-retry { flex: 0 0 auto; border: 0; padding: 8px 0; border-radius: 4px; background: var(--bg-elevated); color: var(--text); font: inherit; font-size: 10px; cursor: pointer; }
.message-pin-retry:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
@media (hover: hover) and (pointer: fine) {
  .message-pin-tick:hover > span { width: 20px; opacity: 1; }
}
@media (pointer: coarse) { .message-pin-tick { flex-basis: 44px; height: 44px; } }
.message-pin-preview { position: fixed; z-index: 1200; box-sizing: border-box; width: min(340px, calc(100vw - 16px)); overflow-y: auto; overscroll-behavior: contain; padding: 14px; border: 1px solid var(--border-strong); border-radius: 10px; background: var(--bg-elevated); color: var(--text); box-shadow: var(--shadow-lg); font-family: var(--font-sans, inherit); font-size: 13px; }
.message-pin-byline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.message-pin-byline time, .message-pin-attribution, .message-pin-hint { font-size: 11px; color: var(--text-secondary); }
.message-pin-snippet { margin: 10px 0; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.message-pin-hint { display: block; margin-top: 8px; }
.message-pin-marker { display: inline-flex; vertical-align: middle; color: var(--text-secondary); margin-inline: 4px; }
.message-pin-marker svg { display: block; width: 13px; height: 13px; flex: 0 0 auto; }
</style>
