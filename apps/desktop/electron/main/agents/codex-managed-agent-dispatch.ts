import type { DesktopRoomStreamEvent } from "../../ipc-types.js";
import {
  canDeliverCodexStopControlToManagedAgent,
  isOwnRoomStreamEventForManagedAgentAmongWorkers,
  isStopPhraseRoomStreamEvent,
  resolveCodexRoomStreamEventRecipients,
  shouldDeliverRoomStreamEventToSession,
} from "./codex-event-routing.js";
import {
  bindCodexLiveSessionToWorker,
  listDesktopManagedCodexLiveSessions,
  toPublicManagedAgentSession,
  type DesktopCodexLiveSessionState,
} from "./state.js";

export type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

export function isManagedRoomStreamEvent(event: DesktopRoomStreamEvent): event is ManagedRoomEvent {
  return event.type === "message" || event.type === "task_update";
}

export function listDeliverableCodexSessionsForRoomStreamEvent(
  event: ManagedRoomEvent,
): DesktopCodexLiveSessionState[] {
  const sessions = listDesktopManagedCodexLiveSessions(event.roomIdentifier)
    .map((session) => bindCodexLiveSessionToWorker(session));
  const codexSessions = sessions.filter((session) => session.provider_id !== "open-model");
  const publicCodexSessions = codexSessions.map(toPublicManagedAgentSession);
  const resolvedCodexIds = new Set(resolveCodexRoomStreamEventRecipients(
    publicCodexSessions,
    event,
  ).map((session) => session.id));

  return sessions.filter((session) => {
    if (session.provider_id === "open-model") {
      return shouldDeliverRoomStreamEventToSession(session, event);
    }
    return resolvedCodexIds.has(session.session_id) ||
      (isStopPhraseRoomStreamEvent(session, event) &&
        canDeliverCodexStopControlToManagedAgent(toPublicManagedAgentSession(session)) &&
        !isOwnRoomStreamEventForManagedAgentAmongWorkers(
          toPublicManagedAgentSession(session),
          publicCodexSessions,
          event,
        ));
  });
}
