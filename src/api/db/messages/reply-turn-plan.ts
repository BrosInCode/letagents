/**
 * Sequential reply turns. When one message activates several agents through
 * a broadcast or the small-room fallback, every agent would otherwise start
 * from the same context and give the same answer. Instead the receipts get a
 * reply order: position 1 sees the message at once, and position k is held
 * until every earlier position has finished its turn (answered, left the
 * room, or reported no reply) or until (k-1) × the step after the message was
 * sent. A new activation the agent must see now (a mention, a reply, a
 * thread or task) ends its holds at once.
 *
 * A hold is enforced on the read side only (replyTurnHoldCondition in
 * routing-frontier.ts): every receipt is still written at send time, so
 * Message info and the human transcript do not change.
 */
export const REPLY_TURN_HOLD_STEP_MS = 90_000;
export const SEQUENTIAL_REPLY_REASONS: ReadonlySet<string> = new Set(["broadcast", "small_room"]);
/**
 * Above this many agents a broadcast stays parallel: the last position would
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
 * when every receipt is a broadcast or small-room activation: explicit
 * mentions, replies, threads and task owners asked particular agents and
 * stay parallel, and so does a broadcast to more than
 * MAX_SEQUENTIAL_REPLY_AGENTS agents. The order is the agent keys sorted, rotated by the message
 * number so the first speaker changes from message to message.
 */
export function planReplyTurns<T extends { agent_key: string; activation_reason: string }>(
  receipts: readonly T[],
  input: { messageNumber: number; timestamp: string; sequential: boolean },
): Array<T & ReplyTurnFields> {
  const count = receipts.length;
  if (
    !input.sequential
    || count < 2
    || count > MAX_SEQUENTIAL_REPLY_AGENTS
    || !receipts.every((receipt) => SEQUENTIAL_REPLY_REASONS.has(receipt.activation_reason))
  ) {
    return receipts.map((receipt) => ({ ...receipt, ...PARALLEL }));
  }
  const sorted = [...receipts].sort((left, right) =>
    left.agent_key < right.agent_key ? -1 : left.agent_key > right.agent_key ? 1 : 0);
  const offset = input.messageNumber % count;
  const sentAtMs = Date.parse(input.timestamp);
  return sorted.map((_, index) => {
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
}

export function priorSpeakersBefore(
  replied: readonly { turn_position: number; actor_label: string }[] | undefined,
  position: number | null,
): string[] {
  if (!replied || position === null || position < 2) return [];
  return replied.filter((receipt) => receipt.turn_position < position).map((receipt) => receipt.actor_label);
}
