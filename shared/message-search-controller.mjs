// The client-side state of one room's history search, shared by the desktop
// and web apps. Framework-free: the app supplies the request and is told when
// something changed.
import { parseMessageSearchQuery } from "./message-search.mjs";

export const MESSAGE_SEARCH_DEBOUNCE_MS = 250;

const IDLE = Object.freeze({ status: "idle", terms: [], hits: [], hasMore: false, loadingMore: false, error: null });

export function createMessageSearchController({ search, onChange, debounceMs = MESSAGE_SEARCH_DEBOUNCE_MS }) {
  let state = IDLE;
  let query = "";
  let nextBefore = null;
  // Every new query (and reset) starts an epoch; answers from an earlier one are dropped.
  let epoch = 0;
  let timer = null;

  function set(next) {
    state = next;
    onChange?.();
  }

  function cancelTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  async function run(terms, startedIn) {
    try {
      const page = await search(query, null);
      if (startedIn !== epoch) return;
      nextBefore = page?.next_before ?? null;
      set({
        status: "ready",
        terms: Array.isArray(page?.terms) ? page.terms : terms,
        hits: Array.isArray(page?.messages) ? page.messages : [],
        hasMore: Boolean(page?.has_more && nextBefore),
        loadingMore: false,
        error: null,
      });
    } catch (error) {
      if (startedIn !== epoch) return;
      set({ ...IDLE, status: "error", terms, error: error instanceof Error && error.message ? error.message : "Search failed." });
    }
  }

  /** Search for a new query after a short pause in typing. */
  function setQuery(value) {
    const next = typeof value === "string" ? value : "";
    if (next.trim() === query.trim() && state !== IDLE) return;
    query = next;
    epoch += 1;
    cancelTimer();
    nextBefore = null;
    const parsed = parseMessageSearchQuery(query);
    if (parsed.error) {
      // Too short is simply "not searching yet"; the other limits are worth saying.
      set(parsed.error === "too_short" ? IDLE : { ...IDLE, status: "invalid", error: parsed.error });
      return;
    }
    const startedIn = epoch;
    set({ ...IDLE, status: "loading", terms: parsed.terms });
    timer = setTimeout(() => {
      timer = null;
      void run(parsed.terms, startedIn);
    }, debounceMs);
  }

  /** Read the next, older page of the current results. */
  async function loadMore() {
    if (state.status !== "ready" || !state.hasMore || state.loadingMore || !nextBefore) return;
    const startedIn = epoch;
    const before = nextBefore;
    set({ ...state, loadingMore: true, error: null });
    try {
      const page = await search(query, before);
      if (startedIn !== epoch) return;
      nextBefore = page?.next_before ?? null;
      const known = new Set(state.hits.map((hit) => hit.id));
      const more = (Array.isArray(page?.messages) ? page.messages : []).filter((hit) => !known.has(hit.id));
      set({ ...state, hits: [...state.hits, ...more], hasMore: Boolean(page?.has_more && nextBefore), loadingMore: false });
    } catch (error) {
      if (startedIn !== epoch) return;
      // Keep what is shown; the person can press "more" again.
      set({ ...state, loadingMore: false, error: error instanceof Error && error.message ? error.message : "Search failed." });
    }
  }

  /** Stop searching; call when the search closes or the room changes. */
  function reset() {
    query = "";
    epoch += 1;
    cancelTimer();
    nextBefore = null;
    if (state !== IDLE) set(IDLE);
  }

  return { get state() { return state; }, setQuery, loadMore, reset };
}
