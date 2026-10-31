import { computed, inject, onScopeDispose, provide, shallowRef, watch, type Ref, type ShallowRef } from "vue";
import { createMessageLinkPreviewStore } from "../../../../../shared/message-link-preview-store.mjs";
import { eligibleLinkPreviewReferences, normalizePreviewRepository } from "../../../../../shared/message-link-previews.mjs";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import type { DesktopAuthAccount } from "../../../electron/ipc-types";
import { desktopIpc } from "../ipc/index";

const invalidation = shallowRef<{ room: string } | null>(null);
const viewer = shallowRef<string | null>(null);
export function setMessageLinkPreviewViewer(account: DesktopAuthAccount | null): void { viewer.value = account?.id ?? null; }
export function invalidateRoomMessageLinkPreviews(room: string): void { invalidation.value = { room }; }

export function useRoomMessageLinkPreviews(room: Readonly<Ref<string>>, repository: Readonly<Ref<string | null>>) {
  // `revision` still moves on every store change, for callers that want a
  // whole-room signal. A message reads its own entry in `versions` instead, so
  // a change to one message's previews does not re-render every message.
  const revision = shallowRef(0);
  // One counter per message id that has asked for previews. Bound: the distinct
  // message ids read in the current room context. Invalidation: on a room,
  // repository or viewer change every counter is bumped once, then dropped.
  const versions = new Map<string, ShallowRef<number>>();
  // What each message last read, to tell a real change from an unrelated one.
  const lastSeen = new Map<string, readonly unknown[]>();
  // Messages that registered references. Only these (and messages that showed
  // previews before) can change when the store changes.
  const active = new Map<string, Set<symbol>>();
  const contextKey = computed(() => JSON.stringify([room.value, repository.value, viewer.value]));
  function sameList(left: readonly unknown[] | undefined, right: readonly unknown[]): boolean {
    if (!left) return right.length === 0;
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  function publishId(id: string): void {
    const version = versions.get(id);
    if (!version) return;
    const next = store.get(id);
    if (sameList(lastSeen.get(id), next)) return;
    version.value++;
    if (next.length) lastSeen.set(id, next); else lastSeen.delete(id);
  }
  function publishChanges(): void {
    revision.value++;
    for (const id of new Set([...active.keys(), ...lastSeen.keys()])) publishId(id);
  }
  const store = createMessageLinkPreviewStore({
    load: async (references) => {
      const expectedRepository = normalizePreviewRepository(repository.value);
      const result = await desktopIpc.room.getMessageLinkPreviews!(room.value, references);
      return { ...result, previews: result.previews.filter(preview => expectedRepository !== null && normalizePreviewRepository(preview.repository) === expectedRepository) };
    },
    onChange: publishChanges,
  });
  watch(contextKey, () => {
    store.reset();
    active.clear();
    for (const version of versions.values()) version.value++;
    versions.clear();
    lastSeen.clear();
  }, { flush: "sync" });
  watch(invalidation, (value) => {
    if (normalizeRoomIdentifier(value?.room) === normalizeRoomIdentifier(room.value)) void store.refresh();
  });
  onScopeDispose(() => store.reset());
  return {
    revision, contextKey,
    previewsFor(id: string) {
      let version = versions.get(id);
      if (!version) {
        version = shallowRef(0);
        versions.set(id, version);
      }
      void version.value;
      const previews = store.get(id);
      if (previews.length) lastSeen.set(id, previews); else lastSeen.delete(id);
      return previews;
    },
    track(message: { id: string; urls: string[] }) {
      if (!room.value || !desktopIpc.room?.getMessageLinkPreviews || !/^msg_[1-9]\d*$/.test(message.id)) return () => {};
      const token = Symbol();
      const tokens = active.get(message.id) ?? new Set<symbol>();
      tokens.add(token);
      active.set(message.id, tokens);
      const stop = store.track({ id: message.id, references: eligibleLinkPreviewReferences(message.urls, repository.value) });
      return () => {
        stop();
        const current = active.get(message.id);
        if (!current?.delete(token)) return;
        if (!current.size) active.delete(message.id);
        publishId(message.id);
      };
    },
  };
}
const KEY = Symbol("message-link-previews");
type Context = ReturnType<typeof useRoomMessageLinkPreviews>;
export function provideRoomMessageLinkPreviews(context: Context): void { provide(KEY, context); }
export function injectRoomMessageLinkPreviews(): Context | null { return inject<Context | null>(KEY, null); }
