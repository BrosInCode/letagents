<template>
  <div class="agent-brain-studio" role="img" :aria-label="`${providerName} brain illustration`">
    <div ref="host" class="agent-brain-canvas" />
    <svg v-if="failed" class="agent-brain-fallback" viewBox="0 0 80 80" aria-hidden="true"><path d="M39 64V17c-5-12-22-8-23 4C5 23 3 37 11 43c-5 13 6 25 16 21 4 6 9 5 12 0Zm2 0V17c5-12 22-8 23 4 11 2 13 16 5 22 5 13-6 25-16 21-4 6-9 5-12 0Z"/><path d="M16 21c5 0 12 4 11 11M11 43c9-3 14 2 14 10m39-32c-5 0-12 4-11 11m16 11c-9-3-14 2-14 10M27 32l12 8m14-8-12 8"/></svg>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BrainPreview } from './scene/brain-3d';
const props = withDefaults(defineProps<{ provider: string | null; providerName: string; model: string; effort: string; active?: boolean; animate?: boolean }>(), { active: true, animate: true });
const host = ref<HTMLElement>(); const failed = ref(false); let preview: BrainPreview | undefined;
let disposed = false; let media: MediaQueryList | undefined;
// Explicit visual editions from the approved demo. Unknown models/providers
// remain unclassified; price is never interpreted as capability.
const editions: Record<string, Record<string, number>> = {
  codex: { 'gpt-6-luna': 0, 'gpt-6.1-sol': 2, 'gpt-6-astra': 3 },
  'claude-code': { 'claude-fable-5': 3, opus: 2, 'opus[1m]': 2, sonnet: 1, 'sonnet[1m]': 1, haiku: 0 },
};
function sync() {
  const animate = props.animate && !media?.matches;
  const provider = props.provider || '';
  preview?.setState({ active: props.active, animate });
  preview?.setSelection(({ codex: 0, 'claude-code': 1, cursor: 2, antigravity: 3 } as Record<string, number>)[provider] ?? 4);
  preview?.setCapability(editions[provider]?.[props.model.replace(/^option:/, '')] ?? null, { immediate: !animate });
  preview?.setEffort(props.effort, { immediate: !animate });
}
onMounted(async () => {
  media = matchMedia('(prefers-reduced-motion: reduce)'); media.addEventListener('change', sync);
  try { const module = await import('./scene/brain-3d.js'); if (disposed || !host.value) return;
    const value = await module.createBrainPreview(host.value, { onUnavailable: () => { failed.value = true; } });
    if (disposed) { value.dispose(); return; } preview = value; sync();
  } catch { if (!disposed) failed.value = true; }
});
watch(() => [props.provider, props.model, props.effort, props.active, props.animate], sync);
onBeforeUnmount(() => { disposed = true; media?.removeEventListener('change', sync); preview?.dispose(); });
</script>
<style scoped>
.agent-brain-studio{position:relative;height:250px;overflow:hidden;border-radius:24px;background:radial-gradient(ellipse at 50% 60%,light-dark(#e4e3df,#191918),transparent 72%)}.agent-brain-canvas{position:absolute;inset:0}.agent-brain-canvas :deep(canvas){width:100%;height:100%;display:block}.agent-brain-fallback{position:absolute;height:150px;width:150px;top:50px;left:calc(50% - 75px);fill:var(--bg-card,#151515);stroke:var(--text-secondary,#aaa);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}@media(max-width:520px){.agent-brain-studio{height:210px}}
</style>
