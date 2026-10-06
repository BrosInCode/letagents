import { computed, inject, onScopeDispose, provide, reactive, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from "vue";

import type { DesktopAuthAccount } from "../../../electron/ipc-types";
import { createMessageReactionStore } from "../../../../../shared/message-reaction-store.mjs";
import type { MessageReaction, MessageReactor } from "../../../../../shared/message-reactions.mjs";
import { normalizeRoomIdentifier } from "../domain/sidebar-rooms";
import { safeUserVisibleErrorDetail } from "../domain/user-visible-error";
import { desktopIpc } from "../ipc/index";

/**
 * Bumped when the room stream says a room's reactions changed, or when the
 * stream reopens and may have missed such a change. Every open view of that
 * room re-reads the reactions of the messages it shows.
 */
const revisions = reactive(new Map<string, number>());

export function invalidateRoomMessageReactions(roomIdentifier: string): void {
  const key = normalizeRoomIdentifier(roomIdentifier);
  if (key) revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

// The signed-in person, set once by the app shell. Reactions carry a name, so
// nobody signed in means nobody can react.
const viewer = shallowRef<MessageReactor | null>(null);

export function setMessageReactionViewer(account: DesktopAuthAccount | null): void {
  viewer.value = account?.login
    ? { login: account.login, name: account.displayName?.trim() || account.login, avatar_url: account.avatarUrl || null }
    : null;
}

/** What a rendered message needs to show and change its reactions. */
export interface RoomMessageReactionContext {
  /** False when signed out, and against a main process that predates reactions. */
  canReact: ComputedRef<boolean>;
  viewerLogin: ComputedRef<string | null>;
  reactionsFor(messageId: string): readonly MessageReaction[];
  viewerReacted(messageId: string, emoji: string): boolean;
  toggle(messageId: string, emoji: string): void;
  /** Bumped whenever a reaction on screen changes; a message list uses it to stay at the newest message. */
  revision: Readonly<Ref<number>>;
  /**
   * A rendered message registers itself; the returned function unregisters it.
   * A message that carries no `reactions` (a room kept on this computer, or a
   * server that predates reactions) is ignored: it cannot be reacted to.
   */
  track(message: { id: string; reactions?: MessageReaction[] }): () => void;
}

export function useRoomMessageReactions(
  roomIdentifier: Ref<string>,
  reportError: (message: string) => void,
): RoomMessageReactionContext {
  // The shared store is not reactive; every change bumps this for Vue.
  const version = shallowRef(0);
  const available = computed(() => Boolean(roomIdentifier.value)
    && typeof desktopIpc.room?.getMessageReactions === "function"
    && typeof desktopIpc.room?.setMessageReaction === "function");

  const store = createMessageReactionStore({
    load: (first, last) => desktopIpc.room.getMessageReactions!(roomIdentifier.value, first, last),
    mutate: (messageId, emoji, reacted) => desktopIpc.room.setMessageReaction!(roomIdentifier.value, messageId, emoji, reacted),
    viewer: () => viewer.value,
    onChange: () => { version.value += 1; },
    onError: (error, during) => {
      // A failed background read keeps what is shown; the next invalidation retries.
      if (during === "mutate") reportError(safeUserVisibleErrorDetail(error, "Could not save your reaction."));
    },
  });

  watch(
    () => [normalizeRoomIdentifier(roomIdentifier.value), available.value] as const,
    // Another room's reactions must never show under this room's messages.
    () => store.reset(),
  );
  watch(
    () => viewer.value?.login ?? null,
    // The messages stay on screen; whose reactions are "mine" changed.
    () => store.reset({ keepTracked: true }),
  );
  watch(
    () => revisions.get(normalizeRoomIdentifier(roomIdentifier.value) ?? "") ?? 0,
    () => { if (available.value) void store.refresh(); },
  );
  onScopeDispose(() => store.reset());

  return {
    revision: version,
    canReact: computed(() => available.value && viewer.value !== null),
    viewerLogin: computed(() => viewer.value?.login ?? null),
    reactionsFor(messageId) {
      void version.value;
      return available.value ? store.get(messageId) : [];
    },
    viewerReacted(messageId, emoji) {
      void version.value;
      return store.viewerReacted(messageId, emoji);
    },
    toggle(messageId, emoji) {
      if (available.value && viewer.value) void store.toggle(messageId, emoji);
    },
    track(message) {
      if (!available.value || message.reactions === undefined) return () => {};
      return store.track(message);
    },
  };
}

const ROOM_MESSAGE_REACTIONS: InjectionKey<RoomMessageReactionContext> = Symbol("room-message-reactions");

export function provideRoomMessageReactions(context: RoomMessageReactionContext): void {
  provide(ROOM_MESSAGE_REACTIONS, context);
}

export function injectRoomMessageReactions(): RoomMessageReactionContext | null {
  return inject(ROOM_MESSAGE_REACTIONS, null);
}
