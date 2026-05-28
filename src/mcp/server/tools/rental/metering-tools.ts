import { z } from "zod";

import {
  rentalHeartbeat,
  rentalRefreshQuota,
  rentalReportUsage,
  rentalRequestBudgetExtension,
} from "../../../rental-tools.js";
import { rentalTextResponse } from "./response.js";
import type { RentalToolRegistrationContext } from "./types.js";

export function registerRentalMeteringTools({
  server,
  deps,
}: RentalToolRegistrationContext): void {
  server.tool(
    "rental_heartbeat",
    "Beat the heart of an active Rent an Agent provider session. Records last_heartbeat_at and transitions provisioning → active on the first beat. Provider-only; the server returns not_provider when the caller does not own the lane. Call on a 30s cadence per spec §18.3.",
    {
      session_id: z.string().describe("Rental session id to heartbeat."),
    },
    async ({ session_id }) => rentalTextResponse(await rentalHeartbeat(deps, { session_id }))
  );

  server.tool(
    "rental_refresh_quota",
    "Read the most recent native quota snapshot recorded for a rental session (POST /api/rental/sessions/:id/refresh-quota). V1 returns the snapshot already stored on the session row by the desktop meter adapter pipeline; the server cannot push-poll a provider's adapter from here, so `refreshed` is false. Use this when the rented agent (or a renter UI) needs the freshest provider-side quota state visible to the server.",
    {
      session_id: z
        .string()
        .describe("Rental session id whose latest quota snapshot to read."),
      provider: z
        .string()
        .optional()
        .describe(
          "Optional provider hint (e.g. 'antigravity', 'cursor'). Used only for an audit trail; the server returns whatever snapshot it has regardless."
        ),
    },
    async ({ session_id, provider }) =>
      rentalTextResponse(await rentalRefreshQuota(deps, { session_id, provider }))
  );

  server.tool(
    "rental_report_usage",
    "Forward an already-built IngestUsageReport to the rental usage ingest endpoint (POST /api/rental/sessions/:id/usage). The desktop meter adapter is the canonical source of these reports, so MCP-side use should be limited to tool-mediated steps the desktop adapter pipeline does not observe. See spec §17.7 / §19.6 for the report shape; the server validates and rejects malformed input. SCOPE: this tool ONLY persists to rental_usage_meters; it does NOT advance Budget Sentinel state. Callers that need budget gates to update (e.g. trigger budget.reconciled / budget.exhausted events) must separately invoke the Budget Sentinel reconcile endpoint (POST /api/rental/sessions/:id/budget/reconcile — p2.8b) or a future rental_reconcile_budget MCP tool.",
    {
      session_id: z.string().describe("Rental session id to report against."),
      report: z
        .record(z.string(), z.unknown())
        .describe(
          "Pre-built IngestUsageReport object (source, snapshot, delta, lrt, idempotencyKey, etc.). Forwarded verbatim."
        ),
    },
    async ({ session_id, report }) =>
      rentalTextResponse(await rentalReportUsage(deps, { session_id, report }))
  );

  server.tool(
    "rental_request_budget_extension",
    "Request additional LRT for a Rent an Agent session. This creates a pending budget.extension_requested activity event only; it does not grant budget and cannot approve itself. A renter must approve the request through the renter-side budget-extension approval route before the session lrt_limit changes.",
    {
      session_id: z.string().describe("Rental session id that needs more LRT."),
      requested_additional_lrt: z
        .number()
        .int()
        .positive()
        .describe("Positive amount of additional LRT requested."),
      reason: z
        .string()
        .optional()
        .describe("Optional short reason shown to the renter."),
    },
    async ({ session_id, requested_additional_lrt, reason }) =>
      rentalTextResponse(
        await rentalRequestBudgetExtension(deps, {
          session_id,
          requested_additional_lrt,
          reason,
        })
      )
  );
}
