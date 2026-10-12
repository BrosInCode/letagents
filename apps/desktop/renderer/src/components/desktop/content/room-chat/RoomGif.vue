<template>
  <figure ref="host" class="room-gif">
    <img v-if="item && !failed && (!paused || item.still_url)" :src="paused ? item.still_url ?? undefined : item.image_url ?? undefined" :alt="gif.title || 'GIF'" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" @load="emit('available', true)" />
    <p v-else class="room-gif-fallback">{{ gif.title || 'GIF' }} <span v-if="failed">· Preview unavailable</span></p>
    <figcaption><a :href="roomGifPageUrl(gif) ?? undefined" target="_blank" rel="noopener noreferrer">View on GIPHY</a><img class="giphy-attribution" :src="giphyAttribution" alt="Powered by GIPHY" />
      <button v-if="item && !failed" type="button" @click="paused = !paused">{{ paused ? 'Play GIF' : 'Pause GIF' }}</button>
    </figcaption>
  </figure>
</template>
<script setup lang="ts">
import giphyAttribution from "../../../../../../../../shared/ui/assets/powered-by-giphy.png";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { roomGifPageUrl, type RoomGif } from "../../../../../../../../shared/room-expressions.mjs";
import type { GiphyItem } from "../../../../../../../../shared/giphy-client.mjs";
import { desktopIpc } from "../../../../ipc/index";
const props = defineProps<{ roomIdentifier?: string | null; gif: RoomGif }>();
const emit = defineEmits<{ available: [value: boolean] }>();
const host = ref<HTMLElement | null>(null); const item = ref<GiphyItem | null>(null); const failed = ref(false);
const paused = ref(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
let observer: IntersectionObserver | undefined; let generation = 0;
async function load(): Promise<void> {
  const version = ++generation; emit("available", false); item.value = null; failed.value = false;
  if (!props.roomIdentifier) { failed.value = true; return; }
  try {
    const result = await desktopIpc.room.resolveGif(props.roomIdentifier, props.gif.id);
    if (version !== generation) return;
    if (result.ok && result.items[0]?.image_url) item.value = result.items[0]; else failed.value = true;
  } catch { if (version === generation) failed.value = true; }
}
function observe(): void {
  observer?.disconnect(); emit("available", false);
  observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); } });
  if (host.value) observer.observe(host.value);
}
watch(paused, value => { if (value && !item.value?.still_url) emit("available", false); });
watch(failed, value => { if (value) emit("available", false); });
watch(() => [props.roomIdentifier, props.gif.id], () => { generation++; item.value = null; observe(); });
onMounted(observe);
onBeforeUnmount(() => { generation++; observer?.disconnect(); });
</script>
<style scoped>
.giphy-attribution { width: 100px; height: auto; border-radius: 0; object-fit: contain; }
.room-gif { margin: 8px 0; max-width: 320px; } img { display: block; max-width: 100%; max-height: 260px; border-radius: 9px; object-fit: contain; }
.room-gif-fallback { padding: 16px; border: 1px solid #8884; border-radius: 9px; font-size: 13px; }
figcaption { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 5px; font-size: 10px; opacity: .7; }
a { color: inherit; } button { color: inherit; font: inherit; background: none; border: 0; text-decoration: underline; cursor: pointer; }
</style>
