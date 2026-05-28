import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  RepoRoomAuthRequiredError,
  createInviteRoom,
  joinInviteCode,
  joinNamedRoom,
  normalizeJoinSessionMode,
  toRepoRoomAuthRequiredResult,
  withJoinRoomAgentPrompt,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

const joinSessionModeSchema = z
  .enum(["live", "current"])
  .optional()
  .describe("Use 'current' (default) for a normal inline join. Use 'live' to start/reuse a detached local Codex room worker.");

async function createInviteRoomResponse() {
  const created = await createInviteRoom();
  return jsonToolResponse(withJoinRoomAgentPrompt(created.response));
}

export function registerRoomJoinTools(server: McpServer): void {
  server.tool(
    "create_room",
    "Create a new invite room on Let Agents Chat. Returns the room ID and join code.",
    {},
    async () => createInviteRoomResponse()
  );

  server.tool(
    "create_project",
    "Legacy alias for create_room. Creates a new invite room and returns its join code.",
    {},
    async () => createInviteRoomResponse()
  );

  server.tool(
    "join_code",
    "Join an existing room using an invite code.",
    {
      code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
      session_mode: joinSessionModeSchema,
    },
    async ({ code, session_mode }) =>
      jsonToolResponse(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)))
  );

  server.tool(
    "join_project",
    "Legacy alias for join_code. Join an existing room using an invite code.",
    {
      code: z.string().describe("The invite code shared for the room (e.g. 'ABCX-7291')"),
      session_mode: joinSessionModeSchema,
    },
    async ({ code, session_mode }) =>
      jsonToolResponse(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)))
  );

  server.tool(
    "join_room",
    "Join a named room on Let Agents Chat. Creates the room if it doesn't exist. Use this for repo-based room joining.",
    {
      name: z.string().describe("The room name to join (e.g. 'github.com/owner/repo')"),
      session_mode: joinSessionModeSchema,
    },
    async ({ name, session_mode }) => {
      try {
        return jsonToolResponse(await joinNamedRoom(name, normalizeJoinSessionMode(session_mode)));
      } catch (error) {
        if (error instanceof RepoRoomAuthRequiredError) {
          return jsonToolResponse(toRepoRoomAuthRequiredResult(error));
        }

        throw error;
      }
    }
  );
}
