<template>
  <button ref="trigger" class="board-icon-button" type="button" :aria-label="label" :disabled="disabled" :popovertarget="id" aria-haspopup="dialog" :aria-expanded="opened" @keydown.down.prevent="popup?.showPopover()"><BoardIcon :name="icon || 'more'" /></button>
  <div :id="id" ref="popup" class="board-options-menu" popover="auto" role="dialog" :aria-label="label" @toggle="toggle" @keydown="keydown" @focusout="focusout"><slot :close="close" /></div>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import BoardIcon from './BoardIcon.vue';
const props = defineProps<{ label: string; icon?: string; disabled?: boolean }>();
const id = `board-options-${useId()}`, trigger = ref<HTMLButtonElement>(), popup = ref<HTMLElement>(), opened = ref(false);
function close(restore = true) { popup.value?.hidePopover(); if (restore) trigger.value?.focus({ preventScroll: true }); }
function position() {
  if (!opened.value || !trigger.value || !popup.value) return;
  const rect = trigger.value.getBoundingClientRect(), menu = popup.value, edge = 12;
  menu.style.maxHeight = `${Math.max(0, window.innerHeight - edge * 2)}px`;
  menu.style.left = `${Math.max(edge, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - edge))}px`;
  menu.style.top = `${Math.max(edge, rect.bottom + menu.offsetHeight + 7 > window.innerHeight - edge ? rect.top - menu.offsetHeight - 7 : rect.bottom + 7)}px`;
}
function cleanup() { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); }
async function toggle(event: Event) {
  opened.value = (event as ToggleEvent).newState === 'open'; cleanup();
  if (!opened.value) return;
  await nextTick(); position(); popup.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
}
function focusout(event: FocusEvent) { if (event.relatedTarget instanceof Node && !popup.value?.contains(event.relatedTarget) && event.relatedTarget !== trigger.value) close(false); }
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...(popup.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
  if (!buttons.length) return;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}
watch(() => props.disabled, disabled => { if (disabled) close(false); });
onBeforeUnmount(cleanup);
</script>
