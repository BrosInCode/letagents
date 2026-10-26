import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import type { GiphyItem, GiphyResult } from "../../../../../../../../shared/giphy-client.mjs";
import { desktopIpc } from "../../../../ipc/index";

/** Quick searches shown before anything is typed. */
export const GIF_QUICK_TERMS = Object.freeze(["thumbs up", "ship it", "lgtm", "on it", "nice", "facepalm"]);
export const GIF_SEARCH_DEBOUNCE_MS = 250;
const MAX_QUERY_LENGTH = 50;
// The GIPHY client refuses offsets above this.
const MAX_OFFSET = 4999;
// Same wording as shared/giphy-client.mjs; a thrown IPC call never reaches the client.
const UNAVAILABLE = "GIFs are unavailable right now. You can send text instead.";
const INVALID_QUERY = "Use a GIF search of 1–50 characters.";

export interface RoomGifSearchOptions {
  search: (query: string, offset: number) => Promise<GiphyResult>;
  debounceMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Live GIF search: a short debounce while typing, one answer per query (a late
 * answer for an older query is dropped), paging by `next_offset`, and no
 * requests while GIPHY asks us to wait (`retry_after_ms`).
 */
export function createRoomGifSearch(options: RoomGifSearchOptions) {
  const debounceMs = options.debounceMs ?? GIF_SEARCH_DEBOUNCE_MS;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const query = ref("");
  const items = shallowRef<GiphyItem[]>([]);
  /** A first page is on its way (or waits for the debounce). */
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref("");
  const nextOffset = ref<number | null>(null);
  const coolingDown = ref(false);

  // Each new query moves the generation; an answer for an older one is dropped.
  let generation = 0;
  let debounceTimer: unknown = null;
  let cooldownTimer: unknown = null;
  let cooldownMessage = "";
  let disposed = false;

  function cancelDebounce(): void {
    if (debounceTimer !== null) clearTimer(debounceTimer);
    debounceTimer = null;
  }

  function setQuery(value: string, { immediate = false } = {}): void {
    query.value = value;
    cancelDebounce();
    generation++;
    // A new query never shows the old results, so Enter can only add a result for what is typed.
    items.value = [];
    nextOffset.value = null;
    loadingMore.value = false;
    error.value = "";
    const trimmed = value.trim();
    if (!trimmed || disposed) {
      loading.value = false;
      return;
    }
    if (value.length > MAX_QUERY_LENGTH) {
      loading.value = false;
      error.value = INVALID_QUERY;
      return;
    }
    loading.value = true;
    const version = generation;
    if (immediate) void run(version, trimmed, 0);
    else debounceTimer = setTimer(() => { debounceTimer = null; void run(version, trimmed, 0); }, debounceMs);
  }

  function loadMore(): void {
    const offset = nextOffset.value;
    const trimmed = query.value.trim();
    if (disposed || loading.value || loadingMore.value || coolingDown.value || offset === null || !trimmed) return;
    loadingMore.value = true;
    void run(generation, trimmed, offset);
  }

  function startCooldown(ms: number, message: string): void {
    coolingDown.value = true;
    cooldownMessage = message;
    if (cooldownTimer !== null) clearTimer(cooldownTimer);
    cooldownTimer = setTimer(() => {
      cooldownTimer = null;
      coolingDown.value = false;
      // A search that the wait refused runs once more by itself; a shown page can page again.
      if (!disposed && !items.value.length && query.value.trim()) setQuery(query.value, { immediate: true });
    }, ms);
  }

  async function run(version: number, trimmed: string, offset: number): Promise<void> {
    const first = offset === 0;
    if (coolingDown.value) {
      if (first) loading.value = false;
      else loadingMore.value = false;
      error.value = cooldownMessage;
      return;
    }
    let result: GiphyResult;
    try {
      result = await options.search(trimmed, offset);
    } catch {
      result = { ok: false, code: "unavailable", message: UNAVAILABLE, retry_after_ms: 0 };
    }
    if (version !== generation || disposed) return;
    if (first) loading.value = false;
    else loadingMore.value = false;
    if (result.ok) {
      const seen = new Set(items.value.map(item => item.id));
      // GIPHY pages can overlap; a GIF shows once.
      const fresh = result.items.filter(item => !seen.has(item.id) && seen.add(item.id));
      items.value = first ? fresh : [...items.value, ...fresh];
      error.value = "";
      nextOffset.value = result.next_offset !== null && result.next_offset <= MAX_OFFSET ? result.next_offset : null;
      return;
    }
    error.value = result.message;
    if (first) items.value = [];
    if (result.retry_after_ms > 0) startCooldown(result.retry_after_ms, result.message);
    // Without a wait, the same page would fail again; stop paging.
    else nextOffset.value = null;
  }

  function dispose(): void {
    disposed = true;
    generation++;
    cancelDebounce();
    if (cooldownTimer !== null) clearTimer(cooldownTimer);
    cooldownTimer = null;
  }

  return { query, items, loading, loadingMore, error, nextOffset, coolingDown, setQuery, loadMore, dispose };
}

export type RoomGifSearch = ReturnType<typeof createRoomGifSearch>;

/**
 * Where keyboard focus goes from a GIF tile in a grid of `columns` columns.
 * Returns a tile index, "search" for the search box, or null for keys the grid does not use.
 */
export function gifGridTarget(index: number, key: string, count: number, columns = 3): number | "search" | null {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowRight": return Math.min(index + 1, last);
    case "ArrowLeft": return index - 1 < 0 ? "search" : index - 1;
    case "ArrowDown": return Math.min(index + columns, last);
    case "ArrowUp": return index - columns < 0 ? "search" : index - columns;
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}

/** `/gif <query>` in the composer opens the GIF panel; returns the query ("" for a bare `/gif`), else null. */
export function gifCommandQuery(text: string): string | null {
  const match = /^\/gif(?:\s+([^\r\n]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? "").trim().slice(0, MAX_QUERY_LENGTH) : null;
}

/** The still frame under reduced motion, else the moving preview. */
export function gifPreviewSource(item: Pick<GiphyItem, "preview_url" | "still_url">, reducedMotion: boolean): string | null {
  return (reducedMotion ? item.still_url ?? item.preview_url : item.preview_url ?? item.still_url) ?? null;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** Whether this room may send GIFs: the room setting is on and GIPHY is set up. */
export function useRoomGifAvailability(roomIdentifier: () => string | null | undefined) {
  const enabled = ref(false);
  async function load(): Promise<void> {
    const room = roomIdentifier();
    if (!room) { enabled.value = false; return; }
    try {
      const setting = await desktopIpc.room.getExpressions(room);
      if (room === roomIdentifier()) enabled.value = setting.enabled && setting.gif_provider_configured;
    } catch {
      if (room === roomIdentifier()) enabled.value = false;
    }
  }
  watch(roomIdentifier, () => { enabled.value = false; void load(); }, { immediate: true });
  onMounted(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("focus", load);
    window.addEventListener("letagents:expressions-changed", load);
  });
  onBeforeUnmount(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("focus", load);
    window.removeEventListener("letagents:expressions-changed", load);
  });
  return { enabled, load };
}
