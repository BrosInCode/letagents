import type {
  DesktopSupervisorDesiredState,
  DesktopSupervisorManifestEntry,
} from "../../../electron/ipc-types";
import { supervisedProviderLaneEntry } from "./managed-agents";

export interface SupervisedRecoveryClient {
  listAgents(roomIdentifier?: string | null): Promise<DesktopSupervisorManifestEntry[]>;
  setDesiredState(
    id: string,
    desiredState: DesktopSupervisorDesiredState,
  ): Promise<DesktopSupervisorManifestEntry>;
}

export interface SupervisedRecoveryLookup {
  entry: DesktopSupervisorManifestEntry | null;
  error: string | null;
}

/**
 * Resolve only the durable supervisor lane that blocked this provider's Start
 * request. This deliberately never consults room presence, because an orphan
 * can fail before registering an MCP participant.
 */
export async function loadSupervisedProviderLane(
  client: SupervisedRecoveryClient,
  roomIdentifier: string,
  providerId: string,
): Promise<SupervisedRecoveryLookup> {
  try {
    const entries = await client.listAgents(roomIdentifier);
    return {
      entry: supervisedProviderLaneEntry(entries, roomIdentifier, providerId),
      error: null,
    };
  } catch {
    return {
      entry: null,
      error: "Could not load the supervisor recovery entry. Check the daemon connection, then try Start again.",
    };
  }
}

/** Stop exactly the entry selected by the durable room/provider lane lookup. */
export function stopSupervisedProviderLane(
  client: SupervisedRecoveryClient,
  entryId: string,
): Promise<DesktopSupervisorManifestEntry> {
  return client.setDesiredState(entryId, "stopped");
}

export function supervisedRecoveryDetail(
  entry: Pick<DesktopSupervisorManifestEntry, "lastError" | "activity">,
): string | null {
  const lastError = entry.lastError?.trim();
  if (lastError) return lastError;
  const latestActivity = [...entry.activity]
    .sort((left, right) => right.sequence - left.sequence)[0];
  return latestActivity?.summary?.trim() || null;
}
