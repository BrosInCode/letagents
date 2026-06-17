import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { classifyPresenceStatusText } from "../../../agent-presence.js";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  agentSessionCredentials,
  addLocalChatMessage,
  currentRoom,
  getFallbackProjectId,
  getRememberedRoomPresence,
  getTargetRoomId,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toPublicAgentIdentity,
  touchCurrentRoom,
} from "../../runtime.js";
import { missingRoomResponse, jsonToolResponse } from "./response.js";

export function registerPostStatusTool(server: McpServer): void {
  server.tool(
    "post_status",
    "Broadcast a lightweight status update to the current room. " +
      "Use this to let other agents and humans know what you are currently doing, " +
      "e.g. 'reviewing PR #2', 'waiting for tests', 'writing WISHLIST.md'. " +
      "Status updates are distinct from chat messages and can be filtered separately.",
    {
      sender: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      status: z.string().describe("Short status description (e.g. 'reviewing PR #2', 'idle', 'thinking...')"),
      room_id: z
        .string()
        .optional()
        .describe("Canonical room ID. Defaults to the current room."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this status update. Required for worker status."),
    },
    async ({ sender: _sender, status, room_id, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();

      if (!targetRoomId && !targetProjectId) {
        return missingRoomResponse();
      }

      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const sender = identity.actor_label;
      const statusText = `[status] ${status}`;
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;

      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;
        const message = await addLocalChatMessage(effectiveLocalRoomId, {
          sender,
          text: statusText,
          source: "agent",
        });
        touchCurrentRoom(message.id);
        return jsonToolResponse({
          success: true,
          status_posted: status,
          sender,
          agent_identity: toPublicAgentIdentity(identity),
          message_id: message.id,
          timestamp: message.timestamp,
        });
      }

      await syncRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity, {
        status: classifyPresenceStatusText(
          status,
          getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity).status
        ),
        status_text: status,
      }, agentSession);
      const message = await roomScopedApiCall<Record<string, unknown>>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
        options: {
          method: "POST",
          body: JSON.stringify({
            sender,
            text: statusText,
            ...agentSessionCredentials(agentSession),
          }),
        },
      });
      touchCurrentRoom(typeof message.id === "string" ? message.id : undefined);

      return jsonToolResponse({
        success: true,
        status_posted: status,
        sender,
        agent_identity: toPublicAgentIdentity(identity),
        message_id: typeof message.id === "string" ? message.id : null,
        timestamp: typeof message.timestamp === "string" ? message.timestamp : null,
      });
    }
  );
}
