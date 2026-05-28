import { z } from "zod";

import {
  rentalProposeEdit,
  rentalProposePatch,
  rentalRunCommand,
} from "../../../rental-tools.js";
import { rentalTextResponse } from "./response.js";
import type { RentalToolRegistrationContext } from "./types.js";

export function registerRentalPatchTools({
  server,
  deps,
}: RentalToolRegistrationContext): void {
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
    async ({ session_id, idempotency_key, path, before_content, after_content, summary }) =>
      rentalTextResponse(
        await rentalProposeEdit(deps, {
          session_id,
          idempotency_key,
          path,
          before_content,
          after_content,
          summary,
        })
      )
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
    async ({ session_id, idempotency_key, files, summary }) =>
      rentalTextResponse(
        await rentalProposePatch(deps, {
          session_id,
          idempotency_key,
          files,
          summary,
        })
      )
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
    async ({ session_id, argv, timeout_ms }) =>
      rentalTextResponse(await rentalRunCommand(deps, { session_id, argv, timeout_ms }))
  );
}
