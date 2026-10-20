import { agentScheduledRetry } from "../../domain/scheduled-retry";
import { supervisedAgentInspectorRequest } from "../../domain/agent-inspector-identity";
import { ownerAttribution as ownerAttributionLabel } from "../../components/desktop/content/room-activity/agentTarget";
import { desktopIpc } from "../../ipc/index.js";
import { hostApprovalStopsTurn } from "../../components/desktop/content/room-chat/host-approval-presentation";
import { hostApprovalIdentity, hostApprovalRoom, refreshHostApprovals } from "../../components/desktop/content/room-chat/host-approvals";
import type { RoomShellContextOf } from "./context";

/** Room delivery controls: retry, conversation restore, skip, and approval answers. */
export function useRoomShellDeliveryActions(context: unknown) {
  const {
    continuationRepairAvailable, continuationRepairCoordinator, deliveryRetryAvailable,
    deliveryRetryCoordinator, props, pushActionToast, roomDeliverySkipAvailable,
    roomDeliverySkipCoordinator, supervisorEntries,
  } = context as RoomShellContextOf<"inputs" | "useRoomShellState">;
  const app = context as RoomShellContextOf<"useRoomShellSupervisorActions" | "pending">;
  async function retryRoomAgentDelivery(agentId: string, sourceMessageId: string): Promise<void> {
    if (!deliveryRetryAvailable.value) return;
    const entry = supervisorEntries.value.find((candidate) => candidate.id === agentId);
    if (!entry?.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) {
      pushActionToast("This delivery binding changed. Refresh the room before retrying.", "error", 6_000);
      return;
    }
    const { workAttemptId, executionGenerationId, agentSessionId } = entry;
    // Try now: the id names the agent's automatic attempt that waits for its time, not a blocked message.
    const tryNow = agentScheduledRetry(entry.deliveryReceipts)?.sourceMessageId === sourceMessageId;
    const result = await deliveryRetryCoordinator.run({ agentId, sourceMessageId }, async () => {
      await desktopIpc.supervisor!.retryRoomDelivery({
        entryId: entry.id,
        roomId: props.room.identifier,
        sourceMessageId,
        workAttemptId,
        executionGenerationId,
        agentSessionId,
      });
      await app.refreshSupervisorEntries();
      const refreshed = supervisorEntries.value.find((candidate) => candidate.id === agentId);
      return refreshed?.deliveryReceipts?.find((candidate) => candidate.sourceMessageId === sourceMessageId);
    });
    if (!result.started) return;
    if (!result.ok) {
      pushActionToast(result.error instanceof Error ? result.error.message : "Could not retry room delivery.", "error", 7_000);
      return;
    }
    if (tryNow) {
      // Accepted is all that is known here: the turn has not started yet.
      pushActionToast("Request accepted. The agent tries again as soon as it can start.", "success", 5_000);
      return;
    }
    pushActionToast(
      result.value?.state === "blocked"
        ? "Delivery still needs attention."
        : "Delivery retry accepted. The agent is resuming delivery.",
      result.value?.state === "blocked" ? "error" : "success",
      5_000,
    );
  }

  function exactRoomDeliveryControlInput(agentId: string, sourceMessageId: string): {
    entryId: string;
    roomId: string;
    sourceMessageId: string;
    workAttemptId: string;
    executionGenerationId: string;
    agentSessionId: string;
  } | null {
    const entry = supervisorEntries.value.find((candidate) => candidate.id === agentId);
    if (!entry?.workAttemptId || !entry.executionGenerationId || !entry.agentSessionId) return null;
    return {
      entryId: entry.id,
      roomId: props.room.identifier,
      sourceMessageId,
      workAttemptId: entry.workAttemptId,
      executionGenerationId: entry.executionGenerationId,
      agentSessionId: entry.agentSessionId,
    };
  }

  async function restoreAgentConversation(agentId: string, sourceMessageId: string): Promise<void> {
    if (!continuationRepairAvailable.value) return;
    const input = exactRoomDeliveryControlInput(agentId, sourceMessageId);
    if (!input) {
      pushActionToast("This agent binding changed. Refresh the room before restoring its conversation.", "error", 7_000);
      return;
    }
    const result = await continuationRepairCoordinator.run({ agentId, sourceMessageId }, async () => {
      await desktopIpc.supervisor.restoreAgentConversation(input);
    });
    if (!result.started) return;
    if (!result.ok) {
      pushActionToast(result.error instanceof Error ? result.error.message : "Could not restore this agent’s conversation.", "error", 7_000);
      return;
    }
    pushActionToast("Conversation restoration started. The provider will stay running.", "success", 5_000);
  }

  async function skipRoomDelivery(agentId: string, sourceMessageId: string): Promise<void> {
    if (!roomDeliverySkipAvailable.value) return;
    const input = exactRoomDeliveryControlInput(agentId, sourceMessageId);
    if (!input) {
      pushActionToast("This agent binding changed. Refresh the room before skipping the message.", "error", 7_000);
      return;
    }
    // Stop trying: the id names the agent's automatic attempt that waits for its time, not a blocked message.
    const stopTrying = agentScheduledRetry(supervisorEntries.value.find((candidate) => candidate.id === agentId)?.deliveryReceipts)?.sourceMessageId === sourceMessageId;
    const result = await roomDeliverySkipCoordinator.run({ agentId, sourceMessageId }, async () => {
      await desktopIpc.supervisor.skipRoomDelivery(input);
    });
    if (!result.started) return;
    if (!result.ok) {
      pushActionToast(result.error instanceof Error ? result.error.message : "Could not safely skip this message.", "error", 7_000);
      return;
    }
    pushActionToast(stopTrying
      ? "Stopped the automatic attempts. The task is still assigned to this agent. Send it a message to continue."
      : "Message skipped. Later room work can continue.", "success", stopTrying ? 8_000 : 5_000);
  }

  /**
   * A permission card that cannot be answered here stops its agent's turn,
   * which cancels the request. The card can be older than the turn the agent
   * is running now, so the approvals are read again first: the turn is stopped
   * only while that same request still waits in the agent's current session,
   * and otherwise only the card refreshes. The agent opens where its turn
   * controls are, so the stop's progress, or why it is not possible yet, shows.
   */
  async function stopAgentTurnForApproval(entryId: string, approvalId: string): Promise<void> {
    const roomId = props.room.identifier;
    const shown = hostApprovalRoom(roomId);
    const known = shown.approvals.find((candidate) => candidate.id === approvalId);
    const firstSeenAt = known ? shown.firstSeenAt[hostApprovalIdentity(known)] : undefined;
    const snapshot = await desktopIpc.supervisor?.listHostApprovals?.(roomId).catch(() => null);
    const approval = snapshot?.available ? snapshot.approvals.find((candidate) => candidate.id === approvalId) : undefined;
    const entry = supervisorEntries.value.find((candidate) => candidate.id === entryId && candidate.roomId === roomId);
    if (!approval || !entry || approval.presentation.agentId !== entryId
      || !hostApprovalStopsTurn(approval, firstSeenAt, Date.now(), entry.providerContinuationId)) {
      void refreshHostApprovals(roomId);
      return;
    }
    app.openAgentDetailRequest(supervisedAgentInspectorRequest(entry, { ownerAttribution: ownerAttributionLabel(entry.createdBy) }));
    void app.runAgentInspectorAction({ entryId, roomId, kind: "stop_turn" });
  }

  function postAgentAnswerNow(entryId: string, sourceMessageId: string | null): void { // The stop of a turn that only waits for background work posts the answer it has.
    const entry = supervisorEntries.value.find((candidate) => candidate.id === entryId && candidate.roomId === props.room.identifier);
    if (!entry || !sourceMessageId || entry.roomAgentState?.turn.sourceMessageId !== sourceMessageId) return; // Only the turn that the button was shown for: a later turn would be stopped at its work.
    app.openAgentDetailRequest(supervisedAgentInspectorRequest(entry, { ownerAttribution: ownerAttributionLabel(entry.createdBy) }));
    void app.runAgentInspectorAction({ entryId, roomId: entry.roomId, kind: "stop_turn" });
  }
  return {
    retryRoomAgentDelivery, exactRoomDeliveryControlInput, restoreAgentConversation,
    skipRoomDelivery, stopAgentTurnForApproval, postAgentAnswerNow,
  };
}
