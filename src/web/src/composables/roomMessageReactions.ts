import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import { createMessageReactionStore } from '../../../../shared/message-reaction-store.mjs'
import type {
  MessageReaction,
  MessageReactionMutationResponse,
  MessageReactionsRangeResponse,
  MessageReactor,
} from '../../../../shared/message-reactions.mjs'
import { apiFetch, roomPath } from './room/api'
import { lastMessageReactionInvalidation } from './roomMessageReactionInvalidation'
import { useAuth } from './useAuth'

/** What a rendered message needs to show and change its reactions. */
export interface RoomMessageReactionContext {
  /** False when nobody is signed in: a reaction carries the reactor's name. */
  canReact: ComputedRef<boolean>
  viewerLogin: ComputedRef<string | null>
  reactionsFor(messageId: string): readonly MessageReaction[]
  viewerReacted(messageId: string, emoji: string): boolean
  toggle(messageId: string, emoji: string): void
  /** Bumped whenever a reaction on screen changes; a message list uses it to stay at the newest message. */
  revision: Readonly<Ref<number>>
  /**
   * A rendered message registers itself; the returned function unregisters it.
   * A message that carries no `reactions` (a server that predates them) is
   * ignored: it cannot be reacted to.
   */
  track(message: { id: string; reactions?: unknown }): () => void
}

export function useRoomMessageReactions(
  roomIdentifier: Ref<string>,
  reportError: (message: string) => void,
): RoomMessageReactionContext {
  const auth = useAuth()
  const viewer = computed<MessageReactor | null>(() => {
    const account = auth.isSignedIn.value ? auth.user.value : null
    return account?.login
      ? { login: account.login, name: account.display_name?.trim() || account.login, avatar_url: account.avatar_url || null }
      : null
  })
  // The shared store is not reactive; every change bumps this for Vue.
  const version = shallowRef(0)
  const reactionsPath = (suffix: string) => `${roomPath(roomIdentifier.value)}/messages/${suffix}`

  const store = createMessageReactionStore({
    load: (first, last): Promise<MessageReactionsRangeResponse> =>
      apiFetch(reactionsPath(`reactions?${new URLSearchParams({ first, last })}`)),
    mutate: (messageId, emoji, reacted): Promise<MessageReactionMutationResponse> =>
      apiFetch(reactionsPath(`${messageId}/reactions/${encodeURIComponent(emoji)}`), { method: reacted ? 'PUT' : 'DELETE' }),
    viewer: () => viewer.value,
    onChange: () => { version.value += 1 },
    onError: (error, during) => {
      // A failed background read keeps what is shown; the next invalidation retries.
      if (during === 'mutate') reportError(error instanceof Error && error.message ? error.message : 'Could not save your reaction.')
    },
  })

  // Another room's reactions must never show under this room's messages.
  watch(roomIdentifier, () => store.reset())
  // The messages stay on screen; whose reactions are "mine" changed.
  watch(() => viewer.value?.login ?? null, () => store.reset({ keepTracked: true }))
  watch(lastMessageReactionInvalidation, (invalidation) => {
    if (invalidation && invalidation.roomId === roomIdentifier.value) void store.refresh()
  })
  onScopeDispose(() => store.reset())

  return {
    revision: version,
    canReact: computed(() => Boolean(roomIdentifier.value) && viewer.value !== null),
    viewerLogin: computed(() => viewer.value?.login ?? null),
    reactionsFor(messageId) {
      void version.value
      return store.get(messageId)
    },
    viewerReacted(messageId, emoji) {
      void version.value
      return store.viewerReacted(messageId, emoji)
    },
    toggle(messageId, emoji) {
      if (roomIdentifier.value && viewer.value) void store.toggle(messageId, emoji)
    },
    track(message) {
      if (!roomIdentifier.value || message.reactions === undefined) return () => {}
      return store.track(message)
    },
  }
}

const ROOM_MESSAGE_REACTIONS: InjectionKey<RoomMessageReactionContext> = Symbol('room-message-reactions')

export function provideRoomMessageReactions(context: RoomMessageReactionContext): void {
  provide(ROOM_MESSAGE_REACTIONS, context)
}

export function injectRoomMessageReactions(): RoomMessageReactionContext | null {
  return inject(ROOM_MESSAGE_REACTIONS, null)
}
