import { computed, inject, onScopeDispose, provide, reactive, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";

import type { DesktopMessageReceipt } from "../../../electron/ipc-types";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { desktopIpc } from "../ipc/index";

/**
 * Bumped when the room stream says a room's Message info changed (a receipt
 * moved, someone read a message), or when the stream reopens and may have
 * missed such a change. Every open view of that room re-reads its receipts.
 */
const revisions = reactive(new Map<string, number>());

export function invalidateRoomMessageReceipts(roomIdentifier: string): void {
  const key = normalizeRoomIdentifier(roomIdentifier);
  if (key) revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

/** The server takes at most this many ids in one request. */
const BATCH_LIMIT = 100;
/** Many changes in a short time (a read batch, several agents) become one read. */
const REFRESH_DELAY_MS = 250;

export interface RoomReceiptOpenRequest {
  messageId: string;
  /** The receipt mark the popover grows out of. */
  anchor: HTMLElement;
  /** Which rendering opened it: a thread root shows in the timeline and in the thread panel. */
  context: string;
  /** The thread the message is in, so Ask replies in that thread; null in the main timeline. */
  threadRootId: string | null;
}

export interface RoomMessageReceiptContext {
  /** False in a room kept on this computer and against a main process that predates receipts. */
  available: ComputedRef<boolean>;
  /** Undefined while it loads; null when the server has no receipt for this message. */
  receiptFor(messageId: string): DesktopMessageReceipt | null | undefined;
  /** A rendered own message registers itself; the returned function unregisters it. */
  track(messageId: string): () => void;
  open(request: RoomReceiptOpenRequest): void;
  close(): void;
  opened: Readonly<Ref<RoomReceiptOpenRequest | null>>;
}

function messageNumber(id: string): number {
  const match = /^msg_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/**
 * `namespace` is the room together with its storage mode: message ids change
 * meaning when a room moves between this computer and the server, so the
 * receipts reset with it.
 */
export function useRoomMessageReceipts(roomIdentifier: Ref<string>, namespace: Ref<string> = roomIdentifier): RoomMessageReceiptContext {
  const available = computed(() => Boolean(roomIdentifier.value) && typeof desktopIpc.room?.getMessageReceipts === "function");
  const tracked = new Map<string, number>();
  const receipts = shallowRef(new Map<string, DesktopMessageReceipt | null>());
  const opened = shallowRef<RoomReceiptOpenRequest | null>(null);
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let generation = 0;

  function schedule(ids: Iterable<string>): void {
    for (const id of ids) pending.add(id);
    if (timer || flushing || pending.size === 0) return;
    timer = setTimeout(() => { timer = null; void flush(); }, REFRESH_DELAY_MS);
  }

  async function flush(): Promise<void> {
    if (!available.value || pending.size === 0) { pending.clear(); return; }
    // The newest messages matter most; an old one beyond the cap keeps what it showed.
    const ids = [...pending].sort((a, b) => messageNumber(b) - messageNumber(a)).slice(0, BATCH_LIMIT);
    pending = new Set([...pending].filter((id) => !ids.includes(id)));
    const room = roomIdentifier.value;
    const startedIn = generation;
    // One read at a time, so an older answer can never land after a newer one.
    flushing = true;
    try {
      const loaded = await desktopIpc.room.getMessageReceipts!(room, ids);
      if (startedIn !== generation || room !== roomIdentifier.value) return;
      const next = new Map(receipts.value);
      for (const id of ids) next.set(id, null);
      for (const receipt of loaded) next.set(receipt.messageId, receipt);
      receipts.value = next;
    } catch {
      // A failed background read keeps what is shown; the next change retries.
    } finally {
      flushing = false;
    }
    if (pending.size) schedule([]);
  }

  watch(() => [normalizeRoomIdentifier(roomIdentifier.value), namespace.value] as const, () => {
    generation += 1;
    receipts.value = new Map();
    pending.clear();
    opened.value = null;
    // Messages that stay on screen under the new namespace read their receipts again.
    schedule(tracked.keys());
  });
  watch(
    () => revisions.get(normalizeRoomIdentifier(roomIdentifier.value) ?? "") ?? 0,
    () => schedule(tracked.keys()),
  );
  onScopeDispose(() => { if (timer) clearTimeout(timer); generation += 1; });

  return {
    available,
    receiptFor(messageId) {
      return receipts.value.get(messageId);
    },
    track(messageId) {
      if (!available.value || !messageNumber(messageId)) return () => {};
      tracked.set(messageId, (tracked.get(messageId) ?? 0) + 1);
      if (!receipts.value.has(messageId)) schedule([messageId]);
      return () => {
        const left = (tracked.get(messageId) ?? 1) - 1;
        if (left > 0) tracked.set(messageId, left);
        else tracked.delete(messageId);
      };
    },
    open(request) { opened.value = request; },
    close() { opened.value = null; },
    opened,
  };
}

const ROOM_MESSAGE_RECEIPTS: InjectionKey<RoomMessageReceiptContext> = Symbol("room-message-receipts");

export function provideRoomMessageReceipts(context: RoomMessageReceiptContext): void {
  provide(ROOM_MESSAGE_RECEIPTS, context);
}

export function injectRoomMessageReceipts(): RoomMessageReceiptContext | null {
  return inject(ROOM_MESSAGE_RECEIPTS, null);
}
