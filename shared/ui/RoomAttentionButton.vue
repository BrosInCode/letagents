<script setup lang="ts">
defineProps<{ count: number; pulse?: boolean }>();
defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
  <button v-if="count > 0" class="room-attention-button" :data-pulse="Boolean(pulse)" type="button" :aria-label="`Open Inbox, ${count} ${count === 1 ? 'request needs' : 'requests need'} you`" @click="$emit('click', $event)">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M3 4 1 7m20-3 2 3" /></svg>
    <span>Needs you</span>
    <span class="room-attention-count" aria-hidden="true">{{ count > 99 ? '99+' : count }}</span>
    <svg class="room-attention-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
  </button>
</template>

<style scoped>
.room-attention-button { position: relative; isolation: isolate; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; gap: 7px; min-height: 34px; padding: 0 11px; border: 1px solid #ffdaa0; border-radius: 7px; background: #f4c176; color: #33240f; box-shadow: inset 0 1px 0 #ffffff25; font: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: pointer; transition: background-color 140ms ease, transform 100ms ease; }
.room-attention-button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.room-attention-button > * { position: relative; }
.room-attention-button::before { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; background: #fff4df; opacity: 0; }
.room-attention-button[data-pulse="true"]::before { animation: room-attention-breathe 3.6s ease-in-out infinite; }
.room-attention-count { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 3px; border-radius: 50%; background: #33240f14; font-size: 10px; font-variant-numeric: tabular-nums; }
.room-attention-button:active { transform: scale(.98); }
.room-attention-button:focus-visible { outline: 2px solid #33240f; outline-offset: -4px; }
@keyframes room-attention-breathe { 0%, 100% { opacity: 0; } 50% { opacity: .22; } }
@media (hover: hover) and (pointer: fine) { .room-attention-button:hover { background: #ffca85; } }
@media (pointer: coarse) { .room-attention-button { min-height: 44px; } }
@media (max-width: 480px) { .room-attention-arrow { display: none; } }
@media (prefers-reduced-motion: reduce) { .room-attention-button::before { animation: none !important; } .room-attention-button { transition: none; } .room-attention-button:active { transform: none; } }
</style>
