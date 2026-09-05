import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getLocalStatePath, readLocalStateSnapshot, updateLocalState,
} from "../../local-state/storage.js";
import type { StoredMcpWorker, StoredAgentSessionState } from "../../local-state/types.js";
import { isLocalRoomStorageEnabled, resolveLocalRoomStorageIdentifiers } from "../../local-state.js";
import { assertWorkerConnection, pinWorkerConnection, pinnedWorkerConnection, withWorkerCall } from "../../worker-call-context.js";
import { isMcpWorkerId } from "../../../shared/mcp-worker.js";
import { pickLocalCodename } from "../../../shared/codenames.js";
import { buildAgentActorLabel } from "../../../shared/agent-identity.js";
import { encodeRoomIdPath } from "../../room-id.js";
import { getGitCurrentBranch } from "../../git-remote.js";
import { apiCall, getApiUrl, getLetagentsToken } from "./api.js";
import { resolveOwnerContext } from "./identity/directory.js";
import { detectAgentIdeLabel, detectAgentRuntimeLabel } from "./identity/config.js";
import { getSessionLivenessRegistration } from "./identity/liveness.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";

type WorkerConnection = { worker: StoredMcpWorker; session: StoredAgentSessionState };
const connecting = new Map<string, Promise<WorkerConnection>>();

function snapshot() {
  const result = readLocalStateSnapshot();
  if (!result.complete) throw new Error("Worker state is unavailable; restore it before reconnecting.");
  return result.state;
}

async function workerScope(): Promise<string> {
  if (requireValidWorkerBearerRuntime().mode !== "owner") {
    throw new Error("Worker handles are for independent MCP chats; supervised identity is supplied by its supervisor.");
  }
  const hasAccountToken = Boolean(await getLetagentsToken());
  const owner = await resolveOwnerContext();
  if (hasAccountToken && !owner.login) {
    throw new Error("Could not verify your LetAgents account. Check your connection or sign-in, then retry with the same worker_id or registration_key. Saved worker identities have not been changed.");
  }
  return `${getApiUrl()}\n${owner.login?.toLowerCase() ?? `local:${owner.slug}`}`;
}

function getWorker(workerId: string, scope: string): StoredMcpWorker {
  const worker = snapshot().mcp_workers?.[workerId];
  if (!isMcpWorkerId(workerId) || !worker || worker.scope !== scope) {
    throw new Error("Unknown worker_id for this account and API. Create a worker for this chat or explicitly resume its saved handle.");
  }
  return worker;
}

export async function registerMcpWorker(input: {
  roomId: string;
  workerId?: string;
  registrationKey?: string;
  displayName?: string;
  runtime?: string;
  cwd?: string;
}): Promise<WorkerConnection> {
  const scope = await workerScope();
  if (input.workerId && input.registrationKey) throw new Error("Use worker_id to resume or registration_key to create, not both.");
  let workerId = input.workerId;
  if (!workerId) {
    if (!input.registrationKey?.trim()) throw new Error("A new chat must supply its own registration_key and retain the returned worker_id.");
    const keyHash = createHash("sha256").update(`${scope}\n${input.registrationKey}`).digest("hex");
    snapshot();
    updateLocalState((state) => {
      state.mcp_workers ??= {};
      const prior = Object.values(state.mcp_workers).find((w) => w.scope === scope && w.registration_key_hash === keyHash);
      workerId = prior?.worker_id ?? `worker_${randomUUID().replaceAll("-", "")}`;
      state.mcp_workers[workerId] ??= {
        worker_id: workerId, scope, registration_key_hash: keyHash,
        display_name: input.displayName?.trim() || pickLocalCodename(workerId).display_name,
        rooms: {},
      };
    });
  }
  const worker = getWorker(workerId!, scope);
  const identifiers = await resolveLocalRoomStorageIdentifiers(input.roomId);
  const roomId = identifiers.cloudRoomId || input.roomId;
  const local = await isLocalRoomStorageEnabled(input.roomId);
  const key = `${getLocalStatePath()}\n${worker.worker_id}\n${roomId}`;
  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;
  const result = connectWorker(input, worker, scope, roomId, local);
  connecting.set(key, result);
  try {
    return await result;
  } finally {
    connecting.delete(key);
  }
}

