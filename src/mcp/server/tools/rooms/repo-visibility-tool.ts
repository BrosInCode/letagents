import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { autoDetectRepo } from "../../../repo-visibility.js";
import { jsonToolResponse } from "./response.js";

export function registerRepoVisibilityTool(server: McpServer): void {
  server.tool(
    "check_repo_visibility",
    "Auto-detect the current repo's git remote and check if it's public or private. Returns the canonical key, provider, visibility, and suggested room type (discoverable for public, invite for private/unknown). Useful for deciding whether to auto-join a discoverable room or create an invite room.",
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
          suggestion: "Use create_room to create an invite room instead",
        });
      }

      return jsonToolResponse(result);
    }
  );
}
