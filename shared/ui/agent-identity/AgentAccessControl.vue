<template>
  <div class="agent-access-control" :data-level="modelValue" :style="{ '--access-index': index, '--access-count': visibleOptions.length, '--access-steps': Math.max(1, visibleOptions.length - 1), '--access-color': colors[modelValue] || colors.read_only }">
    <div class="agent-access-track" aria-hidden="true"><span /></div>
    <div ref="group" class="agent-access-levels" role="radiogroup" aria-label="Agent access" @keydown="onKey">
      <button v-for="option in visibleOptions" :key="option.id" type="button" role="radio" :aria-checked="option.id === modelValue" :tabindex="option.id === modelValue ? 0 : -1" :disabled="option.status !== 'available'" :title="option.detail || option.description" @click="emit('update:modelValue', option.id)">
        <span class="agent-access-emblem"><svg class="access-ring" viewBox="0 0 80 80" aria-hidden="true"><path d="M40 5a35 35 0 0 0 0 70M40 5a35 35 0 0 1 0 70"/></svg><svg class="access-symbol" viewBox="0 0 32 32" aria-hidden="true">
          <template v-if="option.id === 'read_only'"><path d="M10 14v-4a6 6 0 0 1 12 0v4"/><rect x="7" y="14" width="18" height="14" rx="4"/><path d="M16 20v3"/></template>
          <template v-else-if="option.id === 'ask_before_write'"><path d="M9 15v-4a5 5 0 0 1 10 0v4"/><rect x="6" y="15" width="17" height="13" rx="4"/><path d="M14 20v3M21 3h6a3 3 0 0 1 3 3v5l-5 4v-3h-4a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/></template>
          <template v-else-if="option.id === 'auto_review'"><path d="M16 3.5C12.6 6.1 9.4 7.5 6 8.2v7.2C6 22 10.8 26.5 16 29c5.2-2.5 10-7 10-13.6V8.2c-3.4-.7-6.6-2.1-10-4.7Z"/><path class="access-verdict" pathLength="1" d="m11 16 3.5 3.5 6.5-7"/></template>
          <template v-else-if="option.id === 'sandboxed_write' "><path d="M6 8h20v18H6ZM10 4h12M11 15l-3 3 3 3m10-6 3 3-3 3"/></template>
          <template v-else><path class="access-open" d="M22 14v-4a6 6 0 0 0-12 0v2"/><rect x="7" y="14" width="18" height="14" rx="4"/><path class="access-out" d="M12 21h8m-3-3 3 3-3 3"/></template>
        </svg></span><span>{{ option.label }}</span>
      </button>
    </div>
    <p v-if="selected" class="agent-access-description">{{ selected.status === 'available' ? selected.description : selected.detail || selected.description }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
const props = defineProps<{ modelValue: string; options: readonly { id: string; label: string; status: string; description: string; detail?: string | null }[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const colors: Record<string, string> = { read_only: '#9cbea9', ask_before_write: '#bdb4d7', sandboxed_write: '#b7bcd3', auto_review: '#bba5de', full_access: '#d8b48b' };
const order = ['read_only', 'ask_before_write', 'sandboxed_write', 'auto_review', 'full_access'];
const visibleOptions = computed(() => props.options.filter(option => option.id !== 'sandboxed_write' || option.status === 'available' || option.id === props.modelValue)
  .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
const group = ref<HTMLElement>();
const index = computed(() => Math.max(0, visibleOptions.value.findIndex(option => option.id === props.modelValue)));
const selected = computed(() => visibleOptions.value[index.value]);
function onKey(event: KeyboardEvent) {
  if (!['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) return;
  const available = visibleOptions.value.filter(option => option.status === 'available'); if (!available.length) return;
  event.preventDefault(); const current = available.findIndex(option => option.id === props.modelValue);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
  emit('update:modelValue', available[next].id); void nextTick(() => group.value?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus());
}
</script>
<style scoped>
.agent-access-control{position:relative;padding:22px 0 0}.agent-access-track{position:absolute;left:calc(50% / var(--access-count));right:calc(50% / var(--access-count));top:58px;height:3px;background:var(--border,#292929);border-radius:2px;overflow:hidden}.agent-access-track span{display:block;height:100%;width:calc(var(--access-index) * 100% / var(--access-steps));background:var(--access-color);transition:width 350ms cubic-bezier(.22,1,.36,1),background 250ms}.agent-access-levels{position:relative;display:grid;grid-template-columns:repeat(var(--access-count),minmax(0,1fr));gap:6px}.agent-access-levels button{min-width:0;display:flex;flex-direction:column;align-items:center;gap:12px;background:none;border:0;color:var(--text-secondary,#999);font:inherit;font-size:11px;cursor:pointer;padding:0 2px 8px}.agent-access-levels button:disabled{opacity:.4;cursor:not-allowed}.agent-access-levels button[aria-checked=true]{color:var(--text,#eee)}.agent-access-emblem{position:relative;display:grid;place-items:center;width:72px;height:72px;background:var(--bg,light-dark(#fff,#090909));border-radius:50%}.agent-access-emblem svg{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.access-ring{position:absolute;inset:0;width:100%;height:100%;opacity:0;transform:scale(.8);transition:opacity 200ms,transform 350ms cubic-bezier(.22,1,.36,1)}.access-symbol{width:33px;height:33px;transition:transform 300ms cubic-bezier(.22,1,.36,1),color 200ms}.agent-access-levels button[aria-checked=true] .access-ring{opacity:.8;transform:scale(1);color:var(--access-color)}.agent-access-levels button[aria-checked=true] .access-symbol{color:var(--access-color);transform:scale(1.12)}.agent-access-levels button[aria-checked=true] .access-verdict{animation:access-verdict 700ms ease both}.agent-access-levels button[aria-checked=true] .access-open{animation:access-unlock 600ms cubic-bezier(.22,1,.36,1) both;transform-origin:22px 14px}.agent-access-description{font-size:12px;color:var(--text-secondary,#999);margin:12px 0 0;line-height:1.5}.agent-access-levels button:focus-visible{outline:2px solid var(--text-secondary,#aaa);outline-offset:4px;border-radius:10px}@keyframes access-verdict{from{stroke-dasharray:1;stroke-dashoffset:1}to{stroke-dasharray:1;stroke-dashoffset:0}}@keyframes access-unlock{from{transform:rotate(-20deg)}to{transform:rotate(0)}}@media(max-width:430px){.agent-access-emblem{width:58px;height:58px}.agent-access-track{top:51px}.agent-access-levels button{font-size:10px}.access-symbol{width:29px;height:29px}}@media(prefers-reduced-motion:reduce){.agent-access-control *{animation:none!important;transition:none!important}}
</style>
