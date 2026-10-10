import { sql } from "drizzle-orm";
import { jev_routing_jobs, message_agent_receipts, messages } from "../schema.js";

/** Evaluate in the message query's snapshot. Worker cursors must never pass
 * a message whose recipient authority has not committed yet. */
export function settledRoutingCondition(waitForRouting?: boolean) {
  return waitForRouting ? sql`${messages.number} < COALESCE((
    SELECT min(j.message_number) FROM ${jev_routing_jobs} j
    WHERE j.room_id = ${messages.room_id} AND j.state <> 'completed'
      AND j.plan->>'mode' = 'active'
  ), 2147483648)` : sql`TRUE`;
}

/**
 * Per-agent frontier of the same shape for sequential reply turns: a worker
 * sees only messages before its first held receipt, so its cursor never
 * passes a held message. The room is bound, not correlated, so PostgreSQL
 * evaluates the subquery once per read from the held-only partial index.
 */
export function replyTurnHoldCondition(roomId: string, holdAgentKey?: string | null) {
  return holdAgentKey ? sql`${messages.number} < COALESCE((
    SELECT min(held.message_number) FROM ${message_agent_receipts} held
    WHERE held.message_room_id = ${roomId}
      AND held.agent_key = ${holdAgentKey}
      AND held.hold_released_at IS NULL
      AND held.hold_release_after IS NOT NULL
      -- A hold ends at its deadline even when no sweep has run.
      AND held.hold_release_after > now()
  ), 2147483648)` : sql`TRUE`;
}
