import { computed, onScopeDispose, reactive, ref, watch } from "vue";
import type { MyWorkCard, MyWorkPage } from "../../ticket-connectors.mjs";
import type { MyWorkApi, WorkQuery } from "./types";
import {
  myWorkCardKey,
  myWorkRefreshDelay,
  roomsWithChangedTasks,
  type MyWorkFilters,
} from "./model";

/** Mounted only while My work is visible. Reads follow account events, never a polling interval. */
export function useMyWork(props: {
  api: MyWorkApi;
  tasksChangedAt?: Readonly<Record<string, string | null>>;
  connected?: boolean;
}) {
  const page = ref<MyWorkPage | null>(null),
    cards = ref<MyWorkCard[]>([]);
  const nextCursor = ref<string | null>(null),
    loading = ref(false),
    error = ref("");
  const filters = reactive<MyWorkFilters>({
    tracker: "",
    roomId: "",
    needsMe: false,
  });
  const knownRooms = reactive(new Map<string, string>());
  let generation = 0,
    pagesLoaded = 1,
    lastReadAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null,
    timerDueAt = 0;
  const query = (cursor: string | null): WorkQuery => ({
    cursor,
    limit: 50,
    tracker: filters.tracker || null,
    roomId: filters.roomId || null,
    needsMe: filters.needsMe,
    includeCompleted: true,
  });
  function remember(list: MyWorkCard[]) {
    for (const card of list) knownRooms.set(card.room_id, card.room_name);
  }
  function mergeCards(next: MyWorkCard[], reset: boolean) {
    const old = new Map(cards.value.map((card) => [myWorkCardKey(card), card]));
    const incoming = new Map(next.map((card) => [myWorkCardKey(card), card]));
    const keys = reset
      ? [...incoming.keys()]
      : [...old.keys()]
          .filter((key) => incoming.has(key))
          .concat([...incoming.keys()].filter((key) => !old.has(key)));
    cards.value = keys.map((key) => {
      const card = incoming.get(key)!;
      const previous = old.get(key);
      return previous && JSON.stringify(previous) === JSON.stringify(card)
        ? previous
        : card;
    });
    remember(cards.value);
  }
  async function reload(resetOrder = false) {
    if (timer) clearTimeout(timer);
    timer = null;
    const request = ++generation;
    loading.value = true;
    lastReadAt = Date.now();
    try {
      // Refresh every loaded page, retaining the loaded range and its cursor (each request stays bounded).
      let cursor: string | null = null,
        first: MyWorkPage | null = null;
      const next: MyWorkCard[] = [];
      const targetPages = pagesLoaded;
      for (let i = 0; i < targetPages; i++) {
        const result = await props.api.read(query(cursor));
        if (request !== generation) return;
        first ||= result;
        next.push(...result.cards);
        cursor = result.next_cursor;
        if (!cursor) break;
      }
      page.value = first;
      mergeCards(next, resetOrder);
      nextCursor.value = cursor;
      error.value = "";
    } catch (cause) {
      if (request === generation)
        error.value =
          cause instanceof Error
            ? cause.message
            : "My work could not be loaded.";
    } finally {
      if (request === generation) loading.value = false;
    }
  }
  async function loadMore() {
    if (!nextCursor.value || loading.value) return;
    const request = ++generation;
    loading.value = true;
    try {
      const next = await props.api.read(query(nextCursor.value));
      if (request !== generation) return;
      mergeCards([...cards.value, ...next.cards], false);
      nextCursor.value = next.next_cursor;
      pagesLoaded++;
      error.value = "";
    } catch (cause) {
      if (request === generation)
        error.value =
          cause instanceof Error
            ? cause.message
            : "More work could not be loaded.";
    } finally {
      if (request === generation) loading.value = false;
    }
  }
  function schedule(changed: readonly string[]) {
    const delay = myWorkRefreshDelay(
      changed,
      new Set(cards.value.map((card) => card.room_id)),
      lastReadAt,
      Date.now(),
    );
    const due = Date.now() + delay;
    if (timer && timerDueAt <= due) return;
    if (timer) clearTimeout(timer);
    timerDueAt = due;
    timer = setTimeout(() => {
      timer = null;
      void reload();
    }, delay);
  }
  watch(
    () => props.tasksChangedAt,
    (stamps, previous) => {
      const changed = roomsWithChangedTasks(stamps || {}, previous);
      if (changed.length) schedule(changed);
    },
  );
  watch(
    () => props.connected,
    (connected, previous) => {
      if (connected && previous === false)
        schedule(cards.value.map((card) => card.room_id));
    },
  );
  watch(
    () => [filters.tracker, filters.roomId, filters.needsMe],
    () => {
      cards.value = [];
      nextCursor.value = null;
      pagesLoaded = 1;
      void reload();
    },
  );
  void reload();
  onScopeDispose(() => {
    generation++;
    if (timer) clearTimeout(timer);
  });
  const roomOptions = computed(() =>
    [...knownRooms]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  );
  return {
    page,
    cards,
    nextCursor,
    loading,
    error,
    filters,
    roomOptions,
    reload,
    loadMore,
  };
}
