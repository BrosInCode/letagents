<template>
  <div class="agent-effort-control">
    <div class="agent-effort-label"><span :id="labelId">Reasoning effort</span><span>{{ selected?.label || 'Default' }}</span></div>
    <div ref="group" class="agent-effort-options" role="radiogroup" :aria-labelledby="labelId" :style="{ '--count': options.length, '--selected': index }" @keydown="onKey">
      <span class="agent-effort-selection" aria-hidden="true" />
      <button v-for="option in options" :key="option.value" type="button" role="radio" :aria-label="option.label" :aria-checked="option.value === modelValue" :tabindex="option.value === modelValue ? 0 : -1" :disabled="option.disabled" @click="emit('update:modelValue', option.value)">{{ option.value ? option.label : 'Default' }}</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
const props = defineProps<{ modelValue: string; options: readonly { value: string; label: string; disabled?: boolean }[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const group = ref<HTMLElement>(); const labelId = `agent-effort-${useId()}`;
const index = computed(() => Math.max(0, props.options.findIndex(option => option.value === props.modelValue)));
const selected = computed(() => props.options[index.value]);
function onKey(event: KeyboardEvent) {
  if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const options = props.options.filter(option => !option.disabled); if (!options.length) return;
  event.preventDefault(); const selectedIndex = options.findIndex(option => option.value === props.modelValue);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (selectedIndex + (['ArrowRight','ArrowDown'].includes(event.key) ? 1 : -1) + options.length) % options.length;
  emit('update:modelValue', options[next].value); void nextTick(() => group.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
}
</script>
<style scoped>
.agent-effort-label{display:flex;justify-content:space-between;gap:16px;margin-bottom:12px;font-size:13px}.agent-effort-label span+span{color:var(--text-secondary,#999)}.agent-effort-options{position:relative;isolation:isolate;display:grid;grid-template-columns:repeat(var(--count),minmax(0,1fr));padding:5px;border:1px solid var(--border,#272727);border-radius:16px;background:var(--bg-card,light-dark(#f4f4f3,#111))}.agent-effort-selection{position:absolute;z-index:-1;left:5px;top:5px;bottom:5px;width:calc((100% - 10px) / var(--count));transform:translateX(calc(var(--selected) * 100%));background:var(--bg-hover,light-dark(#e3e3e1,#252525));border:1px solid var(--border-accent,light-dark(#ccc,#444));border-radius:12px;box-sizing:border-box;transition:transform 280ms cubic-bezier(.22,1,.36,1)}.agent-effort-options button{min-width:0;min-height:42px;border:0;background:none;border-radius:10px;color:var(--text-secondary,#999);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}.agent-effort-options button[aria-checked=true]{color:var(--text,#eee)}.agent-effort-options button:focus-visible{outline:2px solid var(--text-secondary,#aaa);outline-offset:1px}.agent-effort-options:focus-within .agent-effort-selection{transition:none}@media(prefers-reduced-motion:reduce){.agent-effort-selection{transition:none}}@media(max-width:450px){.agent-effort-options button{font-size:10px;min-height:40px;padding:0 3px}}
</style>
