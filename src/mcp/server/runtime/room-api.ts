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
import { currentRoom, getCurrentSupervisedRoomAuthority } from "./room-state.js";
import { hasSupervisedWorkerAuthority } from "./worker-bearer.js";

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
  const supervised = hasSupervisedWorkerAuthority();
  const exactRoomAuthority = supervised ? getCurrentSupervisedRoomAuthority() : null;
  if (supervised && (!exactRoomAuthority || input.room_id !== exactRoomAuthority)) {
    throw new Error("The daemon-supervised API request is missing its exact per-call room authority.");
  }
  const headers = {
    ...(input.options?.headers as Record<string, string> | undefined),
  };
  const originHeaderKey = Object.keys(headers).find((key) =>
    key.toLowerCase() === LETAGENTS_ORIGIN_ROOM_ID_HEADER.toLowerCase()
  );
  if (exactRoomAuthority) {
    if (originHeaderKey) delete headers[originHeaderKey];
    headers[LETAGENTS_ORIGIN_ROOM_ID_HEADER] = exactRoomAuthority;
  } else if (currentRoom?.room_id && !originHeaderKey) {
    headers[LETAGENTS_ORIGIN_ROOM_ID_HEADER] = currentRoom.room_id;
  }
  const options = {
    ...input.options,
    headers,
  };

  if (input.room_id) {
    const cloudRoomId = supervised
      ? null
      : (await resolveLocalRoomStorageIdentifiers(input.room_id)).cloudRoomId;
    const apiRoomId = cloudRoomId || input.room_id;
    try {
      const result = await apiCall<T>(input.room_path(apiRoomId), options);
      if (!supervised) {
        touchRoomSession(input.room_id, input.preserve_session_cursor ? undefined : getLastMessageId(result));
      }
      return result;
    } catch (error) {
      await maybeHandleRepoRoomAuthRequired(error, apiRoomId);
      if (supervised || !input.project_id || !isMissingRouteError(error)) {
        throw error;
      }
    }
  }

  if (!input.project_id) {
    throw new Error("No room is available for this request.");
  }

  const result = await apiCall<T>(input.project_path(input.project_id), options);
  if (input.room_id) {
    if (!supervised) {
      touchRoomSession(input.room_id, input.preserve_session_cursor ? undefined : getLastMessageId(result));
    }
  }
  return result;
}
