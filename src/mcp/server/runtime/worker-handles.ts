import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getLocalStatePath, readLocalStateSnapshot, updateLocalState,
} from "../../local-state/storage.js";
import type { StoredMcpWorker, StoredAgentSessionState } from "../../local-state/types.js";
import { isLocalRoomStorageEnabled, resolveLocalRoomStorageIdentifiers } from "../../local-state.js";
import { assertWorkerConnection, heldWorkerConnection, pinWorkerConnection, pinnedWorkerConnection, withWorkerCall } from "../../worker-call-context.js";
import { isMcpWorkerId, WORKER_USE_RECORD_INTERVAL_MS } from "../../../shared/mcp-worker.js";
import { AGENT_CODENAME_SPACE, pickLocalCodename } from "../../../shared/codenames.js";
import { buildAgentActorLabel } from "../../../shared/agent-identity.js";
import { normalizeRoutingHandle, normalizeRoutingSender } from "../../../../shared/routing-aliases.mjs";
import { encodeRoomIdPath } from "../../room-id.js";
import { getGitCurrentBranch } from "../../git-remote.js";
import { ApiError, apiCall, apiCallWhenFree, getApiUrl, hasLetagentsCredential } from "./api.js";
import { resolveOwnerContext } from "./identity/directory.js";
import { detectAgentIdeLabel, detectAgentRuntimeLabel } from "./identity/config.js";
import { getProcessHostId, getSessionLivenessRegistration } from "./identity/liveness.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";
import { holdProcessConnection } from "./process-connection.js";
import { getCurrentRoom } from "./room-state.js";
import { currentSessionScope, scopedMap } from "./session-scope.js";

export type AdoptedTaskLease = { lease_id: string; task_id: string; kind: string };
type WorkerConnection = {
  worker: StoredMcpWorker;
  session: StoredAgentSessionState;
  /** The name that was asked for, when a worker this process holds has it. */
  name_held_here?: string | null;
  /** Leases an earlier session of this agent held, which this one now holds. */
  adopted_task_leases?: AdoptedTaskLease[];
};
// What the room said of the registration just made, kept for its caller.
const adoptedBySession = scopedMap<string, AdoptedTaskLease[]>("adopted-task-leases");
const connecting = scopedMap<string, Promise<WorkerConnection>>("connecting-workers");

function snapshot() {
  const result = readLocalStateSnapshot();
  if (!result.complete) throw new Error("Worker state is unavailable; restore it before reconnecting.");
  return result.state;
}

async function workerScope(): Promise<string> {
  if (requireValidWorkerBearerRuntime().mode !== "owner") {
    throw new Error("Worker handles are for independent MCP chats; supervised identity is supplied by its supervisor.");
  }
  const hasAccountToken = await hasLetagentsCredential();
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

export function readAdoptedTaskLeases(value: unknown): AdoptedTaskLease[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const lease = entry as { lease_id?: unknown; task_id?: unknown; kind?: unknown } | null;
    return lease && typeof lease.lease_id === "string" && typeof lease.task_id === "string"
      && typeof lease.kind === "string"
      ? [{ lease_id: lease.lease_id, task_id: lease.task_id, kind: lease.kind }] : [];
  });
}

/**
 * The workers this process holds in a room under a name.
 *
 * A chat that has lost its worker_id registers as if it were new, and asks
 * for the name it knows itself by. This process still holds the worker it
 * registered as, so the room sees that name held by an agent that is there,
 * and gives the chat another. It is then a second agent, under a name it
 * does not know, with none of its tasks.
 *
 * A worker_id is what lets a chat act as a worker, so it is not given to
 * every chat that asks for a worker's name: two chats served by one process
 * may ask for the same name, and each is its own worker. A chat is told only
 * that the name is held here, and how to say that it is the one holding it.
 */
