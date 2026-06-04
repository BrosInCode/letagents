import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  appendIncludePromptOnly,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLocalChatMessages,
  getTargetRoomId,
  heartbeatRoomPresence,
  isLocalChatStorageEnabled,
  roomScopedApiCall,
  toAgentReadableMessages,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

export function registerReadMessagesTool(server: McpServer): void {
  server.tool(
    "read_messages",
    "Read all messages from a Let Agents Chat room. For long-running work, prefer wait_for_messages with after_message_id so you only process new lines and do not treat an empty poll as the end of the mission.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
    },
    async ({ room_id }) => {
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      if (localRoomId && await isLocalChatStorageEnabled()) {
        const allMessages: unknown[] = [];
        let afterCursor: string | undefined;
        for (;;) {
          const result = await getLocalChatMessages(localRoomId, {
            after: afterCursor,
            include_prompt_only: true,
          });
          const msgs = result.messages ?? [];
          allMessages.push(...msgs);
          if (!result.has_more || msgs.length === 0) break;
          const lastMsg = msgs[msgs.length - 1];
          if (!lastMsg?.id) break;
          afterCursor = lastMsg.id;
        }
        return jsonToolResponse({
          room_id: localRoomId,
          messages: toAgentReadableMessages(allMessages),
        });
      }

      const allMessages: unknown[] = [];
      let afterCursor: string | undefined;
      let roomIdFromResponse: string | undefined;

      for (;;) {
        const query = new URLSearchParams();
        if (afterCursor) query.set("after", afterCursor);

        const qs = query.toString();
        const result = await roomScopedApiCall<{
          messages?: Array<{ id?: string }>;
          has_more?: boolean;
          room_id?: string;
          project_id?: string;
        }>({
          room_id: targetRoomId,
          project_id: targetProjectId,
          room_path: (targetRoomId) =>
            appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages${qs ? `?${qs}` : ""}`),
          project_path: (targetProjectId) =>
            appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages${qs ? `?${qs}` : ""}`),
        });

        roomIdFromResponse = roomIdFromResponse || result.room_id || result.project_id;
        const msgs = result.messages ?? [];
        allMessages.push(...msgs);

        if (!result.has_more || msgs.length === 0) break;

        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg?.id) break;
        afterCursor = lastMsg.id;
      }
      await heartbeatRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, await ensureAgentIdentity());

      const output: Record<string, unknown> = { messages: toAgentReadableMessages(allMessages) };
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }

      return jsonToolResponse(output);
    }
  );
}
