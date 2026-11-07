<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ count: number; notification?: boolean }>();
const numberElement = ref<HTMLElement | null>(null);
const display = computed(() => props.count > 99 ? '99+' : Math.max(0, props.count));
let motion: MediaQueryList | undefined;
let animation: Animation | undefined;
function stop(): void { animation?.cancel(); animation = undefined; }
function visibilityChanged(): void { if (document.hidden) stop(); }
watch(() => props.count, (count, previous) => {
  stop();
  // Establish the initial count quietly; only a visible increase draws attention.
  if (count <= previous || (count > 99 && previous > 99) || motion?.matches || document.hidden) return;
  animation = numberElement.value?.animate?.([
    { opacity: .3, transform: 'translateY(4px) scale(.94)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' });
}, { flush: 'post' });
onMounted(() => {
  motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  motion?.addEventListener('change', stop);
  document.addEventListener('visibilitychange', visibilityChanged);
});
onBeforeUnmount(() => {
  stop();
  motion?.removeEventListener('change', stop);
  document.removeEventListener('visibilitychange', visibilityChanged);
});
</script>

<template>
  <span class="room-view-count" :class="{ notification, empty: notification && count <= 0 }" aria-hidden="true"><span ref="numberElement">{{ display }}</span></span>
</template>

<style scoped>
.room-view-count { display: grid; place-items: center; flex: 0 0 24px; width: 24px; height: 24px; margin-left: 7px; border-radius: 50%; background: var(--accent-hover); color: var(--text-secondary); font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1; }
.room-view-count > span { display: block; }
.room-view-count.notification { background: color-mix(in srgb, var(--blue) 14%, transparent); color: var(--blue-text, var(--blue)); }
.room-view-count.empty { visibility: hidden; }
</style>