function workersThisProcessHoldsUnder(
  displayName: string | undefined,
  scope: string,
  roomId: string,
): Array<{ worker_id: string; display_name: string }> {
  const asked = displayName?.trim();
  if (!asked) return [];
  const nameKey = (name: string) => normalizeRoutingHandle(name) || normalizeRoutingSender(name);
  const state = snapshot();
  return Object.values(state.mcp_workers ?? {}).flatMap((worker) => {
    if (worker.scope !== scope) return [];
    const sessionId = worker.rooms[roomId]?.session_id;
    const session = sessionId ? state.agent_sessions?.[sessionId] : undefined;
    if (!sessionId || !session || session.ended_at) return [];
    const held = heldWorkerConnection(getLocalStatePath(), sessionId);
    if (!held || held.session_token !== session.session_token) return [];
    // The name it lives under, which is the name it knows itself by. A
    // worker that asked for this name and was given another is not it.
    if (nameKey(session.display_name) !== nameKey(asked)) return [];
    return [{ worker_id: worker.worker_id, display_name: session.display_name }];
  });
}

/**
 * A chat says that it registered under this name and has lost its handle. If
 * this process holds one worker under the name in the room, that is the
 * worker, and the chat has it back.
 */
export async function recoverMcpWorker(input: {
  roomId: string;
  displayName: string;
  runtime?: string;
  cwd?: string;
}): Promise<WorkerConnection> {
  const scope = await workerScope();
  const identifiers = await resolveLocalRoomStorageIdentifiers(input.roomId);
  const held = workersThisProcessHoldsUnder(input.displayName, scope, identifiers.cloudRoomId || input.roomId);
  if (held.length === 0) {
    throw new Error(
      `This MCP server holds no worker named "${input.displayName.trim()}" in this room, so there is nothing to recover. `
      + "Register as a new worker with a registration_key.",
    );
  }
  if (held.length > 1) {
    throw new Error(
      `This MCP server holds more than one worker named "${input.displayName.trim()}" in this room and cannot tell `
      + "which one this chat is. Register as a new worker with a registration_key.",
    );
  }
  return registerMcpWorker({ roomId: input.roomId, workerId: held[0]!.worker_id, runtime: input.runtime, cwd: input.cwd });
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
  let nameHeldHere: string | null = null;
  const identifiers = await resolveLocalRoomStorageIdentifiers(input.roomId);
  const roomId = identifiers.cloudRoomId || input.roomId;
  if (!workerId) {
    if (!input.registrationKey?.trim()) throw new Error("A new chat must supply its own registration_key and retain the returned worker_id.");
    const keyHash = createHash("sha256").update(`${scope}\n${input.registrationKey}`).digest("hex");
    const known = Object.values(snapshot().mcp_workers ?? {})
      .some((worker) => worker.scope === scope && worker.registration_key_hash === keyHash);
    if (!known) nameHeldHere = workersThisProcessHoldsUnder(input.displayName, scope, roomId)[0]?.display_name ?? null;
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
  const local = await isLocalRoomStorageEnabled(input.roomId);
  const key = `${getLocalStatePath()}\n${worker.worker_id}\n${roomId}`;
  const inFlight = connecting().get(key);
  if (inFlight) return inFlight;
  const result = connectWorker(input, worker, scope, roomId, local);
  connecting().set(key, result);
  try {
    const connection = await result;
    const adopted = adoptedBySession().get(connection.session.session_id);
    adoptedBySession().delete(connection.session.session_id);
    return {
      ...connection,
      ...(nameHeldHere ? { name_held_here: nameHeldHere } : {}),
      ...(adopted?.length ? { adopted_task_leases: adopted } : {}),
    };
  } finally {
    connecting().delete(key);
  }
}

async function connectWorker(input: { runtime?: string; cwd?: string }, worker: StoredMcpWorker,
  scope: string, roomId: string, local: boolean): Promise<WorkerConnection> {
  const currentId = worker.rooms[roomId]?.session_id;
  const current = currentId ? snapshot().agent_sessions?.[currentId] : undefined;
  const pinned = currentId ? pinnedWorkerConnection(getLocalStatePath(), currentId) : null;
  if (pinned && current && !current.ended_at && pinned.session_token === current.session_token
    && !worker.rooms[roomId]?.pending) {
    if (!local) holdProcessConnection(pinned);
    return { worker, session: pinned };
  }

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
      const created = await apiCallWhenFree<StoredAgentSessionState & {
        assigned_base_display_name?: string; worker_bearer?: unknown; adopted_task_leases?: unknown;
      }>(
        `/rooms/${encodeRoomIdPath(roomId)}/agent-sessions`, {
          method: "POST", body: JSON.stringify({
            actor_key: agent.canonical_key, agent_instance_id: worker.worker_id,
            display_name: worker.display_name, requested_base_display_name: worker.display_name,
            session_kind: "worker", runtime: input.runtime || detectAgentRuntimeLabel(), ide_label: ide,
            repo_branch: getGitCurrentBranch(input.cwd),
            registration_liveness: getSessionLivenessRegistration(input.runtime || detectAgentRuntimeLabel()),
            process_host_id: getProcessHostId(),
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
      const { assigned_base_display_name, worker_bearer: _unusedBearer, adopted_task_leases, ...record } = created;
      session = { ...record, requested_base_display_name: assigned_base_display_name ?? worker.display_name };
      const adopted = readAdoptedTaskLeases(adopted_task_leases);
      if (adopted.length > 0) adoptedBySession().set(session.session_id, adopted);
    }
    updateLocalState((state) => {
      const target = state.mcp_workers?.[worker.worker_id]?.rooms[roomId];
      if (target?.pending?.operation_id !== operation.operation_id) throw new Error("Worker registration was superseded; retry explicitly.");
      state.agent_sessions ??= {};
      if (local && !target.session_id) {
        // Mirror the hosted allocator: names are compared the way mentions
        // are, and a held name receives its own codename, never a numbered
        // variant that cannot be mentioned as typed.
        const nameKey = (name: string) => normalizeRoutingHandle(name) || normalizeRoutingSender(name);
        const used = new Set(Object.values(state.agent_sessions)
          .filter((other) => other.room_id === roomId && other.session_id !== session.session_id)
          .map((other) => nameKey(other.display_name)));
        for (let offset = 1; used.has(nameKey(session.display_name)) && offset <= AGENT_CODENAME_SPACE; offset += 1) {
          session.display_name = pickLocalCodename(`${agent.canonical_key}:${offset}`).display_name;
        }
        session.actor_label = buildAgentActorLabel({ display_name: session.display_name, owner_label: owner.label, ide_label: ide });
      }
      state.agent_sessions[session.session_id] = session;
      target.session_id = session.session_id;
      delete target.pending;
    });
    return session;
  }

  /**
   * A prepared operation stays saved while its answer may have been lost
   * (a network error, a server error), so a later process can recover it.
   * An answer that refuses it for good (4xx: another registration won, the
   * proof is stale) ends it, or the refusal would repeat for every later
   * session that inherits the saved operation.
   */
  async function finishOrClear(operation: NonNullable<StoredMcpWorker["rooms"][string]["pending"]>) {
    try {
      return await finish(operation);
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        updateLocalState((state) => {
          const rooms = state.mcp_workers?.[worker.worker_id]?.rooms;
          const target = rooms?.[roomId];
          if (target?.pending?.operation_id === operation.operation_id) delete target.pending;
          // A room the registration never reached (unknown, or not this account's) binds nothing:
          // an empty entry would count as one of the worker's rooms.
          if (rooms && target && !target.session_id && !target.pending) delete rooms[roomId];
        });
      }
      throw error;
    }
  }

  // Recover a response lost by an earlier process using its prepared credential.
  // Then rotate once more for this process; never silently share that connection.
  // A replay the room refuses (409) may still have been committed before its
  // answer was lost: the room then holds the prepared token, so a fresh
  // registration that the saved token does not open is tried once with it.
  let lostProof: string | undefined;
  const pending = getWorker(worker.worker_id, scope).rooms[roomId]?.pending;
  if (pending) {
    try {
      await finishOrClear(pending);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
      lostProof = pending.connection_token;
    }
  }
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
  let session: StoredAgentSessionState;
  try {
    session = await finishOrClear(operation);
  } catch (error) {
    if (!(lostProof && error instanceof ApiError && error.status === 409 && lostProof !== operation.predecessor_token)) throw error;
    operation.predecessor_token = lostProof;
    updateLocalState((state) => {
      const target = state.mcp_workers![worker.worker_id]!.rooms;
      target[roomId] ??= {};
      if (target[roomId].pending) throw new Error("Another registration is in progress for this worker; retry explicitly.");
      target[roomId].pending = operation;
    });
    session = await finishOrClear(operation);
  }
  pinWorkerConnection(getLocalStatePath(), session);
  if (!local) holdProcessConnection(session);
  return { worker: getWorker(worker.worker_id, scope), session };
}

/** A room entry that holds a registration (done or in progress); an empty entry is a room a refused registration left behind. */
const boundRoom = (entry: StoredMcpWorker["rooms"][string] | undefined): boolean => Boolean(entry?.session_id || entry?.pending);

/**
 * The room a worker call acts in. One registration key is one worker handle,
 * and a handle may be registered in several rooms (the same key in another
 * room binds it there too), so the room must be chosen, not assumed:
 * `room_id` when the call names one, else the room this session joined when
 * the worker is registered there, else the worker's only room. With several
 * rooms and none of these, the answer names them and asks for `room_id`. A
 * room the worker never registered in says so, and how to register there.
 *
 * The joined room counts only for a session of one chat. The credential's
 * implicit session serves every session-less chat of the sign-in and keeps
 * one joined room for all of them, so there another chat's join must not
 * choose this chat's room: a worker in several rooms needs `room_id`.
 */
function workerCallRoom(worker: StoredMcpWorker, roomId: string | undefined): string {
  const rooms = Object.keys(worker.rooms).filter((room) => boundRoom(worker.rooms[room]));
  const listed = rooms.map((room) => `"${room}"`).join(", ");
  if (roomId) {
    if (boundRoom(worker.rooms[roomId])) return roomId;
    throw new Error(`This worker is not registered in room "${roomId}"`
      + (rooms.length ? `; it is registered in ${rooms.length === 1 ? "room" : "rooms"} ${listed}. ` : ". ")
      + `To act there, call register_agent_session(worker_id, room_id "${roomId}") first; a registration key already `
      + "used in another room keeps the same worker_id and binds it to this room as well.");
  }
  if (!currentSessionScope()?.implicit) {
    const joined = getCurrentRoom()?.room_id;
    if (joined && boundRoom(worker.rooms[joined])) return joined;
  }
  if (rooms.length === 1) return rooms[0]!;
  if (rooms.length === 0) {
    throw new Error("This worker is not registered in any room. Call register_agent_session(worker_id, room_id) first.");
  }
  throw new Error(`This worker is registered in ${rooms.length} rooms (${listed}) and this chat has not joined one of them. `
    + "Pass room_id to say which room this call is for.");
}

export async function runMcpWorkerCall<T>(workerId: string, roomId: string | undefined,
  callback: (session: StoredAgentSessionState) => T, allowEnded = false): Promise<Awaited<T>> {
  const worker = getWorker(workerId, await workerScope());
  // Use orders which handles a remote credential keeps, so a remote session
  // records every call (its state is in memory and saved anyway); the stdio
  // state file, which no credential reads, is written at most once an interval.
  const now = Date.now();
  const recordInterval = currentSessionScope() ? 0 : WORKER_USE_RECORD_INTERVAL_MS;
  if (!worker.last_used_at || now - Date.parse(worker.last_used_at) > recordInterval) {
    updateLocalState((state) => {
      const stored = state.mcp_workers?.[workerId];
      if (stored) stored.last_used_at = new Date(now).toISOString();
    });
  }
  const targetRoom = workerCallRoom(worker, roomId);
  const entry = worker.rooms[targetRoom];
  const session = entry?.session_id ? pinnedWorkerConnection(getLocalStatePath(), entry.session_id) : null;
  const stored = entry?.session_id ? snapshot().agent_sessions?.[entry.session_id] : null;
  if (!session || !stored || entry?.pending || stored.ended_at || session.session_token !== stored.session_token) {
    throw new Error(`This worker has no current connection in this process for room "${targetRoom}". `
      + `Reconnect explicitly with register_agent_session(worker_id, room_id "${targetRoom}").`);
  }
  return await withWorkerCall(session, async () => {
    const result = await callback(session);
    assertWorkerConnection(session, allowEnded);
    return result;
  });
}