async function connectWorker(input: { runtime?: string; cwd?: string }, worker: StoredMcpWorker,
  scope: string, roomId: string, local: boolean): Promise<WorkerConnection> {
  const currentId = worker.rooms[roomId]?.session_id;
  const current = currentId ? snapshot().agent_sessions?.[currentId] : undefined;
  const pinned = currentId ? pinnedWorkerConnection(getLocalStatePath(), currentId) : null;
  if (pinned && current && !current.ended_at && pinned.session_token === current.session_token
    && !worker.rooms[roomId]?.pending) return { worker, session: pinned };

  const owner = await resolveOwnerContext();
  if (!local && !owner.login) throw new Error("Sign in before registering a worker in a hosted room.");
  const ide = detectAgentIdeLabel();
  // An opaque per-chat key prevents two chats choosing the same visible name
  // from collapsing into the same routing identity.
  const agentName = worker.worker_id.replace("_", "-");
  const agent = local ? { canonical_key: `${owner.login ?? owner.slug}/${agentName}` }
    : await apiCall<{ canonical_key: string }>("/agents", {
      method: "POST", body: JSON.stringify({ name: agentName, display_name: worker.display_name, owner_label: owner.label }),
    });
  if (!agent.canonical_key) throw new Error("Worker identity registration returned no canonical identity.");

  async function finish(operation: NonNullable<StoredMcpWorker["rooms"][string]["pending"]>) {
    let session: StoredAgentSessionState;
    if (local) {
      const prior = operation.predecessor_id ? snapshot().agent_sessions?.[operation.predecessor_id] : undefined;
      if (prior && prior.session_token !== operation.predecessor_token
        && prior.session_token !== operation.connection_token) throw new Error("Worker registration was superseded.");
      const now = new Date().toISOString();
      session = {
        session_id: prior?.session_id ?? `local_${createHash("sha256").update(`${worker.worker_id}\n${roomId}`).digest("hex")}`, session_token: operation.connection_token,
        room_id: roomId, session_kind: "worker", agent_instance_id: worker.worker_id,
        agent_key: agent.canonical_key, display_name: prior?.display_name ?? worker.display_name,
        actor_label: prior?.actor_label ?? buildAgentActorLabel({ display_name: worker.display_name, owner_label: owner.label, ide_label: ide }),
        owner_label: owner.label, ide_label: ide, runtime: input.runtime || detectAgentRuntimeLabel(),
        requested_base_display_name: worker.display_name,
        created_at: prior?.created_at ?? now, updated_at: now, last_seen_at: now, ended_at: null,
      };
    } else {
      const created = await apiCall<StoredAgentSessionState & { assigned_base_display_name?: string; worker_bearer?: unknown }>(
        `/rooms/${encodeRoomIdPath(roomId)}/agent-sessions`, {
          method: "POST", body: JSON.stringify({
            actor_key: agent.canonical_key, agent_instance_id: worker.worker_id,
            display_name: worker.display_name, requested_base_display_name: worker.display_name,
            session_kind: "worker", runtime: input.runtime || detectAgentRuntimeLabel(), ide_label: ide,
            repo_branch: getGitCurrentBranch(input.cwd),
            registration_liveness: getSessionLivenessRegistration(input.runtime || detectAgentRuntimeLabel()),
            connection_token: operation.connection_token,
            replace_agent_session_id: operation.predecessor_id ?? null,
            replace_agent_session_token: operation.predecessor_token ?? null,
          }),
        },
      );
      if (!created.session_id || created.session_token !== operation.connection_token
        || created.agent_instance_id !== worker.worker_id || created.agent_key !== agent.canonical_key
        || created.room_id !== roomId || created.ended_at) {
        throw new Error("The server did not confirm this worker connection. Upgrade the API before using durable worker handles.");
      }
      // Keep only the session credential; the server's optional bearer is not used here.
      const { assigned_base_display_name, worker_bearer: _unusedBearer, ...record } = created;
      session = { ...record, requested_base_display_name: assigned_base_display_name ?? worker.display_name };
    }
    updateLocalState((state) => {
      const target = state.mcp_workers?.[worker.worker_id]?.rooms[roomId];
      if (target?.pending?.operation_id !== operation.operation_id) throw new Error("Worker registration was superseded; retry explicitly.");
      state.agent_sessions ??= {};
      if (local && !target.session_id) {
        const used = new Set(Object.values(state.agent_sessions)
          .filter((other) => other.room_id === roomId && other.session_id !== session.session_id)
          .map((other) => other.display_name));
        let suffix = 1;
        while (used.has(session.display_name)) session.display_name = `${worker.display_name} ${suffix++}`;
        session.actor_label = buildAgentActorLabel({ display_name: session.display_name, owner_label: owner.label, ide_label: ide });
      }
      state.agent_sessions[session.session_id] = session;
      target.session_id = session.session_id;
      delete target.pending;
    });
    return session;
  }

  // Recover a response lost by an earlier process using its prepared credential.
  // Then rotate once more for this process; never silently share that connection.
  const pending = getWorker(worker.worker_id, scope).rooms[roomId]?.pending;
  if (pending) await finish(pending);
  const operation = { operation_id: randomUUID(), connection_token: randomBytes(32).toString("base64url") } as NonNullable<StoredMcpWorker["rooms"][string]["pending"]>;
  updateLocalState((state) => {
    const target = state.mcp_workers![worker.worker_id]!.rooms;
    target[roomId] ??= {};
    if (target[roomId].pending) throw new Error("Another registration is in progress for this worker; retry explicitly.");
    const priorId = target[roomId].session_id;
    const prior = priorId ? state.agent_sessions?.[priorId] : undefined;
    operation.predecessor_id = prior?.session_id;
    operation.predecessor_token = prior?.session_token;
    target[roomId].pending = operation;
  });
  const session = await finish(operation);
  pinWorkerConnection(getLocalStatePath(), session);
  return { worker: getWorker(worker.worker_id, scope), session };
}

export async function runMcpWorkerCall<T>(workerId: string, roomId: string | undefined,
  callback: (session: StoredAgentSessionState) => T, allowEnded = false): Promise<Awaited<T>> {
  const worker = getWorker(workerId, await workerScope());
  const rooms = Object.keys(worker.rooms);
  const targetRoom = roomId || (rooms.length === 1 ? rooms[0] : null);
  const entry = targetRoom ? worker.rooms[targetRoom] : null;
  const session = entry?.session_id ? pinnedWorkerConnection(getLocalStatePath(), entry.session_id) : null;
  const stored = entry?.session_id ? snapshot().agent_sessions?.[entry.session_id] : null;
  if (!session || !stored || entry?.pending || stored.ended_at || session.session_token !== stored.session_token) {
    throw new Error("This worker has no current connection in this process. Reconnect explicitly with register_agent_session(worker_id, room_id).");
  }
  return await withWorkerCall(session, async () => {
    const result = await callback(session);
    assertWorkerConnection(session, allowEnded);
    return result;
  });
}
