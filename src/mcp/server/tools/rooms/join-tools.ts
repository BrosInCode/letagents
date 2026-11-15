import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  RepoRoomAuthRequiredError,
  createInviteRoom,
  joinInviteCode,
  joinNamedRoomOrInviteCode,
  normalizeJoinSessionMode,
  toRepoRoomAuthRequiredResult,
  withJoinRoomAgentPrompt,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

const JOIN_CODE_DESCRIPTION =
  "Join a room with an invite code. A one-use invite code (XXXX-XXXX, e.g. 'K7QM-4XPD') that a room member made "
  + "for you lets your account into a members-only room, or asks a room admin to let you in when a member made it. "
  + "It works one time. A room's own code (XXXX-XXXX-XXXX) joins a room you are already a member of.";
const JOIN_CODE_INPUT_DESCRIPTION = "The invite code you were given (e.g. 'K7QM-4XPD'), or a room's code (e.g. 'ABCX-7291-QWER')";

const joinSessionModeSchema = z
  .string()
  .optional()
  .describe("Only 'current' (the default), a normal inline join. The 'live' mode was removed in letagents 0.12.46; run Codex agents from the LetAgents desktop app.");

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
    JOIN_CODE_DESCRIPTION,
    {
      code: z.string().describe(JOIN_CODE_INPUT_DESCRIPTION),
      session_mode: joinSessionModeSchema,
    },
    async ({ code, session_mode }) =>
      jsonToolResponse(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)))
  );

  server.tool(
    "join_project",
    "Legacy alias for join_code. Join an existing room using an invite code.",
    {
      code: z.string().describe(JOIN_CODE_INPUT_DESCRIPTION),
      session_mode: joinSessionModeSchema,
    },
    async ({ code, session_mode }) =>
      jsonToolResponse(await joinInviteCode(code, normalizeJoinSessionMode(session_mode)))
  );

  server.tool(
    "join_room",
    "Join a named room on Let Agents Chat. Creates the room if it doesn't exist. Use this for repo-based room joining. "
      + "If someone gave you an invite code (XXXX-XXXX), use join_code with it instead.",
    {
      name: z.string().describe("The room name to join (e.g. 'github.com/owner/repo')"),
      session_mode: joinSessionModeSchema,
    },
    async ({ name, session_mode }) => {
      try {
        return jsonToolResponse(await joinNamedRoomOrInviteCode(name, normalizeJoinSessionMode(session_mode)));
      } catch (error) {
        if (error instanceof RepoRoomAuthRequiredError) {
          return jsonToolResponse(toRepoRoomAuthRequiredResult(error));
        }

        throw error;
      }
    }
  );
}
