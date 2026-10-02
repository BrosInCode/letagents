import { computed, nextTick, onMounted, onScopeDispose, ref, watch, type Ref, type InjectionKey } from "vue";
import { canClearUnreadBookmark, createRoomUnreadStore } from "./room-unread.mjs";

export function createRoomUnreadClient(namespace: string) {
  const account = ref<string | null>(null);
  const revision = ref(0);
  const visit = ref({ room: "", account: null as string | null, revision: null as string | null, generation: 0, dividerId: null as string | null });
  const store = createRoomUnreadStore({
    namespace, storage: () => window.localStorage,
    changed: () => { revision.value++; },
  });
  if (typeof window !== "undefined") window.addEventListener("storage", event => {
    if (store.acceptsStorageEvent(event.key)) revision.value++;
  });
  function enter(room: string | null | undefined) {
    room = (room ?? "").trim().toLowerCase();
    if (visit.value.room === room && visit.value.account === account.value) return;
    visit.value = { room, account: account.value, revision: store.get(account.value, room)?.revision ?? null, generation: visit.value.generation + 1, dividerId: null };
  }
  watch(account, () => enter(visit.value.room), { flush: "sync" });
  return {
    account, visit, enter,
    get(room: string | null | undefined) {
      void revision.value;
      return store.get(account.value, room);
    },
    mark: (room: string | null | undefined, messageId: string) => store.mark(account.value, room, messageId),
    clear: (room: string | null | undefined, expected: string) => store.clear(account.value, room, expected),
  };
}
export type RoomUnreadClient = ReturnType<typeof createRoomUnreadClient>;
export const unreadMenuKey: InjectionKey<{ client: RoomUnreadClient; room: Readonly<Ref<string | null | undefined>> }> = Symbol("room-unread-menu");

export function useUnreadTimeline(options: {
  client: RoomUnreadClient;
  room: Readonly<Ref<string | null | undefined>>;
  active: Readonly<Ref<boolean>>;
  ready: Readonly<Ref<boolean>>;
  element: Ref<HTMLElement | null>;
  reveal(messageId: string): Promise<boolean>;
  bottom(reading?: boolean): void;
}) {
  const { client } = options;
  const bookmark = computed(() => client.get(options.room.value));
  const enteredRevision = ref<string | null>(null);
  const revealed = ref(false);
  let generation = 0;
  let started = false;
  let reading = false;
  let mounted = false;
  const dividerId = computed(() => client.visit.value.room === (options.room.value ?? "").trim().toLowerCase()
    ? client.visit.value.dividerId : null);

  function checkRead() {
    const el = options.element.value;
    if (!el || !options.active.value) return;
    if (canClearUnreadBookmark({
      enteredRevision: enteredRevision.value, current: bookmark.value, revealed: revealed.value,
      atBottom: el.scrollHeight - el.clientHeight - el.scrollTop < 60,
      visible: document.visibilityState === "visible", focused: document.hasFocus(),
    })) client.clear(options.room.value, enteredRevision.value!);
  }
  async function open() {
    if (!mounted || started || !options.active.value || !options.ready.value) return;
    started = true;
    const mark = bookmark.value;
    if (!mark || mark.revision !== enteredRevision.value) return;
    const currentGeneration = generation;
    const found = await options.reveal(mark.messageId);
    if (generation !== currentGeneration || bookmark.value?.revision !== mark.revision) return;
    revealed.value = found;
    if (found) client.visit.value.dividerId = mark.messageId;
    await nextTick();
    if (generation !== currentGeneration) return;
    if (!found) options.bottom();
    else checkRead(); // Later visit already at the bottom, visible and focused.
  }
  watch(() => [options.room.value, client.visit.value.generation, options.active.value], () => {
    generation++;
    enteredRevision.value = options.active.value
      && client.visit.value.room === (options.room.value ?? "").trim().toLowerCase()
      ? client.visit.value.revision : null;
    revealed.value = false;
    started = false;
    reading = false;
    void nextTick(open);
  }, { immediate: true, flush: "sync" });
  watch(options.ready, () => { void nextTick(open); });

  function input(event: Event) {
    if (event instanceof KeyboardEvent && !["ArrowDown", "ArrowUp", "PageDown", "PageUp", "End", "Home", " "].includes(event.key)) return;
    reading = true;
    void nextTick(checkRead);
  }
  function scroll() { if (reading) checkRead(); }
  function scrollEnd() { if (reading) checkRead(); reading = false; }
  function programmaticScroll() { reading = false; }
  function jumpToLatest() {
    options.bottom(true);
    reading = true;
    void nextTick(checkRead);
  }
  onMounted(() => {
    mounted = true;
    const el = options.element.value;
    for (const event of ["wheel", "touchmove", "pointerdown", "keydown"]) el?.addEventListener(event, input, { passive: true });
    el?.addEventListener("scroll", scroll);
    el?.addEventListener("scrollend", scrollEnd);
    window.addEventListener("focus", checkRead);
    document.addEventListener("visibilitychange", checkRead);
    void nextTick(open);
  });
  onScopeDispose(() => {
    generation++;
    const el = options.element.value;
    for (const event of ["wheel", "touchmove", "pointerdown", "keydown"]) el?.removeEventListener(event, input);
    el?.removeEventListener("scroll", scroll);
    el?.removeEventListener("scrollend", scrollEnd);
    window.removeEventListener("focus", checkRead);
    document.removeEventListener("visibilitychange", checkRead);
  });
  return { dividerId, programmaticScroll, jumpToLatest };
}
