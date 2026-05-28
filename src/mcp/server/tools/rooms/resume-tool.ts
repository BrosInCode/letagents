import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  RepoRoomAuthRequiredError,
  ensureAgentIdentity,
  getStoredCurrentRoom,
  getStoredRoomSession,
  joinRoomIdentifier,
  toPublicAgentIdentity,
  toPublicRoomState,
  toRepoRoomAuthRequiredResult,
  withJoinRoomAgentPrompt,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

export function registerRoomResumeTool(server: McpServer): void {
  server.tool(
    "resume_room_session",
    "Rejoin the last locally saved room context, or a specific saved room, after a restart. This recreates participation in the room; it does not preserve a prior server-side session ID.",
    {
      room_id: z
        .string()
        .optional()
        .describe("Optional saved room ID to resume. Defaults to the last current room."),
    },
    async ({ room_id }) => {
      const savedRoom =
        (room_id ? getStoredRoomSession(room_id) : null) ??
        getStoredCurrentRoom();

      if (!savedRoom) {
        return jsonToolResponse({ success: false, error: "No saved room session found." });
      }

      try {
        const joined = await joinRoomIdentifier(savedRoom.room_id, savedRoom.joined_via);
        const agentIdentity = await ensureAgentIdentity();

        return jsonToolResponse(
          withJoinRoomAgentPrompt({
            success: true,
            rejoined_from_local_state: true,
            server_session_resumed: false,
            last_message_id_before_restart: savedRoom.last_message_id ?? null,
            room: toPublicRoomState(joined.room),
            agent_identity: toPublicAgentIdentity(agentIdentity),
          })
        );
      } catch (error) {
        if (error instanceof RepoRoomAuthRequiredError) {
          return jsonToolResponse(toRepoRoomAuthRequiredResult(error));
        }

        throw error;
      }
    }
  );
}
