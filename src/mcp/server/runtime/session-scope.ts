import { AsyncLocalStorage } from "node:async_hooks";

import type { LetagentsLocalState, StoredAgentSessionState } from "../../local-state/types.js";

/**
 * One remote MCP session served inside the LetAgents API process.
 *
 * The stdio MCP server keeps its runtime in module-level variables and a state
 * file, because it serves exactly one agent per process. The API serves many
 * sessions in one process, so every piece of that runtime looks here first:
 * while a remote tool call runs, the active scope holds the session's state,
 * and module-level values are used only when no scope is active (stdio).
 *
 * The account a session acts as is fixed when the scope is built from an
 * authenticated request, and the only way out to the API is `dispatch`, which
 * runs the API's own route logic in process as that account. Nothing in a
 * scope carries a token.
 */
export interface McpSessionPersistentState {
  /** Replaces ~/.letagents/mcp-state.json for this session. */
  local: LetagentsLocalState;
  /** The room this session joined, as the stdio runtime's `currentRoom`. */
  currentRoom: unknown | null;
  /** Whether the full joining prompt was already delivered in this session. */
  fullPromptDelivered: boolean;
  /**
   * Worker connections this session registered, by agent session id. The
   * stdio server keeps these in process memory ("this process holds it");
   * for a remote session the session is the holder, so they are saved.
   */
  pinnedConnections: Record<string, StoredAgentSessionState>;
}

export interface McpSessionScope {
  readonly sessionId: string;
  /** Account the session acts as; bound once, from the authenticated request. */
  readonly accountId: string;
  /** Stands in for the per-process AGENT_INSTANCE_UUID. */
  readonly agentInstanceId: string;
  /** `clientInfo.name` from the session's initialize request. */
  readonly clientName: string | null;
  /** Public origin for room links (never used to make requests). */
  readonly publicBaseUrl: string;
  /** Runs one API request in process as this session's account. */
  readonly dispatch: (path: string, init: RequestInit) => Promise<Response>;
  /** Saved to Postgres after each request when `dirty` is set. */
  state: McpSessionPersistentState;
  dirty: boolean;
  /** Per-session caches that are rebuilt after a reload. */
  readonly memory: Map<string, unknown>;
  /** Saves `state`; runs after every tool call, before its result is returned. */
  readonly persist: () => Promise<void>;
}

const scopes = new AsyncLocalStorage<McpSessionScope>();

export function currentSessionScope(): McpSessionScope | null {
  return scopes.getStore() ?? null;
}

export function runInSessionScope<T>(scope: McpSessionScope, callback: () => T): T {
  return scopes.run(scope, callback);
}

export function markSessionDirty(): void {
  const scope = currentSessionScope();
  if (scope) scope.dirty = true;
}

/**
 * A module-level value that becomes per session inside a scope. Outside a
 * scope (the stdio server) it behaves exactly like the plain variable it
 * replaces.
 */
export function scopedValue<T>(key: string, initial: () => T): { get(): T; set(value: T): void } {
  let processValue: T | undefined;
  let processSet = false;
  return {
    get() {
      const scope = currentSessionScope();
      if (scope) {
        if (!scope.memory.has(key)) scope.memory.set(key, initial());
        return scope.memory.get(key) as T;
      }
      if (!processSet) {
        processValue = initial();
        processSet = true;
      }
      return processValue as T;
    },
    set(value: T) {
      const scope = currentSessionScope();
      if (scope) {
        scope.memory.set(key, value);
        return;
      }
      processValue = value;
      processSet = true;
    },
  };
}

/** A module-level Map that is separate per session inside a scope. */
export function scopedMap<K, V>(key: string): () => Map<K, V> {
  const value = scopedValue(key, () => new Map<K, V>());
  return () => value.get();
}

export class RemoteSessionLocalMachineError extends Error {
  constructor(what: string) {
    super(`${what} is not available over the remote MCP endpoint.`);
    this.name = "RemoteSessionLocalMachineError";
  }
}

/** Refuse a local-machine effect (files, git, programs) inside a remote session. */
export function refuseLocalMachineInSession(what: string): void {
  if (currentSessionScope()) throw new RemoteSessionLocalMachineError(what);
}
