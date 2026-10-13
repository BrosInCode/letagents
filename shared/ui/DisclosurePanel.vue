<template>
  <div class="disclosure" :data-open="open" :data-instant="instant || keyboardInstant">
    <button type="button" class="disclosure-trigger" :class="triggerClass"
      :aria-expanded="open" :aria-controls="id" :disabled="disabled" @click="toggle">
      <span class="disclosure-summary"><slot name="summary" /></span>
      <svg class="disclosure-caret" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m6 4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <ThreadTransition :instant="instant || keyboardInstant" @settled="emit('settled')">
      <div v-show="open" :id="id" class="disclosure-panel" :class="panelClass" :inert="!open" :aria-hidden="!open">
        <div class="disclosure-content"><slot /></div>
      </div>
    </ThreadTransition>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import ThreadTransition from './ThreadTransition.vue';
const props = defineProps<{ open: boolean; panelId?: string; triggerClass?: string; panelClass?: string; instant?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ toggle: [event: MouseEvent]; settled: [] }>();
const generatedId = useId();
const id = computed(() => props.panelId || `disclosure-${generatedId}`);
const keyboardInstant = ref(false);
function toggle(event: MouseEvent) {
  keyboardInstant.value = event.detail === 0;
  emit('toggle', event);
}
</script>
<style scoped>
.disclosure { min-width: 0; overflow-anchor: none; }
.disclosure-trigger {
  display: flex; align-items: center; gap: 14px; width: 100%; min-height: 44px;
  box-sizing: border-box; padding: var(--disclosure-padding, 14px 16px);
  border: 0; border-radius: 8px; background: transparent; color: inherit;
  text-align: left; font: inherit; cursor: pointer;
  transition: background-color 140ms ease;
}
.disclosure-trigger:focus-visible { outline: 2px solid var(--text-secondary, #97979f); outline-offset: -3px; }
.disclosure-trigger:active:not(:disabled) { background: var(--disclosure-hover, light-dark(#e9e9ea, #202022)); }
.disclosure-trigger:disabled { opacity: .5; cursor: default; }
.disclosure-summary { flex: 1; min-width: 0; }
.disclosure-caret { width: 12px; height: 12px; flex: 0 0 12px; color: var(--text-tertiary, #898991); transition: transform 180ms cubic-bezier(.22,1,.36,1); }
[aria-expanded=true] > .disclosure-caret { transform: rotate(90deg); }
.disclosure-panel, .disclosure-content { display: flow-root; min-width: 0; }
[data-instant=true] > .disclosure-trigger > .disclosure-caret { transition: none; }
@media (hover: hover) and (pointer: fine) {
  .disclosure-trigger:hover:not(:disabled) { background: var(--disclosure-hover, light-dark(#f0f0f0, #18181a)); }
}
@media (prefers-reduced-motion: reduce) { .disclosure-trigger, .disclosure-caret { transition: none; } }
</style>
