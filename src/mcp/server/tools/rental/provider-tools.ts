import { z } from "zod";

import {
  rentalAccept,
  rentalDecline,
  rentalListRequests,
  rentalProvision,
} from "../../../rental-tools.js";
import { rentalTextResponse } from "./response.js";
import type { RentalToolRegistrationContext } from "./types.js";

export function registerRentalProviderTools({
  server,
  deps,
}: RentalToolRegistrationContext): void {
  server.tool(
    "rental_list_requests",
    "List incoming Rent an Agent session requests for the authenticated provider. Returns an array of session objects in the 'requested' state. Use this to poll while you are available to host renters.",
    {},
    async () => rentalTextResponse(await rentalListRequests(deps))
  );

  server.tool(
    "rental_accept",
    "Accept a pending Rent an Agent session request. Transitions the session from 'requested' to 'accepted' per spec §18.2. An optional idempotency_key is forwarded to the server for future idempotency support.",
    {
      session_id: z
        .string()
        .describe("Rental session id (e.g. 'rsess_*'). Get this from rental_list_requests."),
      idempotency_key: z
        .string()
        .optional()
        .describe(
          "Optional caller-chosen idempotency key. Forwarded to the server when provided."
        ),
    },
    async ({ session_id, idempotency_key }) =>
      rentalTextResponse(await rentalAccept(deps, { session_id, idempotency_key }))
  );

  server.tool(
    "rental_provision",
    "Provision an accepted Rent an Agent session into a rental room. Creates the provider-visible rental room, moves the session to 'provisioning', and returns the room id. Call this after rental_accept and before rental_heartbeat.",
    {
      session_id: z.string().describe("Rental session id to provision."),
      parent_room_id: z
        .string()
        .describe("Parent room id/identifier where the renter started the session."),
      provider_display_name: z
        .string()
        .optional()
        .describe("Optional display name for the provider participant in the rental room."),
    },
    async ({ session_id, parent_room_id, provider_display_name }) =>
      rentalTextResponse(
        await rentalProvision(deps, {
          session_id,
          parent_room_id,
          provider_display_name,
        })
      )
  );

  server.tool(
    "rental_decline",
    "Decline a pending Rent an Agent session request. Transitions the session from 'requested' to 'cancelled' per spec §18.2. An optional reason is forwarded in the decline body.",
    {
      session_id: z.string().describe("Rental session id to decline."),
      idempotency_key: z
        .string()
        .optional()
        .describe("Optional caller-chosen idempotency key. Forwarded to the server when provided."),
      reason: z
        .string()
        .optional()
        .describe("Optional short reason forwarded in the decline body (e.g. 'busy', 'out of quota')."),
    },
    async ({ session_id, idempotency_key, reason }) =>
      rentalTextResponse(
        await rentalDecline(deps, {
          session_id,
          idempotency_key,
          reason,
        })
      )
  );
}
