import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  agentSessionCredentials,
  currentRoom,
  getFallbackProjectId,
  getRememberedRoomPresence,
  getTargetRoomId,
  resolveWorkerToolIdentity,
  roomScopedApiCall,
  syncRoomPresence,
  toPublicAgentIdentity,
  touchCurrentRoom,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

export function registerSendMessageTool(server: McpServer): void {
  server.tool(
    "send_message",
    "Send a message to a Let Agents Chat room. Use a short nudge (e.g. continue the plan) if another participant stopped after a closing message — silence does not always mean work is finished.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      sender: z
        .string()
        .optional()
        .describe("Deprecated override. Agent identity is resolved automatically on room entry."),
      text: z.string().describe("The message text to send"),
      reply_to: z
        .string()
        .optional()
        .describe("Optional message id to quote-reply to (for example `msg_42`)."),
      conversation_id: z
        .string()
        .optional()
        .describe("Deprecated for worker writes; registered worker session identity is used."),
      agent_session_id: z
        .string()
        .optional()
        .describe("Registered agent session to use for this message. Required for worker messages."),
    },
    async ({ room_id, sender: _sender, text, reply_to, conversation_id: _conversation_id, agent_session_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      if (!targetRoomId && !targetProjectId) {
        throw new Error("No room is currently selected. Join a room first or pass room_id.");
      }

      const { identity, agentSession } = await resolveWorkerToolIdentity({
        roomId: targetRoomId ?? currentRoom?.room_id ?? null,
        agentSessionId: agent_session_id,
      });
      const message = await roomScopedApiCall<Record<string, unknown>>({
        room_id: targetRoomId,
        project_id: targetProjectId,
        room_path: (targetRoomId) => `/rooms/${encodeRoomIdPath(targetRoomId)}/messages`,
        project_path: (targetProjectId) => `/projects/${encodeURIComponent(targetProjectId)}/messages`,
        options: {
          method: "POST",
          body: JSON.stringify({
            sender: identity.actor_label,
            text,
            reply_to,
            ...agentSessionCredentials(agentSession),
          }),
        },
      });
      touchCurrentRoom(typeof (message as { id?: string }).id === "string" ? (message as { id: string }).id : undefined);
      await syncRoomPresence(
        targetRoomId ?? currentRoom?.room_id ?? null,
        identity,
        getRememberedRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, identity),
        agentSession
      );

      return jsonToolResponse({
        ...message,
        agent_identity: toPublicAgentIdentity(identity),
      });
    }
  );
}
