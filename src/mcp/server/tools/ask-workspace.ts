import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { roomScopedApiCall } from "../runtime.js";
import { resolveTaskToolTarget } from "./tasks/context.js";
import { jsonToolResponse, taskToolError } from "./tasks/response.js";

/**
 * Code tools for an agent someone gave to another person's room (Ask for an
 * agent). The code lives with LetAgents, not on this computer: read it and
 * propose changes here. The person who asked reviews every change.
 */
export function isGivenAgent(entryId = process.env.LETAGENTS_SUPERVISOR_ENTRY_ID): boolean {
  return Boolean(entryId?.startsWith("supervised_rental_ask_"));
}

async function call(name: "files" | "read" | "search" | "proposals", body: Record<string, unknown>) {
  const target = resolveTaskToolTarget(undefined);
  if (!target) return taskToolError("Join a room first.");
  try {
    const response = await roomScopedApiCall<{ result: unknown }>({
      room_id: target.roomId, project_id: target.projectId,
      room_path: id => `/rooms/${encodeURIComponent(id)}/agent-ask-workspace/${name}`,
      project_path: id => `/rooms/${encodeURIComponent(id)}/agent-ask-workspace/${name}`,
      options: { method: "POST", body: JSON.stringify(body) },
    });
    return jsonToolResponse(response.result);
  } catch (error) {
    return taskToolError(error instanceof Error ? error.message : String(error));
  }
}

export function registerAskWorkspaceTools(server: McpServer): void {
  server.tool("ask_list_files",
    "List files in the repo of the room you were added to. Files that may hold secrets are left out.",
    { path: z.string().max(500).optional().describe("Only list under this folder, e.g. 'src'.") },
    async ({ path }) => call("files", { path: path ?? "" }));
  server.tool("ask_read_file",
    "Read one file from the repo of the room you were added to. Secrets are removed; the person who asked can see which files you read.",
    { path: z.string().min(1).max(500).describe("Path inside the repo, e.g. 'src/auth.ts'.") },
    async ({ path }) => call("read", { path }));
  server.tool("ask_search",
    "Search the repo of the room you were added to for exact text. Returns file, line and the matching line.",
    { query: z.string().min(1).max(200) },
    async ({ query }) => call("search", { query }));
  server.tool("ask_propose_change",
    "Propose a change to the repo. Give each changed file's full new content (null deletes it). The person who asked reviews it; approved changes go into one pull request.",
    {
      summary: z.string().min(1).max(300).describe("One short sentence describing the change."),
      files: z.array(z.object({ path: z.string().min(1).max(500), content: z.string().nullable() })).min(1).max(50),
    },
    async ({ summary, files }) => call("proposals", { summary, files }));
}
