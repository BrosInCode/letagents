import { drainRoomAgentDeliveryLeases, describePendingRoomAgentDeliveryWork } from "../rooms/agent-delivery.js";
import { pendingReplyTurnWakeCount, settleReplyTurnWakes } from "../db/messages/reply-turns.js";

const SETTLE_LIMIT_MS = 10_000;

async function within(work: Promise<void>, describe: () => string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `background DB work still pending after ${SETTLE_LIMIT_MS} ms: ${describe()}`,
    )), SETTLE_LIMIT_MS);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finish the previous case's fire-and-forget DB work before a schema reset or
 * pool.end(). DROP SCHEMA takes its table locks one by one, so a live query
 * on two tables deadlocks with it. The bound turns a stuck query into a fast,
 * named failure instead of a hung job.
 */
export async function settleBackgroundDbWork(options: { delivery?: boolean } = {}): Promise<void> {
  // Delivery drains can release reply turns, so they go first.
  if (options.delivery) {
    await within(drainRoomAgentDeliveryLeases(), () => `room agent delivery ${describePendingRoomAgentDeliveryWork()}`);
  }
  await within(settleReplyTurnWakes(), () => `reply-turn wakes=${pendingReplyTurnWakeCount()}`);
}
