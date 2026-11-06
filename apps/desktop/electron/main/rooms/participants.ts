import { apiFetch } from "../auth.js";
import { cloudRoomIdentifierForStorage, resolveLocalAwareRoomStorageMode } from "./local-store.js";

/** Archive room roster entries only; this never invokes runtime or workspace removal. */
export async function archiveDesktopRoomAgents(identifier: string, participantKeys: string[]): Promise<{
  archivedParticipantKeys: string[]; skippedParticipantKeys: string[];
}> {
  if (typeof identifier !== "string" || !identifier.trim() || !Array.isArray(participantKeys)
    || !participantKeys.length || participantKeys.length > 500
    || participantKeys.some(key => typeof key !== "string" || !key.trim() || key.length > 1000)) {
    throw new Error("Choose a room and between 1 and 500 agents to archive.");
  }
  const storage = await resolveLocalAwareRoomStorageMode(identifier);
  if (storage.effectiveMode === "local") throw new Error("Agent archiving requires a cloud room.");
  const room = cloudRoomIdentifierForStorage(storage, identifier);
  const result = await apiFetch<{ archived_participant_keys: string[]; skipped_participant_keys: string[] }>(
    `/rooms/${encodeURIComponent(room)}/participants/archive-selected`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ participant_keys: [...new Set(participantKeys)] }),
    });
  if (!Array.isArray(result.archived_participant_keys) || !Array.isArray(result.skipped_participant_keys)
    || [...result.archived_participant_keys, ...result.skipped_participant_keys].some(key => !participantKeys.includes(key))) {
    throw new Error("The server could not confirm which agents were archived. Refresh the agent list.");
  }
  return { archivedParticipantKeys: result.archived_participant_keys, skippedParticipantKeys: result.skipped_participant_keys };
}
