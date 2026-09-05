import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  AGENT_MESSAGE_BODY_MAX_BYTES,
  appendIncludePromptOnly,
  boundAgentMessageOutput,
  buildAgentDeliveryHeaders,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLatestLocalChatMessages,
  getCurrentAgentSessionSnapshot,
  getLocalChatMessages,
  getTargetRoomId,
  heartbeatRoomPresence,
  touchRoomSession,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  roomScopedApiCall,
  toAgentReadableMessages,
} from "../../runtime.js";
import { requireValidWorkerBearerRuntime } from "../../runtime/worker-bearer.js";
import { jsonToolResponse } from "./response.js";
import { currentWorkerCall } from "../../../worker-call-context.js";

export const DEFAULT_READ_MESSAGES_LIMIT = 100;

// Both the API and the local store clamp a single page to 500 messages.
export const MAX_MESSAGES_PER_PAGE = 500;

// Fetch the most recent messages by paging BACKWARDS from the tail
// (before=latest), so a limited read never walks the full room history.
export async function fetchRecentRemoteMessages(input: {
  targetRoomId: string | null;
  targetProjectId: string | null;
  limit: number;
  deliveryHeaders?: Record<string, string>;
}): Promise<{
  messages: unknown[];
  truncated: boolean;
  roomIdFromResponse?: string;
}> {
  const boundedLimit = Math.max(1, Math.min(MAX_MESSAGES_PER_PAGE, Math.floor(input.limit)));
  const collected: unknown[] = [];
  let beforeCursor = "latest";
  let truncated = false;
  let roomIdFromResponse: string | undefined;
  let newestMessageId: string | undefined;

  for (;;) {
    const params = new URLSearchParams();
    params.set("before", beforeCursor);
    params.set("limit", String(Math.min(boundedLimit - collected.length, MAX_MESSAGES_PER_PAGE)));
    const qs = params.toString();

    const result = await roomScopedApiCall<{
      messages?: Array<{ id?: string }>;
      has_more?: boolean;
      has_older?: boolean;
      room_id?: string;
      project_id?: string;
    }>({
      room_id: input.targetRoomId,
      project_id: input.targetProjectId,
      room_path: (targetRoomId) =>
        appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(targetRoomId)}/messages?${qs}`),
      project_path: (targetProjectId) =>
        appendIncludePromptOnly(`/projects/${encodeURIComponent(targetProjectId)}/messages?${qs}`),
      // Pages after the first end on progressively OLDER messages; letting each
      // page touch the session would walk last_message_id backwards and make
      // resume_room_session replay already-read history.
      preserve_session_cursor: true,
      options: { headers: input.deliveryHeaders },
    });

    roomIdFromResponse = roomIdFromResponse || result.room_id || result.project_id;
    const msgs = result.messages ?? [];
    if (newestMessageId === undefined) {
      const newest = (msgs[msgs.length - 1] as { id?: string } | undefined)?.id;
      if (typeof newest === "string" && newest) newestMessageId = newest;
    }
    collected.unshift(...msgs);

    const hasOlder = Boolean(result.has_older ?? result.has_more);
    if (!hasOlder || msgs.length === 0) break;
    if (collected.length >= boundedLimit) {
      truncated = true;
      break;
    }
    const oldestId = (msgs[0] as { id?: string })?.id;
    if (typeof oldestId !== "string" || !oldestId) {
      truncated = true;
      break;
    }
    beforeCursor = oldestId;
  }

  if (input.targetRoomId && newestMessageId) {
    touchRoomSession(input.targetRoomId, newestMessageId);
  }

  return { messages: collected, truncated, roomIdFromResponse };
}

export function registerReadMessagesTool(server: McpServer): void {
  server.tool(
    "read_messages",
    "Read a bounded recent page from a Let Agents Chat room (most recent `limit`, default 100, maximum 500). Threaded replies include thread_parent_id/thread.root_message_id; use send_thread_message with that id to continue focused side discussion without polluting the main room. For long-running work, prefer wait_for_messages with after_message_id so you only process new lines and do not treat an empty poll as the end of the mission.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      limit: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          `Return the most recent N messages (default ${DEFAULT_READ_MESSAGES_LIMIT}, maximum ${MAX_MESSAGES_PER_PAGE}). Zero is retained for compatibility and means the bounded maximum. When older messages are omitted, the response carries truncated=true.`
        ),
    },
    async ({ room_id, limit }) => {
      const requestedLimit = limit ?? DEFAULT_READ_MESSAGES_LIMIT;
      const effectiveLimit = requestedLimit > 0
        ? Math.min(requestedLimit, MAX_MESSAGES_PER_PAGE)
        : MAX_MESSAGES_PER_PAGE;
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      const sessionRoomId = targetRoomId ?? currentRoom?.room_id ?? null;
      const workerRuntime = requireValidWorkerBearerRuntime();
      const boundWorker = currentWorkerCall();
      const agentSessionSnapshot = boundWorker ? { complete: true, session: boundWorker } : workerRuntime.mode === "owner"
        ? getCurrentAgentSessionSnapshot(sessionRoomId)
        : { complete: true, session: null };
      const agentSession = agentSessionSnapshot.session;
      const deliveryHeaders = buildAgentDeliveryHeaders(agentSession);
      if (!agentSessionSnapshot.complete) {
        throw new Error("Local agent routing state is unavailable; retry after restoring the state file.");
      }
      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const {
          localRoomId: sqliteRoomId,
          cloudRoomId,
        } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;

        const result = await getLatestLocalChatMessages(effectiveLocalRoomId, {
          limit: effectiveLimit,
          include_prompt_only: true,
        });
        const { attachLocalActivationMetadata } = await import("./wait-tool.js");
        const messages = await attachLocalActivationMetadata(
          effectiveLocalRoomId,
          result.messages ?? [],
          agentSession,
          {
            includeTaskOwnerLeases: false,
            activeSessionRoomId: cloudRoomId || sessionRoomId,
          },
        );
        const bounded = boundAgentMessageOutput(
          toAgentReadableMessages(messages),
          { direction: "suffix", maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES },
        );
        const output: Record<string, unknown> = {
          room_id: effectiveLocalRoomId,
          messages: bounded.messages,
        };
        if (result.has_more || bounded.truncated) output.truncated = true;
        if (bounded.omittedMessageCount > 0) {
          output.omitted_message_count = bounded.omittedMessageCount;
        }
        return jsonToolResponse(output);
      }

      const recent = await fetchRecentRemoteMessages({
        targetRoomId,
        targetProjectId,
        limit: effectiveLimit,
        deliveryHeaders,
      });
      if (!boundWorker) {
        await heartbeatRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, await ensureAgentIdentity());
      }

      const bounded = boundAgentMessageOutput(
        toAgentReadableMessages(recent.messages),
        { direction: "suffix", maxBytes: AGENT_MESSAGE_BODY_MAX_BYTES },
      );
      const output: Record<string, unknown> = {
        messages: bounded.messages,
      };
      if (recent.truncated || bounded.truncated) output.truncated = true;
      if (bounded.omittedMessageCount > 0) {
        output.omitted_message_count = bounded.omittedMessageCount;
      }
      if (recent.roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = recent.roomIdFromResponse;
      }

      return jsonToolResponse(output);
    }
  );
}
