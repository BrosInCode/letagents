<template>
  <div class="desktop-composer-gif-panel" role="dialog" aria-label="GIFs" data-testid="desktop-composer-gif-panel">
    <label class="desktop-composer-gif-search">
      <Search :size="15" aria-hidden="true" />
      <input
        ref="input"
        type="search"
        :value="gifs.query.value"
        maxlength="50"
        placeholder="Search GIPHY"
        aria-label="Search GIPHY"
        autocomplete="off"
        spellcheck="false"
        data-testid="desktop-composer-gif-search"
        @input="gifs.setQuery(($event.target as HTMLInputElement).value)"
        @keydown="handleSearchKey"
      />
    </label>
    <div v-if="!searching" class="desktop-composer-gif-quick" role="group" aria-label="Suggested GIF searches">
      <button v-for="term in GIF_QUICK_TERMS" :key="term" type="button" @click="searchFor(term)">{{ term }}</button>
    </div>
    <p v-else-if="gifs.error.value && !gifs.items.value.length" class="desktop-composer-gif-message" role="status">{{ gifs.error.value }}</p>
    <p v-else-if="!gifs.loading.value && !gifs.items.value.length" class="desktop-composer-gif-message" role="status">
      No GIFs found. Try another phrase, or send text.
    </p>
    <div
      v-if="searching && (gifs.loading.value || gifs.items.value.length)"
      ref="grid"
      class="desktop-composer-gif-grid"
      aria-label="GIF results"
      :aria-busy="gifs.loading.value || gifs.loadingMore.value"
      @scroll.passive="loadMoreNearEnd"
      @keydown="handleTileKey"
    >
      <template v-if="gifs.loading.value && !gifs.items.value.length">
        <span v-for="index in 9" :key="index" class="desktop-composer-gif-tile is-skeleton" aria-hidden="true"></span>
      </template>
      <button
        v-for="item in gifs.items.value"
        :key="item.id"
        type="button"
        class="desktop-composer-gif-tile"
        :aria-label="`${item.title || 'GIF'}, add to message`"
        data-testid="desktop-composer-gif-result"
        @click="emit('select', item)"
      >
        <img v-if="gifPreviewSource(item, reducedMotion)" :src="gifPreviewSource(item, reducedMotion) ?? undefined" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
        <span v-else>{{ item.title || "GIF" }}</span>
      </button>
      <p v-if="gifs.loadingMore.value" class="desktop-composer-gif-more">Loading…</p>
      <p v-else-if="gifs.error.value && gifs.items.value.length" class="desktop-composer-gif-more" role="status">{{ gifs.error.value }}</p>
    </div>
    <footer class="desktop-composer-gif-foot">
      <a href="https://giphy.com" target="_blank" rel="noopener noreferrer"><img class="giphy-attribution" :src="giphyAttribution" alt="Powered by GIPHY" /></a>
      <span v-if="gifs.items.value.length">Click to add · ↵ adds the first</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import giphyAttribution from "../../../../../../../../shared/ui/assets/powered-by-giphy.png";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Search } from "@lucide/vue";
import type { GiphyItem } from "../../../../../../../../shared/giphy-client.mjs";
import { desktopIpc } from "../../../../ipc/index";
import { createRoomGifSearch, GIF_QUICK_TERMS, gifGridTarget, gifPreviewSource, prefersReducedMotion } from "./room-gif-search";

const props = defineProps<{ roomIdentifier: string; initialQuery?: string }>();
const emit = defineEmits<{
  select: [item: GiphyItem];
  /** Escape in an empty search box: back to the "+" menu. */
  back: [];
}>();

const input = ref<HTMLInputElement | null>(null);
const grid = ref<HTMLElement | null>(null);
const reducedMotion = prefersReducedMotion();
const room = props.roomIdentifier;
const gifs = createRoomGifSearch({ search: (query, offset) => desktopIpc.room.searchGifs(room, query, offset) });
const searching = computed(() => Boolean(gifs.query.value.trim()));

function focusSearch(): void {
  input.value?.focus({ preventScroll: true });
}

function searchFor(term: string): void {
  gifs.setQuery(term, { immediate: true });
  focusSearch();
}

function tiles(): HTMLElement[] {
  return Array.from(grid.value?.querySelectorAll<HTMLElement>("button.desktop-composer-gif-tile") ?? []);
}

function handleSearchKey(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    const first = gifs.items.value[0];
    if (first) emit("select", first);
  } else if (event.key === "ArrowDown" && gifs.items.value.length) {
    event.preventDefault();
    tiles()[0]?.focus();
  } else if (event.key === "Escape") {
    // First Escape clears the search; the next goes back to the menu.
    event.preventDefault();
    event.stopPropagation();
    if (gifs.query.value) gifs.setQuery("");
    else emit("back");
  }
}

function handleTileKey(event: KeyboardEvent): void {
  const all = tiles();
  const index = all.indexOf(event.target as HTMLElement);
  if (index < 0) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    focusSearch();
    return;
  }
  const target = gifGridTarget(index, event.key, all.length);
  if (target === null) return;
  event.preventDefault();
  if (target === "search") focusSearch();
  else all[target]?.focus();
}

// The next page loads as the grid nears its end; there is no More button.
function loadMoreNearEnd(): void {
  const element = grid.value;
  if (element && element.scrollTop + element.clientHeight >= element.scrollHeight - 80) gifs.loadMore();
}

onMounted(() => {
  if (props.initialQuery?.trim()) gifs.setQuery(props.initialQuery, { immediate: true });
  void nextTick(focusSearch);
});
onBeforeUnmount(() => gifs.dispose());

defineExpose({ focusSearch });
</script>
