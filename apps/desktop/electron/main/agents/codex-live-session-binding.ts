import type { DesktopCodexLiveSessionState } from "./state.js";
import {
  readAgentLocalState,
  updateCodexLiveSession,
} from "./state.js";
import {
  type BindCodexLiveSessionOptions,
  codexWorkerSessionForLiveSession,
  persistedWorkerSessionIsInvalid,
} from "./codex-live-session-lookup.js";

export type { BindCodexLiveSessionOptions } from "./codex-live-session-lookup.js";
export {
  codexWorkerSessionForLiveSession,
  persistedWorkerSessionIsInvalid,
  workerCanBindToLiveSession,
} from "./codex-live-session-lookup.js";

export function bindCodexLiveSessionToWorker(
  session: DesktopCodexLiveSessionState,
  options: BindCodexLiveSessionOptions = {},
): DesktopCodexLiveSessionState {
  const state = readAgentLocalState();
  const workerSession = codexWorkerSessionForLiveSession(state, session, options);
  if (!workerSession) {
    if (persistedWorkerSessionIsInvalid(state, session)) {
      return updateCodexLiveSession(session.session_id, (current) => ({
        ...current,
        agent_session_id: null,
        updated_at: new Date().toISOString(),
      })) ?? {
        ...session,
        agent_session_id: null,
      };
    }
    return session;
  }
  if (workerSession.session_id === session.agent_session_id) {
    return session;
  }

  return updateCodexLiveSession(session.session_id, (current) => ({
    ...current,
    agent_session_id: workerSession.session_id,
    updated_at: new Date().toISOString(),
  })) ?? {
    ...session,
    agent_session_id: workerSession.session_id,
  };
}
