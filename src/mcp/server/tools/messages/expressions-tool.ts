import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createGiphyClient } from "../../../../../shared/giphy-client.mjs";
import { normalizeMessageReactionEmoji } from "../../../../../shared/message-reactions.mjs";
import { ROOM_EXPRESSION_GUIDANCE } from "../../../../../shared/room-expressions.mjs";
import { encodeRoomIdPath } from "../../../room-id.js";
import { agentSessionCredentials, getTargetRoomId, isLocalRoomStorageEnabled, resolveWorkerToolIdentity, roomScopedApiCall } from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

const giphy = createGiphyClient();
const roomFields = {
  room_id: z.string().optional().describe("Room ID; defaults to the current room."),
  agent_session_id: z.string().optional().describe("Registered worker session for this chat."),
};
const unavailable = () => jsonToolResponse({ ok: false, code: "expressions_unavailable",
  message: "The expression was not confirmed. Continue the work; use text if an answer is needed, otherwise finish without another reply. Do not keep retrying." });

async function cloudRoom(explicit?: string): Promise<string | null> {
  const roomId = getTargetRoomId(explicit);
  return roomId && !await isLocalRoomStorageEnabled(roomId) ? roomId : null;
}

export function registerExpressionTools(server: McpServer): void {
  server.tool("search_gifs", `Search GIPHY for an occasional room expression. Search a short mood or phrase, never private room content. ${ROOM_EXPRESSION_GUIDANCE}`, {
    ...roomFields, query: z.string().min(1).max(50),
  }, async ({ room_id, agent_session_id, query }) => {
    try {
      const roomId = await cloudRoom(room_id); if (!roomId) return unavailable();
      await resolveWorkerToolIdentity({ roomId, agentSessionId: agent_session_id });
      const config = await roomScopedApiCall<{ enabled: boolean; api_key: string | null }>({ room_id: roomId, project_path: () => { throw new Error("Use a Room."); },
        room_path: id => `/rooms/${encodeRoomIdPath(id)}/gif-client-config`, options: { signal: AbortSignal.timeout(4000) } });
      if (!config.enabled) return unavailable();
      const result = await giphy.search(config.api_key ?? "", query);
      // Model context and durable tool results contain only stable IDs/titles.
      // API credentials and temporary media URLs stay inside this client.
      return jsonToolResponse(result.ok ? { ok: true, provider: "giphy", items: result.items.map(({ id, title }) => ({ id, title })) } : result);
    } catch { return unavailable(); }
  });

  server.tool("react_to_message", `Add or remove your own emoji reaction. It appears as you, not your human owner. A reaction is not approval, consensus, or completion; finish the turn normally. ${ROOM_EXPRESSION_GUIDANCE}`, {
    ...roomFields,
    message_id: z.string().regex(/^msg_\d+$/),
    emoji: z.string(),
    remove: z.boolean().optional().describe("Remove your own reaction. Repeated adds/removes are safe; this never toggles."),
  }, async ({ room_id, agent_session_id, message_id, emoji: raw, remove }) => {
    const emoji = normalizeMessageReactionEmoji(raw);
    if (!emoji) return jsonToolResponse({ ok: false, error: "Choose one emoji." });
    try {
      const roomId = await cloudRoom(room_id); if (!roomId) return unavailable();
      const { agentSession } = await resolveWorkerToolIdentity({ roomId, agentSessionId: agent_session_id });
      const response = await roomScopedApiCall<{ changed: boolean }>({ room_id: roomId, project_path: () => { throw new Error("Use a Room."); },
        room_path: id => `/rooms/${encodeRoomIdPath(id)}/messages/${message_id}/reactions/${encodeURIComponent(emoji)}`,
        options: { method: remove ? "DELETE" : "PUT", signal: AbortSignal.timeout(5000), body: JSON.stringify(agentSessionCredentials(agentSession)) } });
      return jsonToolResponse({ ok: true, message_id, emoji, removed: remove === true, changed: response.changed });
    } catch { return unavailable(); }
  });
}
