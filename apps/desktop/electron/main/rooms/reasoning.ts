import type { DesktopReasoningSessionDetail } from "../../ipc-types.js";
import { apiFetch } from "../auth.js";
import {
  mapDesktopReasoningSessionPayload,
  mapDesktopReasoningUpdatePayload,
  type DesktopReasoningSessionPayload,
  type DesktopReasoningUpdatePayload,
} from "./reasoning/mappers.js";

export {
  mapDesktopReasoningSessionPayload,
  mapDesktopReasoningUpdatePayload,
  type DesktopReasoningSessionPayload,
  type DesktopReasoningUpdatePayload,
};

export async function getDesktopReasoningSession(
  roomIdentifier: string,
  sessionId: string,
): Promise<DesktopReasoningSessionDetail> {
  const trimmedRoomIdentifier = roomIdentifier.trim();
  const trimmedSessionId = sessionId.trim();
  if (!trimmedRoomIdentifier || !trimmedSessionId) {
    throw new Error("Choose a reasoning stream before opening details.");
  }

  const detail = await apiFetch<{
    session?: DesktopReasoningSessionPayload;
    reasoning_session?: DesktopReasoningSessionPayload;
    updates?: DesktopReasoningUpdatePayload[];
  }>(
    `/rooms/${encodeURIComponent(trimmedRoomIdentifier)}/reasoning-sessions/${encodeURIComponent(trimmedSessionId)}`,
  );
  const sessionPayload = detail.session || detail.reasoning_session;
  if (!sessionPayload) {
    throw new Error("Reasoning session details were not returned.");
  }

  return {
    session: mapDesktopReasoningSessionPayload(sessionPayload),
    updates: (detail.updates || []).map(mapDesktopReasoningUpdatePayload),
  };
}
