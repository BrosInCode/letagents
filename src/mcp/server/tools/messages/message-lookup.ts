import { encodeRoomIdPath } from "../../../room-id.js";
import {
  ApiError,
  appendIncludePromptOnly,
  getLocalChatMessages,
  isMissingRouteError,
  roomScopedApiCall,
} from "../../runtime.js";

type MessageRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MessageRecord {
  return Boolean(value && typeof value === "object");
}

export async function findLocalMessageById(roomId: string, messageId: string): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const result = await getLocalChatMessages(roomId, {
      after: afterCursor,
      include_prompt_only: true,
    });
    const messages = (result.messages ?? []).filter(isRecord);
    const match = messages.find((message) => message.id === messageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
    if (!afterCursor) return null;
  }
}

export async function findRemoteMessageById(input: {
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<MessageRecord | null> {
  if (input.roomId) {
    try {
      const result = await roomScopedApiCall<{ message?: unknown }>({
        room_id: input.roomId,
        room_path: (roomId) =>
          appendIncludePromptOnly(
            `/rooms/${encodeRoomIdPath(roomId)}/messages/${encodeURIComponent(input.messageId)}`
          ),
        project_path: () => "",
        // Context lookups must not advance the room session cursor.
        preserve_session_cursor: true,
      });
      return isRecord(result.message) ? result.message : null;
    } catch (error) {
      if (isMissingRouteError(error)) {
        // Older API without the by-id route: fall back to scanning history.
      } else if (error instanceof ApiError && error.status === 404) {
        return null;
      } else {
        throw error;
      }
    }
  }
  return scanRemoteMessageHistoryById(input);
}

async function scanRemoteMessageHistoryById(input: {
  roomId: string | null;
  projectId: string | null;
  messageId: string;
}): Promise<MessageRecord | null> {
  let afterCursor: string | undefined;
  for (;;) {
    const query = new URLSearchParams();
    if (afterCursor) query.set("after", afterCursor);
    const qs = query.toString();
    const result = await roomScopedApiCall<{
      messages?: MessageRecord[];
      has_more?: boolean;
    }>({
      room_id: input.roomId,
      project_id: input.projectId,
      room_path: (roomId) =>
        appendIncludePromptOnly(`/rooms/${encodeRoomIdPath(roomId)}/messages${qs ? `?${qs}` : ""}`),
      project_path: (projectId) =>
        appendIncludePromptOnly(`/projects/${encodeURIComponent(projectId)}/messages${qs ? `?${qs}` : ""}`),
    });
    const messages = (result.messages ?? []).filter(isRecord);
    const match = messages.find((message) => message.id === input.messageId);
    if (match) return match;
    if (!result.has_more || messages.length === 0) return null;
    const lastMessage = messages[messages.length - 1];
    afterCursor = typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
    if (!afterCursor) return null;
  }
}
