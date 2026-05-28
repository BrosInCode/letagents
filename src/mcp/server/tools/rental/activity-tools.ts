import { z } from "zod";

import {
  rentalCancel,
  rentalComplete,
  rentalEmitActivity,
} from "../../../rental-tools.js";
import { rentalTextResponse } from "./response.js";
import type { RentalToolRegistrationContext } from "./types.js";

export function registerRentalActivityTools({
  server,
  deps,
}: RentalToolRegistrationContext): void {
  server.tool(
    "rental_emit_activity",
    "Emit an activity event into a rental session's event log (rental_activity_events table). The event is unverified by default per §9.4 — only tool-mediated event types are auto-verified server-side. Use this to record agent notes, progress updates, or custom milestones visible to the renter.",
    {
      session_id: z.string().describe("Rental session id."),
      event_type: z
        .string()
        .describe(
          "Activity event type from §9.4 taxonomy (e.g. 'agent.note', 'edit.proposed'). Must be a known type."
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Event source: 'agent', 'tool', 'patch_gate', 'system', 'renter', 'provider'. Defaults to 'agent'."
        ),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arbitrary JSON payload for the event. Defaults to {}."),
      verified: z
        .boolean()
        .optional()
        .describe(
          "Override verification status. If omitted, the server resolves from the event type set."
        ),
    },
    async ({ session_id, event_type, source, payload, verified }) =>
      rentalTextResponse(
        await rentalEmitActivity(deps, {
          session_id,
          event_type,
          source,
          payload,
          verified,
        })
      )
  );

  server.tool(
    "rental_complete",
    "Mark a rental session as completed. Transitions the session to terminal state 'completed', records ended_at, and triggers §18.4 teardown (activity event emission, resource cleanup). Either the renter or the provider can mark completion; the caller's role is recorded in the activity event.",
    {
      session_id: z.string().describe("Rental session id to complete."),
      summary: z
        .string()
        .optional()
        .describe(
          "Optional completion summary describing what was accomplished during the session."
        ),
    },
    async ({ session_id, summary }) =>
      rentalTextResponse(await rentalComplete(deps, { session_id, summary }))
  );

  server.tool(
    "rental_cancel",
    "Cancel a rental session. Transitions the session to terminal state 'cancelled', records ended_at, and triggers §18.4 teardown. Either the renter or the provider can cancel. Use this when the session needs to be aborted — e.g. renter revokes access, provider encounters an unrecoverable error, or budget is fully exhausted.",
    {
      session_id: z.string().describe("Rental session id to cancel."),
      reason: z
        .string()
        .optional()
        .describe(
          "Optional reason for cancellation (e.g. 'budget_exhausted', 'renter_revoked')."
        ),
    },
    async ({ session_id, reason }) =>
      rentalTextResponse(await rentalCancel(deps, { session_id, reason }))
  );
}
