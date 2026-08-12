import { z } from "zod";

import {
  rentalReadFile,
  rentalRequestContext,
  rentalSearch,
} from "../../../rental-tools.js";
import { rentalTextResponse } from "./response.js";
import type { RentalToolRegistrationContext } from "./types.js";

export function registerRentalContextTools({
  server,
  deps,
}: RentalToolRegistrationContext): void {
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
    async ({ session_id, path, max_bytes }) =>
      rentalTextResponse(await rentalReadFile(deps, { session_id, path, max_bytes }))
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
    async ({ session_id, query, max_results, case_sensitive }) =>
      rentalTextResponse(
        await rentalSearch(deps, {
          session_id,
          query,
          max_results,
          case_sensitive,
        })
      )
  );

  server.tool(
    "rental_request_context",
    "Request renter approval to access a file outside the approved rental scope. Use this when rental_read_file returns file_not_found for a path you believe exists in the repo. Creates a pending context access request the renter can approve or deny; once approved, the file is materialized into the workspace and becomes readable via rental_read_file. Repeat calls for the same path return the existing pending request, and re-asking for an already-approved path retries delivery into the workspace (useful if the workspace was not ready at approval time).",
    {
      session_id: z.string().describe("Rental session id the request belongs to."),
      path: z.string().describe("Repo-relative path you need access to."),
      reason: z
        .string()
        .optional()
        .describe("Short justification shown to the renter (max 500 chars)."),
    },
    async ({ session_id, path, reason }) =>
      rentalTextResponse(
        await rentalRequestContext(deps, { session_id, path, reason })
      )
  );
}
