<template>
  <section class="agent-inspector-signal" :data-tone="tone" :data-moving="moving" :data-state="state" :aria-label="label">
    <span class="agent-inspector-signal-trace" aria-hidden="true"><span></span></span>
    <div class="agent-inspector-signal-copy">
      <div class="agent-inspector-signal-heading">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path v-if="state === 'compacting'" d="M3 3h10M3 6h10M3 10h10M3 13h10M6 1v2m4 10v2" />
          <path v-else-if="moving" d="M1 8h3l2-5 3 10 2-5h4" />
          <path v-else-if="tone === 'green'" d="m3 8 3 3 7-7" />
          <path v-else-if="tone === 'red' || tone === 'amber'" d="M8 2v7m0 3v1" />
          <path v-else d="M5 3v10M11 3v10" />
        </svg>
        <h3>{{ label }}</h3>
      </div>
      <p v-if="detail">{{ detail }}</p>
    </div>
    <div v-if="$slots.actions" class="agent-inspector-signal-actions"><slot name="actions" /></div>
    <div v-if="$slots.footer" class="agent-inspector-signal-footer"><slot name="footer" /></div>
  </section>
</template>
<script setup lang="ts">
defineProps<{
  label: string;
  detail?: string | null;
  state?: string;
  tone: 'green' | 'blue' | 'amber' | 'violet' | 'red' | 'neutral';
  moving?: boolean;
}>();
</script>
