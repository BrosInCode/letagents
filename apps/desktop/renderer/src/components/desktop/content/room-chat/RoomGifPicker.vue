<template>
  <button v-if="enabled && trigger !== false" ref="triggerButton" type="button" class="room-gif-trigger" aria-label="Choose a GIF" title="Choose a GIF" :disabled="disabled" @click="open">GIF</button>
  <Teleport to="body">
    <dialog ref="dialog" class="room-gif-picker" aria-label="Choose a GIF" @close="closed">
      <header><strong>Choose a GIF</strong><button type="button" aria-label="Close GIF picker" @click="dialog?.close()">×</button></header>
      <div class="room-gif-search">
        <input v-model="query" type="search" maxlength="50" placeholder="Search GIPHY" aria-label="Search GIPHY" autofocus @keydown.enter.prevent.stop="search(0)" />
        <button type="button" :disabled="busy || !query.trim() || cooldown" @click="search(0)">{{ busy ? 'Searching…' : 'Search' }}</button>
      </div>
      <p v-if="error" role="status">{{ error }}</p>
      <p v-else-if="searched && !busy && !items.length" role="status">No GIFs found. Try another phrase, or send text.</p>
      <p v-else-if="!searched">Find a GIF for the moment. Your message draft stays here.</p>
      <div class="room-gif-grid" :aria-busy="busy">
        <button v-for="item in items" :key="item.id" type="button" :aria-label="item.title || 'Choose GIF'" @click="choose(item)">
          <img v-if="item.preview_url" :src="reducedMotion ? item.still_url ?? item.preview_url : item.preview_url" :alt="item.title || 'GIF'" loading="lazy" referrerpolicy="no-referrer" />
          <span v-else>{{ item.title || 'GIF preview unavailable' }}</span>
        </button>
      </div>
      <footer><a href="https://giphy.com" target="_blank" rel="noopener noreferrer"><img class="giphy-attribution" :src="giphyAttribution" alt="Powered by GIPHY" /></a><button v-if="nextOffset !== null && query === searchedQuery" type="button" :disabled="busy || cooldown" @click="search(nextOffset)">More</button></footer>
    </dialog>
  </Teleport>
</template>
<script setup lang="ts">
import giphyAttribution from "../../../../../../../../shared/ui/assets/powered-by-giphy.png";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { GiphyItem } from "../../../../../../../../shared/giphy-client.mjs";
import type { RoomGif } from "../../../../../../../../shared/room-expressions.mjs";
import { desktopIpc } from "../../../../ipc/index";
// Without its own trigger, a host opens the picker with open() and shows its own entry only while `enabled`.
const props = withDefaults(defineProps<{ roomIdentifier: string; disabled?: boolean; trigger?: boolean }>(), { trigger: true });
const emit = defineEmits<{ select: [gif: RoomGif]; closed: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const triggerButton = ref<HTMLButtonElement | null>(null);
const query = ref(""); const enabled = ref(false); const busy = ref(false);
const error = ref(""); const items = ref<GiphyItem[]>([]); const nextOffset = ref<number | null>(null);
const searched = ref(false); const cooldown = ref(false);
const searchedQuery = ref("");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let generation = 0; let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
async function load(): Promise<void> {
  const room = props.roomIdentifier;
  try { const setting = await desktopIpc.room.getExpressions(room); if (room === props.roomIdentifier) enabled.value = setting.enabled && setting.gif_provider_configured; }
  catch { if (room === props.roomIdentifier) enabled.value = false; }
}
async function open(): Promise<void> { if (props.disabled) return; await load(); if (enabled.value && !dialog.value?.open) dialog.value?.showModal(); }
function closed(): void { generation++; busy.value = false; items.value = []; nextOffset.value = null; searched.value = false; triggerButton.value?.focus(); emit("closed"); }
async function search(offset: number): Promise<void> {
  if (busy.value || cooldown.value || !query.value.trim()) return;
  const version = ++generation; busy.value = true; error.value = ""; searched.value = true; searchedQuery.value = query.value;
  try {
    const result = await desktopIpc.room.searchGifs(props.roomIdentifier, query.value, offset);
    if (version !== generation) return;
    if (result.ok) { items.value = result.items; nextOffset.value = result.next_offset; }
    else {
      items.value = []; nextOffset.value = null; error.value = result.message;
      if (result.retry_after_ms > 0) { cooldown.value = true; clearTimeout(cooldownTimer); cooldownTimer = setTimeout(() => { cooldown.value = false; }, result.retry_after_ms); }
    }
  } catch { if (version === generation) error.value = "GIFs are unavailable. You can keep writing or send text instead."; }
  finally { if (version === generation) busy.value = false; }
}
function choose(item: GiphyItem): void { emit("select", { provider: "giphy", id: item.id, title: item.title }); dialog.value?.close(); }
watch(() => props.roomIdentifier, () => { generation++; dialog.value?.close(); enabled.value = false; void load(); }, { immediate: true });
onMounted(() => { window.addEventListener("focus", load); window.addEventListener("letagents:expressions-changed", load); });
onBeforeUnmount(() => { generation++; clearTimeout(cooldownTimer); window.removeEventListener("focus", load); window.removeEventListener("letagents:expressions-changed", load); });
defineExpose({ open, enabled });
</script>
<style scoped>
.giphy-attribution { width: 100px; height: auto; padding: 2px 4px; border-radius: 3px; background: #202126; object-fit: contain; }
/* Matches .desktop-composer-attach; hosts may resize it with the custom properties. */
.room-gif-trigger {
  display: inline-grid; place-items: center; flex: none;
  width: var(--room-gif-trigger-size, 30px); height: var(--room-gif-trigger-size, 30px);
  margin: 0; padding: 0; border: 0; border-radius: var(--room-gif-trigger-radius, 9px);
  background: transparent; color: var(--text-secondary);
  font: inherit; font-size: 10px; font-weight: 700; line-height: 1; letter-spacing: 0.02em;
  cursor: pointer;
}
.room-gif-trigger:hover:not(:disabled) { background: var(--room-gif-trigger-hover-bg, color-mix(in srgb, var(--text) 10%, transparent)); color: var(--text); }
.room-gif-trigger:disabled { cursor: not-allowed; opacity: 0.48; }
.room-gif-picker { color: var(--text-primary, #e9e9ee); background: var(--bg-panel, #202126); border: 1px solid #7775; border-radius: 14px; width: min(470px, calc(100vw - 32px)); max-height: min(650px, 85vh); padding: 18px; box-shadow: 0 20px 80px #0006; }
.room-gif-picker::backdrop { background: #0006; }
header, footer, .room-gif-search { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
.room-gif-picker button, .room-gif-picker input { font: inherit; color: inherit; background: transparent; border: 1px solid #8886; border-radius: 6px; padding: 7px 10px; }
.room-gif-picker button { cursor: pointer; } .room-gif-picker button:disabled { opacity: .5; cursor: default; } .room-gif-picker input { min-width: 0; flex: 1; }
p { font-size: 13px; opacity: .8; }.room-gif-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-bottom: 14px; }
.room-gif-grid button { padding: 0; min-height: 80px; overflow: hidden; } .room-gif-grid img { display: block; width: 100%; height: 105px; object-fit: cover; }
footer { margin: 0; font-size: 12px; } a { color: inherit; }
</style>
