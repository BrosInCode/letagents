import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_ROOM_REPLY_BYTES = 32 * 1024;

function completionResponse(outcome: "reply" | "no_reply"): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const payload = {
    accepted: true,
    outcome,
    instruction: "The daemon recorded this exact turn completion. End the provider turn without sending the activating reply through another tool.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Cursor's documented terminal `result` is the concatenation of every
 * assistant delta, including progress narration. A supervised provider must
 * therefore propose its public reply over a distinct, turn-scoped channel.
 *
 * This tool is registered only for `supervised_room_turn`. The normal
 * supervised tool facade binds it to the exact provider turn and commits its
 * request/result through the durable bounded-effect journal before the daemon
 * will consider it publishable.
 */
export function registerSupervisedRoomTurnTools(server: McpServer): void {
  server.tool(
    "complete_room_turn",
    "Record the single public completion for this supervised room turn. Call exactly once after all work is finished. Progress text outside this tool is live activity only and is never published as the room reply.",
    {
      outcome: z.enum(["reply", "no_reply"]).describe("Use reply to publish one answer, or no_reply when the activating message needs no response."),
      text: z.string().optional().describe("The concise public room reply. Required only when outcome is reply."),
    },
    async ({ outcome, text }) => {
      const normalized = text?.trim() ?? "";
      if (outcome === "reply") {
        if (!normalized) throw new Error("complete_room_turn requires non-empty text when outcome is reply.");
        if (Buffer.byteLength(normalized, "utf8") > MAX_ROOM_REPLY_BYTES) {
          throw new Error("complete_room_turn reply exceeds the 32 KiB public-message limit.");
        }
      } else if (normalized) {
        throw new Error("complete_room_turn must omit text when outcome is no_reply.");
      }
      return completionResponse(outcome);
    },
  );
}
