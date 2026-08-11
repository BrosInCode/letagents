import type { DesktopManagedAgentSession, DesktopRoomStreamEvent } from "../../ipc-types.js";
import {
  canDeliverCodexStopControlToManagedAgent,
  isOwnRoomStreamEventForManagedAgentAmongWorkers,
  isStopPhraseRoomStreamEvent,
  resolveCodexRoomStreamEventRecipients,
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
  roomSessions?: readonly DesktopManagedAgentSession[],
  populationComplete = true,
): DesktopCodexLiveSessionState[] {
  const codexSessions = listDesktopManagedCodexLiveSessions(event.roomIdentifier)
    .map((session) => bindCodexLiveSessionToWorker(session))
    .filter((session) => !session.provider_id || session.provider_id === "codex");
  const publicCodexSessions = codexSessions.map(toPublicManagedAgentSession);
  const ambiguityPopulation = roomSessions ?? publicCodexSessions;
  const resolvedCodexIds = new Set(resolveCodexRoomStreamEventRecipients(
    ambiguityPopulation,
    event,
    populationComplete,
  ).map((session) => session.id));

  return codexSessions.filter((session) =>
    resolvedCodexIds.has(session.session_id) ||
      (isStopPhraseRoomStreamEvent(session, event) &&
        canDeliverCodexStopControlToManagedAgent(toPublicManagedAgentSession(session)) &&
        !isOwnRoomStreamEventForManagedAgentAmongWorkers(
          toPublicManagedAgentSession(session),
          ambiguityPopulation,
          event,
        ))
  );
}
