import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MAX_ROOM_REPLY_BYTES = 32 * 1024;

/** Select routing only; the daemon remains the sole final-answer publisher. */
export function registerReplyThreadTool(server: McpServer): void {
  const gifTool = server.tool("set_reply_gif",
    "Attach one GIF from search_gifs to your final room reply, or pass gif:null to clear it. This records an intent only, sends nothing, and does not complete the turn. Finish normally with a reply and meaningful text; that text is the fallback if the GIF is unavailable. For a GIF-only visual reply set text_fallback_only:true. A no_reply outcome always sends nothing, including no GIF. Use sparingly and never replace requested reasoning or work.",
    { gif: z.object({ provider: z.literal("giphy"), id: z.string().regex(/^[a-zA-Z0-9]{1,128}$/), title: z.string().max(200), text_fallback_only: z.literal(true).optional() }).strict().nullable() },
    async () => { throw new Error("set_reply_gif requires the active daemon-owned room turn."); },
  );
  // The local-room facade intentionally omits unsupported cloud-only tools.
  if (gifTool) gifTool.inputSchema = z.object({ gif: z.object({ provider: z.literal("giphy"), id: z.string().regex(/^[a-zA-Z0-9]{1,128}$/), title: z.string().max(200), text_fallback_only: z.literal(true).optional() }).strict().nullable() }).strict();
  const attachmentFiles = z.array(z.string().min(1).max(4096)).min(1).max(4).nullable();
  const attachmentsTool = server.tool("set_reply_attachments",
    "Attach up to 4 files from your workspace to your final room reply, such as a screenshot, a short screen recording, a log or a report that shows your result. Pass paths relative to your working directory, or absolute paths inside it. The daemon copies the files when you call this, so save them first; later edits are not sent. Each file can be up to 25 MB. Files outside your workspace and files that may hold credentials (.env, keys, .git, .ssh) are refused. A single self-contained .html file opens in the LetAgents desktop app as an interactive demo in a locked window that cannot load anything over the network: put all CSS, JavaScript and images (as data: URLs) inside the file. This records an intent only, sends nothing, and does not complete the turn: finish with a normal reply and meaningful text. Call again to replace the files, or pass files:null to clear them. A no_reply outcome sends nothing.",
    { files: attachmentFiles },
    async () => { throw new Error("set_reply_attachments requires the active daemon-owned room turn."); },
  );
  if (attachmentsTool) attachmentsTool.inputSchema = z.object({ files: attachmentFiles }).strict();
  const tool = server.tool(
    "set_reply_thread",
    "Opt into a new thread for your final answer only when the user asks for one or a sustained side discussion would distract from the room. Answer ordinary top-level questions in the main room by default, without this tool; existing thread replies stay threaded automatically. Takes no arguments, sends no message, and does not finish the turn. Continue working and use your normal final completion when ready. Unavailable for synthetic task continuations or corrections.",
    {},
    async () => { throw new Error("set_reply_thread requires the active daemon-owned room turn."); },
  );
  // The legacy raw-shape overload strips unknown keys. Preserve a strict schema
  // so a caller cannot mistake ignored room/recipient/text arguments for authority.
  tool.inputSchema = z.object({}).strict();
}

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
