import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { autoDetectRepo } from "../../../repo-visibility.js";
import { jsonToolResponse } from "./response.js";

export function registerRepoVisibilityTool(server: McpServer): void {
  server.tool(
    "check_repo_visibility",
    "Auto-detect the current repo's git remote and check whether its Git Room should be public/discoverable or private/auth-gated. Returns the canonical key, provider, visibility, accessMode, and legacy roomType hint.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Working directory to detect git remote from. Defaults to the MCP server's working directory."),
    },
    async ({ cwd }) => {
      const result = await autoDetectRepo(cwd);

      if (!result) {
        return jsonToolResponse({
          error: "Not in a git repository or no remote configured",
          suggestion: "Pass cwd inside a git repo for Git Room detection, or join/create an ad-hoc room manually.",
        });
      }

      return jsonToolResponse(result);
    }
  );
}
