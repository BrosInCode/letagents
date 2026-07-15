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

/**
 * The first Start response is intentionally durable before the provider has
 * registered an MCP participant. Give that state a distinct UI label instead
 * of making it look like a failed recovery only visible after a second click.
 */
export function supervisedRuntimeCardLabel(
  entry: Pick<DesktopSupervisorManifestEntry, "observedState" | "condition">,
): string {
  if (entry.condition !== "none" || entry.observedState === "failed") {
    return "Supervised runtime needs recovery";
  }
  if (entry.observedState === "working") return "Supervised runtime is working";
  if (entry.observedState === "idle") return "Supervised runtime is ready";
  return "Supervised runtime is starting";
}
