import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeRoomIdPath } from "../../../room-id.js";
import {
  appendIncludePromptOnly,
  currentRoom,
  ensureAgentIdentity,
  getFallbackProjectId,
  getLatestLocalChatMessages,
  getLocalChatMessages,
  getTargetRoomId,
  heartbeatRoomPresence,
  touchRoomSession,
  isLocalRoomStorageEnabled,
  resolveLocalRoomStorageIdentifiers,
  roomScopedApiCall,
  toAgentReadableMessages,
} from "../../runtime.js";
import { jsonToolResponse } from "./response.js";

export const DEFAULT_READ_MESSAGES_LIMIT = 100;

// Both the API and the local store clamp a single page to 500 messages.
const MAX_MESSAGES_PER_PAGE = 500;

export function selectRecentMessages(messages: unknown[], limit: number): {
  messages: unknown[];
  total_message_count: number;
  omitted_message_count: number;
} {
  const total = messages.length;
  const selected = limit > 0 && total > limit ? messages.slice(total - limit) : messages;
  return {
    messages: selected,
    total_message_count: total,
    omitted_message_count: total - selected.length,
  };
}

function withRecencyTelemetry(
  output: Record<string, unknown>,
  selection: ReturnType<typeof selectRecentMessages>,
): Record<string, unknown> {
  output.total_message_count = selection.total_message_count;
  if (selection.omitted_message_count > 0) {
    output.omitted_message_count = selection.omitted_message_count;
    output.truncated = true;
  }
  return output;
}

// Fetch the most recent messages by paging BACKWARDS from the tail
// (before=latest), so a limited read never walks the full room history.
export async function fetchRecentRemoteMessages(input: {
  targetRoomId: string | null;
  targetProjectId: string | null;
  limit: number;
}): Promise<{
  messages: unknown[];
  truncated: boolean;
  roomIdFromResponse?: string;
}> {
  const collected: unknown[] = [];
  let beforeCursor = "latest";
  let truncated = false;
  let roomIdFromResponse: string | undefined;
  let newestMessageId: string | undefined;

  for (;;) {
    const params = new URLSearchParams();
    params.set("before", beforeCursor);
    params.set("limit", String(Math.min(input.limit - collected.length, MAX_MESSAGES_PER_PAGE)));
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
    if (collected.length >= input.limit) {
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
    "Read recent messages from a Let Agents Chat room (most recent `limit`, default 100; pass limit: 0 for the full history — expensive in busy rooms). Threaded replies include thread_parent_id/thread.root_message_id; use send_thread_message with that id to continue focused side discussion without polluting the main room. For long-running work, prefer wait_for_messages with after_message_id so you only process new lines and do not treat an empty poll as the end of the mission.",
    {
      room_id: z.string().optional().describe("Canonical room ID. Defaults to the current room."),
      limit: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          `Return only the most recent N messages (default ${DEFAULT_READ_MESSAGES_LIMIT}). Pass 0 for the full history. When older messages are omitted, the response carries truncated=true.`
        ),
    },
    async ({ room_id, limit }) => {
      const effectiveLimit = limit ?? DEFAULT_READ_MESSAGES_LIMIT;
      const targetRoomId = getTargetRoomId(room_id);
      const targetProjectId = getFallbackProjectId();
      const localRoomId = targetRoomId ?? currentRoom?.room_id ?? targetProjectId;
      if (localRoomId && await isLocalRoomStorageEnabled(localRoomId)) {
        const { localRoomId: sqliteRoomId } = await resolveLocalRoomStorageIdentifiers(localRoomId);
        const effectiveLocalRoomId = sqliteRoomId || localRoomId;

        if (effectiveLimit > 0 && effectiveLimit <= MAX_MESSAGES_PER_PAGE) {
          const result = await getLatestLocalChatMessages(effectiveLocalRoomId, {
            limit: effectiveLimit,
            include_prompt_only: true,
          });
          const output: Record<string, unknown> = {
            room_id: effectiveLocalRoomId,
            messages: toAgentReadableMessages(result.messages ?? []),
          };
          if (result.has_more) output.truncated = true;
          return jsonToolResponse(output);
        }

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
        const selection = selectRecentMessages(allMessages, effectiveLimit);
        return jsonToolResponse(withRecencyTelemetry({
          room_id: effectiveLocalRoomId,
          messages: toAgentReadableMessages(selection.messages),
        }, selection));
      }

      if (effectiveLimit > 0) {
        const recent = await fetchRecentRemoteMessages({
          targetRoomId,
          targetProjectId,
          limit: effectiveLimit,
        });
        await heartbeatRoomPresence(targetRoomId ?? currentRoom?.room_id ?? null, await ensureAgentIdentity());

        const output: Record<string, unknown> = {
          messages: toAgentReadableMessages(recent.messages),
        };
        if (recent.truncated) output.truncated = true;
        if (recent.roomIdFromResponse) {
          output[targetRoomId ? "room_id" : "project_id"] = recent.roomIdFromResponse;
        }
        return jsonToolResponse(output);
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

      const selection = selectRecentMessages(allMessages, effectiveLimit);
      const output: Record<string, unknown> = withRecencyTelemetry(
        { messages: toAgentReadableMessages(selection.messages) },
        selection,
      );
      if (roomIdFromResponse) {
        output[targetRoomId ? "room_id" : "project_id"] = roomIdFromResponse;
      }

      return jsonToolResponse(output);
    }
  );
}
