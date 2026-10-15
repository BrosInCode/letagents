/**
 * Sequential reply turns. When one message activates several agents through
 * a broadcast or the small-room fallback, every agent would otherwise start
 * from the same context and give the same answer. Instead the receipts get a
 * reply order: position 1 sees the message at once, and position k is held
 * until every earlier position has finished its turn (answered, left the
 * room, or reported no reply) or until (k-1) × the step after the message was
 * sent. A new activation the agent must see now (a mention, a reply, a
 * human thread message or task) ends its older holds at once. An ordinary
 * shared human thread request can have its own reply order. Ordinary agent thread
 * participation keeps its receipt without releasing earlier held turns.
 *
 * A hold is enforced on the read side only (replyTurnHoldCondition in
 * routing-frontier.ts): every receipt is still written at send time, so
 * Message info and the human transcript do not change.
 */
// Deadlines count from the message's send time. Receipts applied later (Jev's
// deferred election) therefore get shorter turns; one delayed past a step
// finds that position already due.
export const REPLY_TURN_HOLD_STEP_MS = 90_000;
// Reasons that wake several agents for one untagged question. jev_routed is
// Jev's election in a room with Smart conversation routing; it is applied by
// the deferred pass, after commit. recent_conversation is always one agent.
export const SEQUENTIAL_REPLY_REASONS: ReadonlySet<string> = new Set(["broadcast", "small_room", "jev_routed"]);
/** Only a caller that verified an ordinary shared human thread request may opt in thread participants. */
export function sequentialReplyReason(reason: string, sharedHumanThread = false): boolean {
  return SEQUENTIAL_REPLY_REASONS.has(reason) || (sharedHumanThread && reason === "thread_participant");
}
/**
 * Above this many ready agents a broadcast stays parallel: the last position would
 * wait (count - 1) × the step, which stops being a conversation turn.
 */
export const MAX_SEQUENTIAL_REPLY_AGENTS = 8;
export const REPLY_TURN_SWEEP_BATCH = 500;

export interface ReplyTurnFields {
  turn_position: number | null;
  turn_count: number | null;
  hold_release_after: string | null;
  hold_released_at: string | null;
}

const PARALLEL: ReplyTurnFields = {
  turn_position: null,
  turn_count: null,
  hold_release_after: null,
  hold_released_at: null,
};

/**
 * Decide the reply order for one message's receipts. Sequencing applies only
 * when every receipt is a broadcast, small-room or Jev activation, or the
 * caller verified an ordinary shared human thread request. Explicit
 * mentions, replies to agents, peer threads and task owners retain their
 * own lanes, and so does a broadcast to more than
 * MAX_SEQUENTIAL_REPLY_AGENTS ready agents. The order is the agent keys sorted, rotated by the message
 * number so the first speaker changes from message to message.
 */
export function planReplyTurns<T extends { agent_key: string; activation_reason: string; agent_session_id?: string }>(
  receipts: readonly T[],
  input: { messageNumber: number; timestamp: string; sequential: boolean; readySessionIds?: ReadonlySet<string>; sharedHumanThread?: boolean },
): Array<T & ReplyTurnFields> {
  // Keep every routing receipt; unavailable workers must not hold up the live team.
  const eligible = input.readySessionIds
    ? receipts.filter(receipt => receipt.agent_session_id && input.readySessionIds!.has(receipt.agent_session_id))
    : receipts;
  const count = eligible.length;
  if (
    !input.sequential
    || count < 2
    || count > MAX_SEQUENTIAL_REPLY_AGENTS
    || !receipts.every((receipt) => sequentialReplyReason(receipt.activation_reason, input.sharedHumanThread))
  ) {
    return receipts.map((receipt) => ({ ...receipt, ...PARALLEL }));
  }
  const sorted = [...eligible].sort((left, right) =>
    left.agent_key < right.agent_key ? -1 : left.agent_key > right.agent_key ? 1 : 0);
  const offset = input.messageNumber % count;
  const sentAtMs = Date.parse(input.timestamp);
  const planned = sorted.map((_, index) => {
    const receipt = sorted[(index + offset) % count]!;
    const position = index + 1;
    return {
      ...receipt,
      turn_position: position,
      turn_count: count,
      hold_release_after: position === 1
        ? null
        : new Date(sentAtMs + (position - 1) * REPLY_TURN_HOLD_STEP_MS).toISOString(),
      hold_released_at: position === 1 ? input.timestamp : null,
    };
  });
  return [...planned, ...receipts.filter(receipt => !eligible.includes(receipt)).map(receipt => ({ ...receipt, ...PARALLEL }))];
}

export function priorSpeakersBefore(
  replied: readonly { turn_position: number; actor_label: string }[] | undefined,
  position: number | null,
): string[] {
  if (!replied || position === null || position < 2) return [];
  return replied.filter((receipt) => receipt.turn_position < position).map((receipt) => receipt.actor_label);
}
