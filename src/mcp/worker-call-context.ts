import { AsyncLocalStorage } from "node:async_hooks";
import type { StoredAgentSessionState } from "./local-state/types.js";
import { readLocalStateSnapshot, withLocalStateReadLock, type LocalStateSnapshot } from "./local-state/storage.js";
import { isMcpWorkerId } from "../shared/mcp-worker.js";

const calls = new AsyncLocalStorage<StoredAgentSessionState>();
const connections = new Map<string, StoredAgentSessionState>();

export function withWorkerCall<T>(session: StoredAgentSessionState, callback: () => T): T {
  return calls.run(session, callback);
}

export function currentWorkerCall(): StoredAgentSessionState | undefined {
  return calls.getStore();
}

function checkConnection(snapshot: LocalStateSnapshot, session: StoredAgentSessionState, allowEnded: boolean): void {
  const current = snapshot.state.agent_sessions?.[session.session_id];
  if (!snapshot.complete || !current || current.session_token !== session.session_token
    || (!allowEnded && current.ended_at)
    || snapshot.state.mcp_workers?.[session.agent_instance_id!]?.rooms[session.room_id]?.pending) {
    throw new Error("This worker connection was replaced or disconnected. Reconnect explicitly with its worker_id.");
  }
}

export function assertWorkerConnection(session = currentWorkerCall(), allowEnded = false): void {
  if (session && isMcpWorkerId(session.agent_instance_id)) checkConnection(readLocalStateSnapshot(), session, allowEnded);
}

export function withWorkerStateFence<T>(callback: () => T): T {
  const session = currentWorkerCall();
  if (!session || !isMcpWorkerId(session.agent_instance_id)) return callback();
  return withLocalStateReadLock((snapshot) => {
    checkConnection(snapshot, session, false);
    return callback();
  });
}

export function pinWorkerConnection(statePath: string, session: StoredAgentSessionState): void {
  connections.set(`${statePath}\n${session.session_id}`, structuredClone(session));
}

export function pinnedWorkerConnection(statePath: string, sessionId: string): StoredAgentSessionState | null {
  const call = currentWorkerCall();
  return call?.session_id === sessionId ? call : connections.get(`${statePath}\n${sessionId}`) ?? null;
}
