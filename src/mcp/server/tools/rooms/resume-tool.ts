import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ApiError,
  RepoRoomAuthRequiredError,
  ensureAgentIdentity,
  getStoredCurrentRoom,
  getStoredRoomSession,
  parseApiErrorPayload,
  joinRoomIdentifierWithoutImplicitGitRefCreate,
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
        const joined = await joinRoomIdentifierWithoutImplicitGitRefCreate(
          savedRoom.room_id,
          savedRoom.joined_via
        );
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

        const payload = parseApiErrorPayload(error);
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          payload?.code === "ROOM_NOT_FOUND"
        ) {
          return jsonToolResponse({
            success: false,
            error: "Saved room no longer exists. Join the repository room or ask a human to create the branch room again.",
            code: "ROOM_NOT_FOUND",
            room_id: savedRoom.room_id,
            rejoined_from_local_state: false,
            server_session_resumed: false,
          });
        }

        throw error;
      }
    }
  );
}
