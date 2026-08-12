import type {
  DesktopRoomAgentCausalEvent,
  DesktopRoomSharedArtifact,
  DesktopSupervisorAgentInspectorDetail,
  DesktopSupervisorManifestEntry,
  DesktopTaskSummary,
} from "../../../electron/ipc-types";
import { roomArtifactTimelineItems, type RoomArtifactTimelineItem } from "./room-artifacts";

export type AgentInspectorWorkResource = {
  status: "idle" | "loading" | "refreshing" | "ready" | "unavailable" | "error";
  detail: DesktopSupervisorAgentInspectorDetail | null;
  error: string | null;
  sourceMessageId: string | null;
};

export function emptyAgentInspectorWorkResource(): AgentInspectorWorkResource {
  return { status: "idle", detail: null, error: null, sourceMessageId: null };
}

/** A detail response is usable only when every durable routing fence agrees. */
export function isCurrentAgentInspectorWorkResponse(
  detail: DesktopSupervisorAgentInspectorDetail,
  entryId: string,
  roomId: string,
  sourceMessageId: string | null,
): boolean {
  return detail.entry_id === entryId
    && detail.room_id === roomId
    && detail.requested_source_message_id === sourceMessageId
    && (sourceMessageId === null
      ? detail.availability === "not_loaded" && detail.source_message === null
      : (detail.availability !== "available" || detail.source_message?.id === sourceMessageId));
}

/** The active turn wins; otherwise the daemon's bounded newest-first list wins. */
export function defaultAgentInspectorWorkSource(
  entry: Pick<DesktopSupervisorManifestEntry, "roomAgentState">,
  detail: Pick<DesktopSupervisorAgentInspectorDetail, "items"> | null,
): string | null {
  const active = entry.roomAgentState?.turn.sourceMessageId?.trim();
  return active || detail?.items[0]?.source_message_id || null;
}

export function humanizeAgentInspectorReceiptState(state: string, terminalReason: string | null = null): string {
  if (terminalReason === "upgrade_authority_unavailable") return "Retired during a safety upgrade";
  const labels: Record<string, string> = {
    pending: "Waiting to start", dispatching: "Starting work", awaiting_result: "Working",
    result_recovery: "Recovering the result", publishing: "Publishing reply",
    acknowledged: "Reply published", acknowledged_no_reply: "No reply needed",
    retryable: "Ready to retry", blocked: "Needs attention",
    cancelled_by_room_move: "Cancelled after room move",
    cancelled_by_user: "Skipped by you",
    restoring_conversation: "Restoring conversation",
  };
  return labels[state] || "Recorded work";
}

export function describeAgentInspectorUncertainEffect(toolName: string): string {
  return `${toolName} may have completed before its result was saved. Verify external state before repeating it.`;
}

export function humanizeAgentInspectorTimeline(event: DesktopRoomAgentCausalEvent): string {
  const labels: Record<DesktopRoomAgentCausalEvent["phase"], string> = {
    received: "Message received", queued: "Work queued", turn_started: "Work started",
    turn_finished: "Work finished", result_unreadable: "Result needs recovery",
    publish_started: "Reply publication started", published: "Reply published",
    no_reply: "No reply was needed", retry_scheduled: "Retry scheduled",
    blocked: "Work needs attention", room_move_cancelled: "Cancelled after room move",
    conversation_restoring: "Conversation restoration started",
    conversation_restored: "Conversation restored",
    user_cancelled: "Message skipped by you",
  };
  return labels[event.phase];
}

/** Task and artifact linkage is by IDs supplied by the durable projections only. */
export function agentInspectorWorkArtifacts(
  tasks: readonly Pick<DesktopTaskSummary, "id">[],
  artifacts: readonly DesktopRoomSharedArtifact[],
): RoomArtifactTimelineItem[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  return roomArtifactTimelineItems(artifacts).filter((item) =>
    item.artifact.linkedTaskIds.some((id) => taskIds.has(id)),
  );
}
