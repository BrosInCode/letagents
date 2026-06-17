import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  appendIncludePromptOnly,
  currentRoom,
  getLocalChatMessages,
  getStoredCurrentRoom,
  getStoredRoomSession,
  getTargetRoomId,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  roomScopedApiCall,
  toAgentReadableMessages,
} from "./runtime.js";
import { encodeRoomIdPath } from "../room-id.js";

export function registerRoomResources(server: McpServer): void {
  // ---------------------------------------------------------------------------
  // MCP Resources
  // ---------------------------------------------------------------------------

  server.resource(
    "room_messages",
    new ResourceTemplate("letagents://rooms/{room_id}/messages", {
      list: undefined,
    }),
    async (uri, { room_id }) => {
      const normalizedRoomId = String(room_id);
      const targetRoomId = getTargetRoomId(normalizedRoomId) ?? normalizedRoomId;
      if (targetRoomId && await isLocalRoomStorageEnabled(targetRoomId)) {
        const { localRoomId } = await resolveLocalRoomStorageIdentifiers(targetRoomId);
        const effectiveLocalRoomId = localRoomId || targetRoomId;
        const allMessages: unknown[] = [];
        let afterCursor: string | undefined;

        for (;;) {
          const result = await getLocalChatMessages(effectiveLocalRoomId, {
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

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ messages: toAgentReadableMessages(allMessages) }, null, 2),
            },
          ],
        };
      }

      const storedSession =
        getStoredRoomSession(normalizedRoomId) ??
        (currentRoom?.room_id === normalizedRoomId ? getStoredCurrentRoom() : null);

      // Paginate through all pages to return full message history
      const allMessages: unknown[] = [];
      let afterCursor: string | undefined;

      for (;;) {
        const query = new URLSearchParams();
        if (afterCursor) query.set("after", afterCursor);
        const qs = query.toString();

        const result = await roomScopedApiCall<{
          messages?: Array<{ id?: string }>;
          has_more?: boolean;
        }>({
          room_id: normalizedRoomId,
          project_id: storedSession?.project_id ?? null,
          room_path: (targetRoomId) =>
            appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages${qs ? `?${qs}` : ""}`),
          project_path: (projectId) =>
            appendIncludePromptOnly(`/projects/${encodeURIComponent(projectId)}/messages${qs ? `?${qs}` : ""}`),
        });

        const msgs = result.messages ?? [];
        allMessages.push(...msgs);

        if (!result.has_more || msgs.length === 0) break;
        const lastMsg = msgs[msgs.length - 1];
        if (!lastMsg?.id) break;
        afterCursor = lastMsg.id;
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ messages: toAgentReadableMessages(allMessages) }, null, 2),
          },
        ],
      };
    }
  );
}
