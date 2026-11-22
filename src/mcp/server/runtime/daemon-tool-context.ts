import { AsyncLocalStorage } from "node:async_hooks";

import type { StoredAgentSessionState } from "../../local-state.js";

export type DaemonToolExecutionContext = {
  roomId: string;
  apiUrl: string;
  bearer: string;
  cwd: string;
  agentSession: StoredAgentSessionState;
  /** Durable effect_id assigned by the daemon's unified `effects` journal. */
  effectId?: string;
};

/** Marks a validation error proven to have failed before any external side effect was dispatched. */
export function markPreDispatchError<T extends Error>(error: T): T & { beforeExternalDispatch: true } {
  return Object.assign(error, { beforeExternalDispatch: true as const });
}

const daemonToolContext = new AsyncLocalStorage<DaemonToolExecutionContext>();

export function getDaemonToolExecutionContext(): DaemonToolExecutionContext | null {
  return daemonToolContext.getStore() ?? null;
}

export function runWithDaemonToolExecutionContext<T>(
  context: DaemonToolExecutionContext,
  callback: () => T,
): T {
  return daemonToolContext.run(context, callback);
}

export function getRuntimeWorkingDirectory(): string {
  return getDaemonToolExecutionContext()?.cwd ?? process.cwd();
}
