import type { DesktopRoomStreamEvent } from "../../ipc-types.js";
import {
  shouldDeliverCodexRoomStreamEventToSession,
  shouldDeliverRoomStreamEventToSession,
} from "./codex-event-routing.js";
import {
  bindCodexLiveSessionToWorker,
  listDesktopManagedCodexLiveSessions,
  type DesktopCodexLiveSessionState,
} from "./state.js";

export type ManagedRoomEvent = Extract<DesktopRoomStreamEvent, { type: "message" | "task_update" }>;

export function isManagedRoomStreamEvent(event: DesktopRoomStreamEvent): event is ManagedRoomEvent {
  return event.type === "message" || event.type === "task_update";
}

export function listDeliverableCodexSessionsForRoomStreamEvent(
  event: ManagedRoomEvent,
): DesktopCodexLiveSessionState[] {
  return listDesktopManagedCodexLiveSessions(event.roomIdentifier)
    .map((session) => bindCodexLiveSessionToWorker(session))
    .filter((session) => session.provider_id === "open-model"
      ? shouldDeliverRoomStreamEventToSession(session, event)
      : shouldDeliverCodexRoomStreamEventToSession(session, event));
}
