import {
  disconnectDesktopManagedWorker,
} from "./managed-agent-worker.js";
import {
  getStoredAgentSession,
  listDesktopManagedCodexLiveSessionsForProvider,
  removeStoredCodexLiveSession,
  type DesktopCodexLiveSessionState,
  type StoredAgentSessionState,
} from "./state.js";

export type LegacyOpenModelRetirementResult = {
  retiredSessionIds: string[];
  disconnectedWorkerSessionIds: string[];
  unverifiableProcessIds: number[];
};

export type LegacyOpenModelRetirementDependencies = {
  listSessions(): DesktopCodexLiveSessionState[];
  getWorkerSession(sessionId: string): StoredAgentSessionState | null;
  disconnectWorker(session: StoredAgentSessionState | null): Promise<void>;
  removeSession(sessionId: string): DesktopCodexLiveSessionState | null;
  reportRetirement(result: LegacyOpenModelRetirementResult): void;
};

const defaultDependencies: LegacyOpenModelRetirementDependencies = {
  listSessions: () => listDesktopManagedCodexLiveSessionsForProvider("open-model"),
  getWorkerSession: getStoredAgentSession,
  disconnectWorker: disconnectDesktopManagedWorker,
  removeSession: removeStoredCodexLiveSession,
  reportRetirement: (result) => {
    console.warn("Retired removed Codex-backed Open Model sessions.", {
      ...result,
      processSignalPolicy: "not_signalled_without_birth_identity",
    });
  },
};

/**
 * Retire the removed Codex-backed Open Model representation.
 *
 * Its saved rows predate durable process-birth identity, so startup must never
 * signal their PIDs. Disconnecting the exact worker credential first fences
 * room observation/publication; removing the local row then prevents any
 * compatibility dispatch or misleading recovery UI. Worktrees stay untouched.
 */
export async function retireLegacyCodexBackedOpenModelSessions(
  dependencies: LegacyOpenModelRetirementDependencies = defaultDependencies,
): Promise<LegacyOpenModelRetirementResult> {
  const sessions = dependencies.listSessions();
  const retiredSessionIds: string[] = [];
  const disconnectedWorkerSessionIds: string[] = [];
  const unverifiableProcessIds: number[] = [];
  for (const session of sessions) {
    const workerSession = session.agent_session_id
      ? dependencies.getWorkerSession(session.agent_session_id)
      : null;
    await dependencies.disconnectWorker(workerSession);
    if (workerSession?.session_id) {
      disconnectedWorkerSessionIds.push(workerSession.session_id);
    }
    if (session.server_pid) unverifiableProcessIds.push(session.server_pid);
    if (dependencies.removeSession(session.session_id)) {
      retiredSessionIds.push(session.session_id);
    }
  }
  if (retiredSessionIds.length > 0) {
    dependencies.reportRetirement({
      retiredSessionIds,
      disconnectedWorkerSessionIds,
      unverifiableProcessIds,
    });
  }
  return {
    retiredSessionIds,
    disconnectedWorkerSessionIds,
    unverifiableProcessIds,
  };
}
