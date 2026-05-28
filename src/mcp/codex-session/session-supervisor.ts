import {
  getStoredCodexLiveSession,
  type CodexLiveSessionState,
  type StoredAgentSessionState,
} from "../local-state.js";
import { terminateSpawnedProcess } from "./app-server.js";
import { createCodexRuntimeBridgeController } from "./runtime-bridge.js";
import type { RpcClient } from "./rpc-client.js";
import type { CodexRuntimeReasoningSummary } from "./runtime-summary.js";
import { isTerminalCodexSessionStatus } from "./session-status.js";
import type { LocalCodexSessionStatus } from "./types.js";

const SESSION_MONITOR_INTERVAL_MS = 30_000;

type SessionInspector = (sessionId: string) => Promise<LocalCodexSessionStatus | null>;

const spawnedServerPids = new Set<number>();
const sessionMonitorTimers = new Map<string, ReturnType<typeof setInterval>>();

let inspectSession: SessionInspector | null = null;
let cleanupRegistered = false;

function inspectConfiguredSession(sessionId: string): Promise<LocalCodexSessionStatus | null> {
  if (!inspectSession) {
    throw new Error("Codex session inspector has not been configured.");
  }
  return inspectSession(sessionId);
}

const runtimeBridge = createCodexRuntimeBridgeController({
  inspectSession: inspectConfiguredSession,
  isTerminalStatus: isTerminalCodexSessionStatus,
});

export function configureCodexSessionInspector(inspector: SessionInspector): void {
  inspectSession = inspector;
}

function registerProcessCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const timer of sessionMonitorTimers.values()) {
      clearInterval(timer);
    }
    sessionMonitorTimers.clear();

    runtimeBridge.cleanup();

    for (const pid of spawnedServerPids) {
      terminateSpawnedProcess(pid);
    }
    spawnedServerPids.clear();
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

export function registerLaunchedAppServer(pid: number): void {
  spawnedServerPids.add(pid);
  registerProcessCleanup();
}

export function forgetLaunchedAppServer(pid: number): void {
  spawnedServerPids.delete(pid);
}

export function clearSessionMonitor(sessionId: string): void {
  const timer = sessionMonitorTimers.get(sessionId);
  if (!timer) {
    return;
  }

  clearInterval(timer);
  sessionMonitorTimers.delete(sessionId);
}

export function killOwnedAppServer(session: CodexLiveSessionState): void {
  if (!session.launched_server || !session.server_pid) {
    return;
  }

  terminateSpawnedProcess(session.server_pid);
  spawnedServerPids.delete(session.server_pid);
}

export function scheduleOwnedSessionMonitor(session: CodexLiveSessionState): void {
  if (!session.launched_server || sessionMonitorTimers.has(session.session_id)) {
    return;
  }

  const timer = setInterval(() => {
    void inspectConfiguredSession(session.session_id)
      .then((status) => {
        if (
          !status ||
          !status.server_reachable ||
          isTerminalCodexSessionStatus(status.session.status)
        ) {
          runtimeBridge.stop(session.session_id);
          clearSessionMonitor(session.session_id);
          return;
        }
        void runtimeBridge.maybeStart(status.session).catch(() => {
          // The monitor should keep supervising even when the optional stream bridge is unavailable.
        });
      })
      .catch(() => {
        const latest = getStoredCodexLiveSession(session.session_id);
        if (latest?.launched_server) {
          killOwnedAppServer(latest);
        }
        runtimeBridge.stop(session.session_id);
        clearSessionMonitor(session.session_id);
      });
  }, SESSION_MONITOR_INTERVAL_MS);
  timer.unref?.();
  sessionMonitorTimers.set(session.session_id, timer);
}

export async function bindCodexRuntimeStreamBridgeForAgentSession(
  workerSession: StoredAgentSessionState
): Promise<boolean> {
  return runtimeBridge.bindForAgentSession(workerSession);
}

export function scheduleCodexRuntimeStreamBridgeBind(
  workerSession: StoredAgentSessionState,
  attempts?: number
): void {
  runtimeBridge.scheduleBind(workerSession, attempts);
}

export async function maybeStartCodexRuntimeBridge(session: CodexLiveSessionState): Promise<void> {
  await runtimeBridge.maybeStart(session);
}

export function startCodexRuntimeBridge(session: CodexLiveSessionState, client: RpcClient): void {
  runtimeBridge.start(session, client);
}

export async function postCodexRuntimeReasoningSummary(
  session: CodexLiveSessionState,
  summary: CodexRuntimeReasoningSummary | null
): Promise<void> {
  if (!summary) {
    return;
  }

  await runtimeBridge.postReasoningSummary(session, summary);
}
