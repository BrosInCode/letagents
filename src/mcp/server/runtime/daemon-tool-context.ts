import { AsyncLocalStorage } from "node:async_hooks";

import type { StoredAgentSessionState } from "../../local-state.js";

export type DaemonToolExecutionContext = {
  roomId: string;
  apiUrl: string;
  bearer: string;
  cwd: string;
  agentSession: StoredAgentSessionState;
};

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
