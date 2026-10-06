import { computed, inject, onScopeDispose, provide, shallowRef, watch, type Ref } from "vue";
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
  const revision = shallowRef(0);
  const contextKey = computed(() => JSON.stringify([room.value, repository.value, viewer.value]));
  const store = createMessageLinkPreviewStore({
    load: async (references) => {
      const expectedRepository = normalizePreviewRepository(repository.value);
      const result = await desktopIpc.room.getMessageLinkPreviews!(room.value, references);
      return { ...result, previews: result.previews.filter(preview => expectedRepository !== null && normalizePreviewRepository(preview.repository) === expectedRepository) };
    },
    onChange: () => { revision.value++; },
  });
  watch(contextKey, () => store.reset(), { flush: "sync" });
  watch(invalidation, (value) => {
    if (normalizeRoomIdentifier(value?.room) === normalizeRoomIdentifier(room.value)) void store.refresh();
  });
  onScopeDispose(() => store.reset());
  return {
    revision, contextKey,
    previewsFor(id: string) { void revision.value; return store.get(id); },
    track(message: { id: string; urls: string[] }) {
      if (!room.value || !desktopIpc.room?.getMessageLinkPreviews || !/^msg_[1-9]\d*$/.test(message.id)) return () => {};
      return store.track({ id: message.id, references: eligibleLinkPreviewReferences(message.urls, repository.value) });
    },
  };
}
const KEY = Symbol("message-link-previews");
type Context = ReturnType<typeof useRoomMessageLinkPreviews>;
export function provideRoomMessageLinkPreviews(context: Context): void { provide(KEY, context); }
export function injectRoomMessageLinkPreviews(): Context | null { return inject<Context | null>(KEY, null); }
