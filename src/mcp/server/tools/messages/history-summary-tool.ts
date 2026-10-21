import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ROOM_HISTORY_DEFAULT_VIEW_LINES,
  ROOM_HISTORY_MAX_VIEW_LINES,
  ROOM_HISTORY_MIN_VIEW_LINES,
  parseRoomHistoryNodeId,
  type RoomHistoryExpansion,
  type RoomHistorySummaryView,
} from "../../../../../shared/room-history-summary.mjs";
import { encodeRoomIdPath } from "../../../room-id.js";
import { getTargetRoomId, isLocalRoomStorageEnabled, roomScopedApiCall } from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

const roomField = { room_id: z.string().optional().describe("Room ID; defaults to the current room.") };

const unavailable = (reason: string) => jsonToolResponse({ ok: false, code: "history_summary_unavailable", message:
  `${reason} Use read_messages for recent messages instead.` });

async function cloudRoom(explicit?: string): Promise<string | null> {
  const roomId = getTargetRoomId(explicit);
  return roomId && !await isLocalRoomStorageEnabled(roomId) ? roomId : null;
}

export function registerHistorySummaryTools(server: McpServer): void {
  server.tool("get_room_history_summary",
    "Read a summary of this room's whole history in one bounded view: recent messages one line each, older stretches in broader lines. "
    + "Use it to catch up on a room before working in it, or to find when something was discussed. Each line names the messages it covers "
    + "and a node id: pass the node to expand_room_history_summary to see the two lines under it, down to the original message. "
    + "Lines are lossy summaries written by a small model: expand a line before relying on its details. "
    + "Messages newer than covered_through_message_id are not in it; read them with read_messages.", {
      ...roomField,
      max_lines: z.number().int().min(ROOM_HISTORY_MIN_VIEW_LINES).max(ROOM_HISTORY_MAX_VIEW_LINES).optional()
        .describe(`The most lines to return (default ${ROOM_HISTORY_DEFAULT_VIEW_LINES}). Fewer lines cover the same history more broadly.`),
    }, async ({ room_id, max_lines }) => {
      const roomId = await cloudRoom(room_id);
      if (!roomId) return unavailable("History summaries exist only for rooms on the LetAgents server.");
      const query = max_lines ? `?max_lines=${max_lines}` : "";
      try {
        const view = await roomScopedApiCall<RoomHistorySummaryView>({ room_id: roomId,
          project_path: () => { throw new Error("Use a Room."); },
          room_path: (id) => `/rooms/${encodeRoomIdPath(id)}/history-summary${query}`,
          options: { signal: AbortSignal.timeout(15_000) } });
        if (view.state === "off") return unavailable("This room's admins turned history summaries off.");
        if (view.state === "unavailable") return unavailable("This LetAgents server writes no history summaries.");
        return jsonToolResponse(view);
      } catch (error) {
        return unavailable(`The history summary could not be read (${error instanceof Error ? error.message : "unknown error"}).`);
      }
    });

  server.tool("expand_room_history_summary",
    "Open one line of the room history summary into the two lines it was made from. A line that covers one message gives the message itself. "
    + "Repeat on a returned line to go deeper.", {
      ...roomField,
      node: z.string().regex(/^\d{1,2}:\d{1,9}$/).describe("The node id of a line, for example \"4:12\"."),
    }, async ({ room_id, node }) => {
      const parsed = parseRoomHistoryNodeId(node);
      if (!parsed) return jsonToolResponse({ ok: false, error: "node must look like \"4:12\"." });
      const roomId = await cloudRoom(room_id);
      if (!roomId) return unavailable("History summaries exist only for rooms on the LetAgents server.");
      try {
        return jsonToolResponse(await roomScopedApiCall<RoomHistoryExpansion>({ room_id: roomId,
          project_path: () => { throw new Error("Use a Room."); },
          room_path: (id) => `/rooms/${encodeRoomIdPath(id)}/history-summary/nodes/${parsed.level}:${parsed.index}`,
          options: { signal: AbortSignal.timeout(15_000) } }));
      } catch (error) {
        return jsonToolResponse({ ok: false, error: `The line could not be expanded (${error instanceof Error ? error.message : "unknown error"}).` });
      }
    });
}
