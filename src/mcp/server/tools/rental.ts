import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  rentalAccept,
  rentalCancel,
  rentalComplete,
  rentalDecline,
  rentalEmitActivity,
  rentalHeartbeat,
  rentalListRequests,
  rentalProposeEdit,
  rentalProposePatch,
  rentalProvision,
  rentalReadFile,
  rentalRefreshQuota,
  rentalRequestBudgetExtension,
  rentalReportUsage,
  rentalRunCommand,
  rentalSearch,
} from "../../rental-tools.js";
import { apiCall } from "../runtime.js";

export function registerRentalTools(server: McpServer): void {
  // ===========================================================================
  // ===== RENTAL TOOLS (p3.1) =================================================
  // ===========================================================================
  //
  // MCP tools that let an agent acting as a Rent an Agent provider poll for
  // incoming session requests and accept/decline them. All three wrap
  // /api/rental/provider/* and are gated server-side by LETAGENTS_RENT_ENABLED.
  //
  // Handler logic lives in `./rental-tools.ts` so it can be unit-tested without
  // booting an MCP transport. The registrations here are thin wrappers that
  // inject the live `apiCall` and shape the response into the MCP content
  // envelope.
  //
  // Spec refs: §6 (provider listing flow), §18.2 (accept/decline state
  // transitions). Plan: docs/RENT_AN_AGENT_TASK_BREAKDOWN.md PR p3.1.

  const rentalToolDeps = { apiCall };

  server.tool(
    "rental_list_requests",
    "List incoming Rent an Agent session requests for the authenticated provider. Returns an array of session objects in the 'requested' state. Use this to poll while you are available to host renters.",
    {},
    async () => {
      const result = await rentalListRequests(rentalToolDeps);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
    async ({ session_id, idempotency_key }) => {
      const result = await rentalAccept(rentalToolDeps, {
        session_id,
        idempotency_key,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_provision",
    "Provision an accepted Rent an Agent session into a rental room. Creates the provider-visible rental room, moves the session to 'provisioning', and returns the room id. Call this after rental_accept and before rental_heartbeat.",
    {
      session_id: z
        .string()
        .describe("Rental session id to provision."),
      parent_room_id: z
        .string()
        .describe("Parent room id/identifier where the renter started the session."),
      provider_display_name: z
        .string()
        .optional()
        .describe("Optional display name for the provider participant in the rental room."),
    },
    async ({ session_id, parent_room_id, provider_display_name }) => {
      const result = await rentalProvision(rentalToolDeps, {
        session_id,
        parent_room_id,
        provider_display_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_decline",
    "Decline a pending Rent an Agent session request. Transitions the session from 'requested' to 'cancelled' per spec §18.2. An optional reason is forwarded in the request body.",
    {
      session_id: z
        .string()
        .describe("Rental session id to decline."),
      idempotency_key: z
        .string()
        .optional()
        .describe("Optional caller-chosen idempotency key. Forwarded to the server when provided."),
      reason: z
        .string()
        .optional()
        .describe("Optional short reason forwarded in the decline body (e.g. 'busy', 'out of quota')."),
    },
    async ({ session_id, idempotency_key, reason }) => {
      const result = await rentalDecline(rentalToolDeps, {
        session_id,
        idempotency_key,
        reason,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Heartbeat / usage tools (p3.2)
  // ---------------------------------------------------------------------------
  //
  // rental_heartbeat keeps a provider session marked "active" — the
  // server expires sessions that go silent past §18.3's 15-minute
  // window. Agents acting as providers should call this on a 30s
  // cadence per spec.
  //
  // rental_report_usage forwards an already-built IngestUsageReport
  // (the shape persisted to rental_usage_meters in p2.2). Use it
  // when the MCP-side agent has a tool-mediated usage step that the
  // desktop meter adapter pipeline cannot observe — most commonly:
  // the agent ran a step in a worker that lives outside the
  // desktop adapter scope.

  server.tool(
    "rental_heartbeat",
    "Beat the heart of an active Rent an Agent provider session. Records last_heartbeat_at and transitions provisioning → active on the first beat. Provider-only; the server returns not_provider when the caller does not own the lane. Call on a 30s cadence per spec §18.3.",
    {
      session_id: z.string().describe("Rental session id to heartbeat."),
    },
    async ({ session_id }) => {
      const result = await rentalHeartbeat(rentalToolDeps, { session_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
          "Optional provider hint (e.g. 'antigravity', 'cursor'). Used only for an audit trail; the server returns whatever snapshot it has regardless.",
        ),
    },
    async ({ session_id, provider }) => {
      const result = await rentalRefreshQuota(rentalToolDeps, {
        session_id,
        provider,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_report_usage",
    "Forward an already-built IngestUsageReport to the rental usage ingest endpoint (POST /api/rental/sessions/:id/usage). The desktop meter adapter is the canonical source of these reports, so MCP-side use should be limited to tool-mediated steps the desktop adapter pipeline does not observe. See spec §17.7 / §19.6 for the report shape; the server validates and rejects malformed input. SCOPE: this tool ONLY persists to rental_usage_meters; it does NOT advance Budget Sentinel state. Callers that need budget gates to update (e.g. trigger budget.reconciled / budget.exhausted events) must separately invoke the Budget Sentinel reconcile endpoint (POST /api/rental/sessions/:id/budget/reconcile — p2.8b) or a future rental_reconcile_budget MCP tool.",
    {
      session_id: z.string().describe("Rental session id to report against."),
      report: z
        .record(z.string(), z.unknown())
        .describe(
          "Pre-built IngestUsageReport object (source, snapshot, delta, lrt, idempotencyKey, etc.). Forwarded verbatim.",
        ),
    },
    async ({ session_id, report }) => {
      const result = await rentalReportUsage(rentalToolDeps, {
        session_id,
        report,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
    async ({ session_id, requested_additional_lrt, reason }) => {
      const result = await rentalRequestBudgetExtension(rentalToolDeps, {
        session_id,
        requested_additional_lrt,
        reason,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Context Broker tools (p4.4)
  // ---------------------------------------------------------------------------

  server.tool(
    "rental_read_file",
    "Read one repo-relative file from the scoped rental workspace through the Context Broker. The server applies the Secret Firewall, records an Exposure Ledger entry, and returns redacted content when needed. This is the only approved file-read path for provider agents in scoped mode.",
    {
      session_id: z.string().describe("Rental session id whose scoped workspace to read."),
      path: z.string().describe("Repo-relative file path inside the materialized rental workspace."),
      max_bytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional maximum file size to return. Defaults server-side to 256 KiB."),
    },
    async ({ session_id, path, max_bytes }) => {
      const result = await rentalReadFile(rentalToolDeps, {
        session_id,
        path,
        max_bytes,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_search",
    "Search literal text across the scoped rental workspace through the Context Broker. Matching snippets are Secret Firewall scanned and recorded as search_result exposures, but search results alone do not authorize Patch Gate edits.",
    {
      session_id: z.string().describe("Rental session id whose scoped workspace to search."),
      query: z.string().describe("Literal text query to search for."),
      max_results: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Maximum snippets to return. Defaults server-side to 20, capped at 100."),
      case_sensitive: z
        .boolean()
        .optional()
        .describe("Set true for case-sensitive literal search. Defaults to false."),
    },
    async ({ session_id, query, max_results, case_sensitive }) => {
      const result = await rentalSearch(rentalToolDeps, {
        session_id,
        query,
        max_results,
        case_sensitive,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Patch and command tools (p5.3)
  // ---------------------------------------------------------------------------

  server.tool(
    "rental_propose_edit",
    "Append one whole-file edit to the Signed Change Journal for a rental session. This records an idempotent, tool-mediated edit and returns the reconstructed diff; Patch Gate validation happens through rental_propose_patch.",
    {
      session_id: z.string().describe("Rental session id."),
      idempotency_key: z.string().describe("Unique key for this edit request."),
      path: z.string().describe("Repo-relative file path being edited."),
      before_content: z.string().describe("Original file content the agent saw."),
      after_content: z.string().describe("Proposed full replacement content."),
      summary: z.string().optional().describe("Optional edit summary."),
    },
    async ({ session_id, idempotency_key, path, before_content, after_content, summary }) => {
      const result = await rentalProposeEdit(rentalToolDeps, {
        session_id,
        idempotency_key,
        path,
        before_content,
        after_content,
        summary,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_propose_patch",
    "Submit a full-content patch proposal for Patch Gate validation. Every file must have been exposed through the Context Broker; the server applies path checks, Secret Firewall scanning, and records the gate result for renter review.",
    {
      session_id: z.string().describe("Rental session id."),
      idempotency_key: z.string().describe("Unique key for this patch proposal."),
      files: z
        .array(z.object({
          path: z.string(),
          operation: z.enum(["modify", "create", "delete"]),
          content: z.string().optional(),
          diff: z.string().optional(),
        }))
        .nonempty()
        .describe("Patch files. modify/create require full content; diff-only proposals are rejected server-side."),
      summary: z.string().optional().describe("Optional patch summary."),
    },
    async ({ session_id, idempotency_key, files, summary }) => {
      const result = await rentalProposePatch(rentalToolDeps, {
        session_id,
        idempotency_key,
        files,
        summary,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "rental_run_command",
    "Run a policy-checked test or verification command in the scoped rental workspace. Input must be an argv array; shell syntax, install/network/publish commands, and non-test commands are blocked.",
    {
      session_id: z.string().describe("Rental session id."),
      argv: z
        .array(z.string())
        .nonempty()
        .describe("Command argv, e.g. [\"npm\", \"test\"] or [\"node\", \"--test\", \"src/api/__tests__/foo.test.ts\"]."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(120_000)
        .optional()
        .describe("Optional timeout in milliseconds. Defaults server-side to 60000, capped at 120000."),
    },
    async ({ session_id, argv, timeout_ms }) => {
      const result = await rentalRunCommand(rentalToolDeps, {
        session_id,
        argv,
        timeout_ms,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------------
  // Activity lifecycle tools (p3.3)
  // ---------------------------------------------------------------------------

  server.tool(
    "rental_emit_activity",
    "Emit an activity event into a rental session's event log (rental_activity_events table). The event is unverified by default per §9.4 — only tool-mediated event types are auto-verified server-side. Use this to record agent notes, progress updates, or custom milestones visible to the renter.",
    {
      session_id: z.string().describe("Rental session id."),
      event_type: z
        .string()
        .describe(
          "Activity event type from §9.4 taxonomy (e.g. 'agent.note', 'edit.proposed'). Must be a known type.",
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Event source: 'agent', 'tool', 'patch_gate', 'system', 'renter', 'provider'. Defaults to 'agent'.",
        ),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arbitrary JSON payload for the event. Defaults to {}."),
      verified: z
        .boolean()
        .optional()
        .describe(
          "Override verification status. If omitted, the server resolves from the event type set.",
        ),
    },
    async ({ session_id, event_type, source, payload, verified }) => {
      const result = await rentalEmitActivity(rentalToolDeps, {
        session_id,
        event_type,
        source,
        payload,
        verified,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
          "Optional completion summary describing what was accomplished during the session.",
        ),
    },
    async ({ session_id, summary }) => {
      const result = await rentalComplete(rentalToolDeps, {
        session_id,
        summary,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
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
          "Optional reason for cancellation (e.g. 'budget_exhausted', 'renter_revoked').",
        ),
    },
    async ({ session_id, reason }) => {
      const result = await rentalCancel(rentalToolDeps, {
        session_id,
        reason,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ===========================================================================
  // ===== END RENTAL TOOLS ===================================================
  // ===========================================================================
}
