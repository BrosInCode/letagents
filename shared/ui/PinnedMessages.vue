<template>
  <div v-if="pins.length" class="message-pins-row">
    <button ref="trigger" type="button" class="message-pins-trigger" aria-haspopup="dialog"
      :aria-expanded="open" @click="toggle">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 3 21 8M17 4 9 12 5 13 11 19 12 15 20 7M2 22 8 16" />
      </svg>
      Pinned ({{ pins.length }})
    </button>
    <Teleport to="body">
      <section v-if="open" ref="panel" class="message-pins-panel" role="dialog" aria-label="Pinned messages"
        :style="position" @keydown="onKeydown">
        <p v-if="loading" role="status">Updating pins…</p>
        <p v-if="error" role="alert">{{ error }} <button type="button" @click="$emit('refresh')">Retry</button></p>
        <ol aria-label="Pinned messages">
          <li v-for="(pin, index) in pins" :key="pin.message_id">
            <button type="button" data-pin-entry :tabindex="index === active ? 0 : -1"
              @focus="active = index" @click="choose(pin.message_id)">
              <span class="message-pin-byline"><strong>{{ pin.sender }}</strong> <time :datetime="pin.timestamp">{{ timeLabel(pin.timestamp) }}</time></span>
              <span class="message-pin-snippet">{{ pin.snippet || 'Message without text' }}</span>
              <span class="message-pin-attribution">Pinned by {{ pin.pinned_by.name }}</span>
            </button>
          </li>
        </ol>
      </section>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { MessagePin } from "../message-pins.mjs";

const props = defineProps<{ pins: readonly MessagePin[]; loading?: boolean; error?: string | null }>();
const emit = defineEmits<{ reveal: [messageId: string]; refresh: [] }>();
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(0);
const left = ref(8);
const top = ref(8);
const maxHeight = ref(360);
const position = computed(() => ({ left: `${left.value}px`, top: `${top.value}px`, maxHeight: `${maxHeight.value}px` }));
function place(): void {
  const bounds = trigger.value?.getBoundingClientRect();
  if (!bounds) return;
  left.value = Math.max(8, Math.min(bounds.left, window.innerWidth - Math.min(420, window.innerWidth - 16) - 8));
  top.value = Math.min(bounds.bottom + 4, window.innerHeight - 80);
  maxHeight.value = Math.max(64, Math.min(360, window.innerHeight - top.value - 8));
}
function focusEntry(): void {
  panel.value?.querySelectorAll<HTMLButtonElement>("[data-pin-entry]")[active.value]?.focus();
}
async function toggle(): Promise<void> {
  if (open.value) { close(); return; }
  active.value = 0;
  place();
  open.value = true;
  await nextTick();
  focusEntry();
}
function close(restoreFocus = true): void {
  open.value = false;
  if (restoreFocus) trigger.value?.focus();
}
function choose(id: string): void { close(); emit("reveal", id); }
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); return; }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  active.value = event.key === "Home" ? 0 : event.key === "End" ? props.pins.length - 1
    : (active.value + (event.key === "ArrowDown" ? 1 : -1) + props.pins.length) % props.pins.length;
  focusEntry();
}
function outside(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (target && !trigger.value?.contains(target) && !panel.value?.contains(target)) { close(false); }
}
function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}
watch(open, (value) => {
  if (value) {
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
  } else cleanup();
}, { flush: "sync" });
watch(() => props.pins.length, (length) => {
  if (!length) {
    const region = trigger.value?.parentElement?.parentElement;
    const focusWasInside = panel.value?.contains(document.activeElement) || document.activeElement === trigger.value;
    close(false);
    if (focusWasInside && region) {
      region.tabIndex = -1;
      void nextTick(() => region.focus({ preventScroll: true }));
    }
  }
  else active.value = Math.min(active.value, length - 1);
});
function cleanup(): void {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", place);
}
onBeforeUnmount(cleanup);
</script>

<style>
.message-pins-row { flex: 0 0 auto; position: relative; padding: 3px 12px; border-bottom: 1px solid var(--border); }
.message-pins-trigger { display: inline-flex; align-items: center; gap: 5px; border: 0; border-radius: 4px; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer; padding: 4px; }
.message-pins-panel { position: fixed; z-index: 1200; box-sizing: border-box; width: min(420px, calc(100vw - 16px)); overflow-y: auto; overscroll-behavior: contain; padding: 8px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); color: var(--text); box-shadow: var(--shadow-lg); font-family: var(--font-sans, inherit); font-size: 13px; }
.message-pins-panel ol { list-style: none; margin: 0; padding: 0; }
.message-pins-panel [data-pin-entry] { display: flex; flex-direction: column; gap: 4px; width: 100%; border: 0; border-radius: 4px; background: transparent; color: inherit; font: inherit; text-align: left; padding: 9px; cursor: pointer; }
.message-pins-trigger:focus-visible, .message-pins-panel button:focus-visible { outline: 2px solid var(--blue); outline-offset: -2px; }
@media (hover: hover) and (pointer: fine) {
  .message-pins-trigger:hover, .message-pins-panel [data-pin-entry]:hover { background: var(--accent-hover); color: var(--text); }
}
.message-pins-trigger:active, .message-pins-panel [data-pin-entry]:active { background: var(--accent-active); color: var(--text); }
.message-pin-byline { display: flex; flex-wrap: wrap; gap: 8px; }
.message-pin-byline time, .message-pin-attribution { font-size: 11px; color: var(--text-secondary); }
.message-pin-snippet { overflow-wrap: anywhere; white-space: pre-wrap; }
.message-pin-marker { display: inline-flex; vertical-align: middle; color: var(--text-secondary); margin-inline: 4px; }
.message-pin-marker svg, .message-pins-trigger svg { display: block; width: 13px; height: 13px; flex: 0 0 auto; }
</style>
