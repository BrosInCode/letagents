import {
  resolveLocalRoomStorageIdentifiers,
  touchRoomSession,
} from "../../local-state.js";
import { LETAGENTS_ORIGIN_ROOM_ID_HEADER } from "../../../shared/request-headers.js";
import {
  apiCall,
  isMissingRouteError,
} from "./api.js";
import { maybeHandleRepoRoomAuthRequired } from "./device-auth.js";
import { getLastMessageId } from "./messages.js";
import { currentRoom } from "./room-state.js";

export async function roomScopedApiCall<T>(input: {
  room_id?: string | null;
  project_id?: string | null;
  room_path: (roomId: string) => string;
  project_path: (projectId: string) => string;
  options?: RequestInit;
  // Backward-history fetches return pages whose last message is OLDER than the
  // session cursor; setting this keeps the liveness touch but leaves
  // last_message_id alone so the cursor never moves backwards.
  preserve_session_cursor?: boolean;
}): Promise<T> {
  const headers = {
    ...(input.options?.headers as Record<string, string> | undefined),
  };
  if (
    currentRoom?.room_id &&
    !Object.keys(headers).some((key) =>
      key.toLowerCase() === LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()
    )
  ) {
    headers[LETAGENTS_ORIGIN_ROOM_ID_HEADER] = currentRoom.room_id;
  }
  const options = {
    ...input.options,
    headers,
  };

  if (input.room_id) {
    const { cloudRoomId } = await resolveLocalRoomStorageIdentifiers(input.room_id);
    const apiRoomId = cloudRoomId || input.room_id;
    try {
      const result = await apiCall<T>(input.room_path(apiRoomId), options);
      touchRoomSession(input.room_id, input.preserve_session_cursor ? undefined : getLastMessageId(result));
      return result;
    } catch (error) {
      await maybeHandleRepoRoomAuthRequired(error, apiRoomId);
      if (!input.project_id || !isMissingRouteError(error)) {
        throw error;
      }
    }
  }

  if (!input.project_id) {
    throw new Error("No room is available for this request.");
  }

  const result = await apiCall<T>(input.project_path(input.project_id), options);
  if (input.room_id) {
    touchRoomSession(input.room_id, input.preserve_session_cursor ? undefined : getLastMessageId(result));
  }
  return result;
}
