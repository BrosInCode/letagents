import type { DaemonManifestEntry } from "./types.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";
import { isLocalRoomApi, LOCAL_ROOM_API_ORIGIN } from "../../../shared/room-api-origin.mjs";
import type { ExecuteDaemonToolInput, ExecuteDaemonToolResult } from "./supervised-tool-runtime.js";

export type LocalSupervisorGrant = {
  entryId: string; roomId: string; agentKey: string; grantId: string; supervisorGrant: string;
  grantGeneration: number; apiUrl: string; hostId: string; installationId: string;
  ownerAccountId: null; scopeKey: null; expiresAt: string;
};

type LocalRoomRuntime = {
  executeLocalBoardMutation(input: unknown): Promise<unknown>;
  watchLocalBoard(input: unknown, generation: number, signal: AbortSignal): Promise<unknown>;
  requestLocalSupervisor(url: string, init?: RequestInit): Promise<Response>;
  prepareLocalSupervisorGrant(input: { entryId: string; roomId: string; displayName: string; provider: string }): Promise<LocalSupervisorGrant>;
  executeLocalSupervisorTool(input: ExecuteDaemonToolInput): Promise<ExecuteDaemonToolResult>;
};
let runtime: Promise<LocalRoomRuntime> | undefined;

/** Exact sibling in the signed desktop build, with no Electron process dependency. */
export function localRoomRuntime(): Promise<LocalRoomRuntime> {
  runtime ??= import(new URL(import.meta.url.endsWith(".ts")
    ? "../electron/main/rooms/local-supervision-runtime.ts" // repository tests and development only
    : "../dist-electron/main/rooms/local-supervision-runtime.js", import.meta.url).href)
    .then((module) => {
      if (typeof module.requestLocalSupervisor !== "function"
        || typeof module.prepareLocalSupervisorGrant !== "function"
        || typeof module.executeLocalBoardMutation !== "function"
        || typeof module.watchLocalBoard !== "function"
        || typeof module.executeLocalSupervisorTool !== "function") throw new Error("Local room supervision is unavailable in this build.");
      return module as LocalRoomRuntime;
    }).catch((error) => { runtime = undefined; throw error; });
  return runtime;
}

/** Every cloud URL and request remains unchanged; the local scheme can never reach fetch. */
export async function roomRequest(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.protocol === "letagents-local:") {
    if (parsed.host !== "rooms" || parsed.username || parsed.password || parsed.hash) throw new Error("Invalid local room authority.");
    return (await localRoomRuntime()).requestLocalSupervisor(url, init);
  }
  return fetch(url, init);
}

export { isLocalRoomApi, LOCAL_ROOM_API_ORIGIN };

/** Restore local scope before convergence, independently of a desktop/cloud login. */
export async function restoreLocalRoomAuthority(entry: DaemonManifestEntry, daemonGeneration: number,
  custody: Pick<WorkerRuntimeCustody, "installHostGrant">): Promise<void> {
  if (!entry.local_room_id || entry.desired_state === "stopped") return;
  try {
    if (entry.local_room_id !== entry.room_id) throw new Error("Local room membership is inconsistent.");
    const grant = await (await localRoomRuntime()).prepareLocalSupervisorGrant({
      entryId: entry.id, roomId: entry.local_room_id, displayName: entry.display_name, provider: entry.provider,
    });
    custody.installHostGrant({ ...grant, daemonGeneration });
  } catch (error) {
    console.warn(`Local supervisor authority unavailable for ${entry.id}: ${String(error)}`);
  }
}

export async function restoreLocalRoomAuthorities(entries: DaemonManifestEntry[], daemonGeneration: number,
  custody: Pick<WorkerRuntimeCustody, "installHostGrant">): Promise<void> {
  for (const entry of entries) await restoreLocalRoomAuthority(entry, daemonGeneration, custody);
}
