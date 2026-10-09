import { getMessageById } from "../db/messages/history.js";
import {
  releaseDueReplyTurnHolds,
  REPLY_TURN_SWEEP_BATCH,
  type ReleasedReplyTurn,
} from "../db/messages/reply-turns.js";
import { messageEvents } from "./events.js";

/** Cadence of the reply-turn deadline sweep. A hold may outlast its deadline by this much. */
export const REPLY_TURN_SWEEP_INTERVAL_MS = 15 * 1000;
const MAX_SWEEP_BATCHES_PER_TICK = 10;

/**
 * Wake agents whose reply turn was released. The `message_routed` event
 * names only the released agents (`wakeAgentKeys`), so the broker delivers it
 * to their worker subscriptions alone: a held long-poll re-reads past its
 * cursor, where the frontier now lets the message through. People, the app
 * stream and every other agent never see the message a second time. A lost
 * wake is recovered by the next poll.
 */
export async function publishReleasedReplyTurns(released: readonly ReleasedReplyTurn[]): Promise<void> {
  const byMessage = new Map<string, { room_id: string; message_number: number; agent_keys: Set<string> }>();
  for (const turn of released) {
    const key = `${turn.room_id}\u0000${turn.message_number}`;
    const entry = byMessage.get(key) ?? { room_id: turn.room_id, message_number: turn.message_number, agent_keys: new Set() };
    entry.agent_keys.add(turn.agent_key);
    byMessage.set(key, entry);
  }
  for (const { room_id, message_number, agent_keys } of byMessage.values()) {
    const message = await getMessageById(room_id, `msg_${message_number}`);
    if (message) {
      messageEvents.emit("message:routed", {
        projectId: room_id,
        message,
        recipientAgentTargets: [],
        wakeAgentKeys: [...agent_keys],
      });
    }
  }
}

/** Release every hold whose deadline passed or whose turn is ready, in bounded batches. Returns the count released. */
export async function sweepReplyTurnHoldsOnce(): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_SWEEP_BATCHES_PER_TICK; batch++) {
    const { released, turns } = await releaseDueReplyTurnHolds(REPLY_TURN_SWEEP_BATCH);
    total += turns.length;
    await publishReleasedReplyTurns(turns);
    if (released < REPLY_TURN_SWEEP_BATCH) break;
  }
  return total;
}

let sweepTimer: NodeJS.Timeout | null = null;
let sweepPromise: Promise<void> | null = null;

export function startReplyTurnHoldSweep(): void {
  if (sweepTimer) return;
  const tick = async () => {
    if (sweepPromise) return;
    const pending = sweepReplyTurnHoldsOnce()
      .then(() => undefined, (error: unknown) => {
        console.error("Reply turn hold sweep failed:", error);
      })
      .finally(() => {
        if (sweepPromise === pending) sweepPromise = null;
      });
    sweepPromise = pending;
    await pending;
  };
  sweepTimer = setInterval(() => void tick(), REPLY_TURN_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export async function stopReplyTurnHoldSweep(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  await sweepPromise;
}
