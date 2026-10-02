import type { MessageReaction, MessageReactor } from "./message-reactions.mjs";

export interface MessageReactionStoreOptions {
  /**
   * Read the reactions of the messages from `firstMessageId` to `lastMessageId`
   * (at most MESSAGE_REACTION_RANGE_MAX_SPAN apart). The answer may stop early
   * and name the message to continue from.
   */
  load(firstMessageId: string, lastMessageId: string): Promise<{
    reactions: Record<string, unknown>;
    viewer_reactions?: Record<string, unknown>;
    next_first_message_id?: string | null;
  }>;
  /** Add (`reacted: true`) or remove the viewer's reaction; resolves with the message's reactions. */
  mutate(messageId: string, emoji: string, reacted: boolean): Promise<{ reactions: unknown }>;
  /** The signed-in person, or null when nobody can react. */
  viewer(): MessageReactor | null;
  onChange?(): void;
  onError?(error: unknown, during: "load" | "mutate"): void;
  /** How long newly tracked messages are gathered before one read confirms them. */
  refreshDelayMs?: number;
}

export interface MessageReactionStore {
  /** A stable empty list when the message has no reactions. */
  get(messageId: string): readonly MessageReaction[];
  viewerReacted(messageId: string, emoji: string): boolean;
  /**
   * A rendered message registers itself; the returned function unregisters it.
   * Its reactions start from what it carried and are confirmed by a read a
   * moment after it is first tracked.
   */
  track(message: { id: string; reactions?: unknown }): () => void;
  /** Re-read the reactions of every message on screen. */
  refresh(): Promise<void>;
  /** Add the viewer's reaction, or remove it if it is already there. */
  toggle(messageId: string, emoji: string): Promise<void>;
  /**
   * Forget everything. With `keepTracked` the messages on screen stay
   * registered (the signed-in person changed); without it they are dropped
   * too (the room changed).
   */
  reset(options?: { keepTracked?: boolean }): void;
}

/**
 * The client-side state of a room's reactions, shared by the desktop and web
 * apps: seeded from the messages on screen, confirmed and kept current by
 * reading the server.
 */
export function createMessageReactionStore(options: MessageReactionStoreOptions): MessageReactionStore;
