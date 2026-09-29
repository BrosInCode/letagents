import { sql } from "drizzle-orm";
import { jev_routing_jobs, messages } from "../schema.js";

/** Evaluate in the message query's snapshot. Worker cursors must never pass
 * a message whose recipient authority has not committed yet. */
export function settledRoutingCondition(waitForRouting?: boolean) {
  return waitForRouting ? sql`${messages.number} < COALESCE((
    SELECT min(j.message_number) FROM ${jev_routing_jobs} j
    WHERE j.room_id = ${messages.room_id} AND j.state <> 'completed'
      AND j.plan->>'mode' = 'active'
  ), 2147483648)` : sql`TRUE`;
}
