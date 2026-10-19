<template>
  <figure ref="host" class="room-gif">
    <div class="room-gif-frame" :class="{ 'is-ready': state === 'ready', 'is-unavailable': state === 'unavailable' }" :aria-busy="state === 'loading'">
      <img v-if="mediaUrl && !failed" ref="media" class="room-gif-media" :class="{ 'is-ready': loaded }" :src="mediaUrl" :alt="gif.title || 'GIF'" :aria-hidden="!loaded" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="mediaFailed" @load="mediaLoaded" />
      <div v-if="state === 'loading'" class="room-gif-placeholder" aria-hidden="true"></div>
      <p v-else-if="state === 'unavailable'" class="room-gif-fallback">{{ gif.title || 'GIF' }} · {{ failed ? 'Preview unavailable' : 'Paused' }}</p>
    </div>
    <figcaption><a :href="roomGifPageUrl(gif) ?? undefined" target="_blank" rel="noopener noreferrer">View on GIPHY</a><img class="giphy-attribution" :src="giphyAttribution" alt="Powered by GIPHY" />
      <button v-if="item && !failed" type="button" @click="paused = !paused">{{ paused ? 'Play GIF' : 'Pause GIF' }}</button>
    </figcaption>
  </figure>
</template>
<script setup lang="ts">
import giphyAttribution from "../../../../../../../../shared/ui/assets/powered-by-giphy.png";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { roomGifPageUrl, type RoomGif } from "../../../../../../../../shared/room-expressions.mjs";
import type { GiphyItem } from "../../../../../../../../shared/giphy-client.mjs";
import { desktopIpc } from "../../../../ipc/index";
const props = defineProps<{ roomIdentifier?: string | null; gif: RoomGif }>();
const emit = defineEmits<{ state: [value: 'loading' | 'ready' | 'unavailable'] }>();
const host = ref<HTMLElement | null>(null); const item = ref<GiphyItem | null>(null); const failed = ref(false);
const media = ref<HTMLImageElement | null>(null); const loaded = ref(false);
const paused = ref(typeof window !== 'undefined' && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
const mediaUrl = computed(() => (paused.value ? item.value?.still_url : item.value?.image_url) || undefined);
const state = computed(() => failed.value || (item.value && !mediaUrl.value) ? 'unavailable' : loaded.value ? 'ready' : 'loading');
let observer: IntersectionObserver | undefined; let generation = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
function mediaLoaded(event: Event): void {
  if (event.target === media.value) { clearTimeout(previewTimer); loaded.value = true; }
}
function mediaFailed(event: Event): void {
  if (event.target === media.value) { clearTimeout(previewTimer); failed.value = true; }
}
async function load(): Promise<void> {
  clearTimeout(previewTimer);
  const version = ++generation; item.value = null; failed.value = false; loaded.value = false;
  if (!props.roomIdentifier) { failed.value = true; return; }
  // A stalled metadata request or media host may never produce an error event.
  // End this preview attempt without retries; retain the normal GIPHY link.
  previewTimer = setTimeout(() => {
    if (version !== generation || loaded.value) return;
    generation++; failed.value = true;
  }, 15_000);
  try {
    const result = await desktopIpc.room.resolveGif(props.roomIdentifier, props.gif.id);
    if (version !== generation) return;
    if (result.ok && result.items[0]?.image_url) item.value = result.items[0]; else failed.value = true;
  } catch { if (version === generation) failed.value = true; }
  if (failed.value) clearTimeout(previewTimer);
}
function observe(): void {
  observer?.disconnect();
  observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); } });
  if (host.value) observer.observe(host.value);
}
watch(mediaUrl, (_value, previous) => { if (!previous) loaded.value = false; }, { flush: 'sync' });
watch(state, value => emit('state', value), { immediate: true });
watch([() => props.roomIdentifier, () => props.gif.id], () => { clearTimeout(previewTimer); generation++; item.value = null; failed.value = false; loaded.value = false; observe(); });
onMounted(observe);
onBeforeUnmount(() => { clearTimeout(previewTimer); generation++; observer?.disconnect(); });
</script>
<style scoped>
.giphy-attribution { width: 100px; height: auto; padding: 2px 4px; border-radius: 3px; background: #202126; object-fit: contain; }
.room-gif { margin: 8px 0; width: 320px; max-width: 100%; }
.room-gif-frame { position: relative; aspect-ratio: 4 / 3; overflow: hidden; border-radius: 9px; background: color-mix(in srgb, currentColor 5%, transparent); }
.room-gif-frame.is-ready { background: transparent; }
.room-gif-frame.is-unavailable { aspect-ratio: auto; padding: 10px 12px; }
.room-gif-media { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: scale-down; opacity: 0; transition: opacity 120ms ease; }
.room-gif-media.is-ready { opacity: 1; }
.room-gif-placeholder, .room-gif-fallback { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; font-size: 12px; color: var(--text-muted, #888); }
.room-gif-placeholder { background: linear-gradient(120deg, transparent, #8881, transparent); }
.is-unavailable .room-gif-fallback { position: static; display: block; }
@media (prefers-reduced-motion: reduce) { .room-gif-media { transition: none; } }
figcaption { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; min-height: 18px; margin-top: 5px; font-size: 10px; opacity: .7; }
a { color: inherit; } button { color: inherit; font: inherit; background: none; border: 0; margin: 0; padding: 0; text-decoration: underline; cursor: pointer; }
</style>
