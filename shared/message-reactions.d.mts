export const MESSAGE_REACTION_EMOJI_MAX_BYTES: 64;
export const MESSAGE_REACTION_MAX_DISTINCT_PER_MESSAGE: 20;
/** A reaction always reports its exact count; only the named reactors are capped. */
export const MESSAGE_REACTION_MAX_REACTORS_LISTED: 50;
/** One range read covers at most this many message numbers. */
export const MESSAGE_REACTION_RANGE_MAX_SPAN: 1000;
/** One range read returns at most this many reactor rows before it stops and names where to continue. */
export const MESSAGE_REACTION_MAX_PER_READ: 2000;
export const MESSAGE_REACTION_QUICK_EMOJI: readonly string[];

/** Public identity only; account ids stay internal. */
export interface MessageReactor {
  login: string;
  name: string;
  avatar_url: string | null;
}

export interface MessageReaction {
  emoji: string;
  /** Exact number of people who reacted with this emoji. */
  count: number;
  /** Earliest first, at most MESSAGE_REACTION_MAX_REACTORS_LISTED. */
  reactors: MessageReactor[];
}

/** `GET /rooms/:room/messages/reactions` */
export interface MessageReactionsRangeResponse {
  room_id: string;
  first_message_id: string;
  last_message_id: string;
  /** Only messages that have at least one reaction appear. */
  reactions: Record<string, MessageReaction[]>;
  /**
   * The emoji the signed-in caller reacted with, per message. Present only
   * for a person's session; exact even where `reactors` is capped.
   */
  viewer_reactions?: Record<string, string[]>;
  /**
   * Null when the whole range was read. Otherwise the read stopped early:
   * it is complete below this message, and continues from it.
   */
  next_first_message_id: string | null;
}

/** `PUT` and `DELETE /rooms/:room/messages/:message/reactions/:emoji` */
export interface MessageReactionMutationResponse {
  room_id: string;
  message_id: string;
  emoji: string;
  /** False when the request repeated a reaction the viewer already had (or had already removed). */
  changed: boolean;
  reactions: MessageReaction[];
}

/** The canonical form of one emoji, or null when the value is anything else. */
export function normalizeMessageReactionEmoji(value: unknown): string | null;
/** Read a server reaction list defensively; malformed entries are dropped. */
export function normalizeMessageReactions(value: unknown): MessageReaction[];
export function viewerReactedWith(
  reaction: Pick<MessageReaction, "reactors"> | null | undefined,
  viewerLogin: string | null | undefined,
): boolean;
/** "You, Ada and 3 others reacted with 👍" */
export function describeMessageReaction(
  reaction: MessageReaction,
  viewerLogin: string | null | undefined,
): string;
/** The reaction list after the viewer toggles one emoji, for an optimistic update. */
export function toggleViewerMessageReaction(
  reactions: readonly MessageReaction[] | null | undefined,
  emoji: string,
  viewer: MessageReactor,
): MessageReaction[];
