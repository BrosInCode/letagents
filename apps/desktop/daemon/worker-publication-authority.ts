import { hostGrantApiOrigin } from "./cloud-http.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";

export type WorkerPublicationOrigin = {
  agentId: string;
  roomId: string;
  apiOrigin: string;
  agentKey: string;
  agentInstanceId: string;
  hostId: string;
  installationId: string;
  sourceSessionId: string;
};

type Custody = Pick<WorkerRuntimeCustody, "hostGrant" | "workerAuthorization">;

/** Pure process-custody lookup. It never renews, mints, or mutates credentials. */
export function currentWorkerPublicationAuthority(
  custody: Custody,
  agentId: string,
  daemonGeneration: number,
  nowMs: number,
) {
  const grant = custody.hostGrant(agentId);
  const worker = custody.workerAuthorization(agentId);
  const session = worker?.agentSession;
  if (!grant || !worker || !session || grant.entryId !== agentId || worker.entryId !== agentId
    || grant.daemonGeneration !== daemonGeneration || worker.daemonGeneration !== grant.daemonGeneration
    || !(Date.parse(grant.expiresAt) > nowMs) || worker.grantId !== grant.grantId
    || worker.grantGeneration !== grant.grantGeneration || worker.roomId !== grant.roomId
    || worker.agentKey !== grant.agentKey || worker.apiUrl !== grant.apiUrl
    || session.room_id !== grant.roomId || session.agent_key !== grant.agentKey
    || session.session_id !== worker.agentSessionId || session.agent_instance_id !== `daemon:${agentId}`
    || session.session_kind !== "worker" || session.ended_at !== null) return null;
  try {
    const apiOrigin = hostGrantApiOrigin(grant.apiUrl);
    if (apiOrigin !== grant.apiUrl) return null;
    const origin: WorkerPublicationOrigin = {
      agentId,
      roomId: grant.roomId,
      apiOrigin,
      agentKey: grant.agentKey,
      agentInstanceId: session.agent_instance_id,
      hostId: grant.hostId,
      installationId: grant.installationId,
      sourceSessionId: session.session_id,
    };
    return { grant, worker, origin };
  } catch {
    return null;
  }
}

export function sameWorkerPublicationOrigin(
  left: WorkerPublicationOrigin,
  right: WorkerPublicationOrigin,
  requireOriginalSession = false,
): boolean {
  return left.agentId === right.agentId && left.roomId === right.roomId && left.apiOrigin === right.apiOrigin
    && left.agentKey === right.agentKey && left.agentInstanceId === right.agentInstanceId
    && left.hostId === right.hostId && left.installationId === right.installationId
    && (!requireOriginalSession || left.sourceSessionId === right.sourceSessionId);
}
