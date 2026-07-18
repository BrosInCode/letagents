import { ref } from "vue";
import type {
  DesktopManagedAgentSession,
  DesktopManagedAgentStartInput,
} from "../../../../../../electron/ipc-types";
import { desktopIpc } from "../../../../ipc/index.js";
import {
  managedAgentStopResultMessage,
  managedAgentStopResultNeedsAttention,
} from "../../../../domain/managed-agents";
import { useManagedAgentSessionsContext } from "./managed-agent-sessions-context";
import { contextualAddAgentError, type AddAgentFeedbackTone } from "./add-agent-errors";

export function useManagedAgentLaunch(options: {
  onStarted?: (session: DesktopManagedAgentSession) => void;
  onFeedback?: (message: string, tone?: AddAgentFeedbackTone) => void;
} = {}) {
  const sessions = useManagedAgentSessionsContext();
  const starting = ref(false);
  const stoppingSessionId = ref<string | null>(null);

  async function start(input: DesktopManagedAgentStartInput): Promise<string> {
    if (starting.value) throw new Error("Another agent is still starting.");
    starting.value = true;
    try {
      const result = await desktopIpc.workers.startManagedAgent(input);
      sessions.upsert(result.session);
      options.onStarted?.(result.session);
      await sessions.refresh();
      return result.message;
    } finally {
      starting.value = false;
    }
  }

  async function stop(sessionId: string): Promise<void> {
    if (stoppingSessionId.value) return;
    stoppingSessionId.value = sessionId;
    options.onFeedback?.("Stopping local agent...");
    try {
      const session = await desktopIpc.workers.stopManagedAgent({ sessionId, stopMode: "worker" });
      if (session) {
        sessions.upsert(session);
        options.onFeedback?.(
          managedAgentStopResultMessage(session),
          managedAgentStopResultNeedsAttention(session) ? "error" : "status",
        );
      }
      await sessions.refresh();
    } catch (error) {
      options.onFeedback?.(contextualAddAgentError(
        "Couldn't stop this local agent",
        error,
        "It may still be running. Refresh its status and try again.",
      ), "error");
    } finally {
      stoppingSessionId.value = null;
    }
  }

  return { starting, stoppingSessionId, start, stop };
}
