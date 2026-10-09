import type { DesktopRoomAgentDeliveryAttention, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import { supervisedAgentDisplayLabel } from "./codenames";
import { agentScheduledRetry, waitsBehindScheduledRetry, type AgentScheduledRetry } from "./scheduled-retry";

/**
 * What became of the agent's follow-up of this message's failed work, when
 * it does not wait for its time. `waiting_for_owner`: it is blocked, and
 * Retry starts it. `ended`: it ended with nothing started.
 */
export interface RoomMessageFollowUpNote {
  state: "waiting_for_owner" | "ended";
  /** Names the follow-up for Retry. It is not a room message. */
  sourceMessageId: string;
  /** What the follow-up says: why it waits for its owner, or why it ended. */
  text: string | null;
  /** Retry starts the turn of a follow-up that waits for its owner. The other ways to recover one are in the agent's inspector. */
  canRetry: boolean;
}

/** One agent's delivery of a room message, as that message shows it. */
export interface RoomMessageDeliveryReceipt {
  agentId: string;
  agentName: string;
  /** The receipt's state, or `queued_behind_retry` for a message that waits for the agent's automatic attempt. */
  state: string;
  /** The earlier message this one waits behind: the blocked one, or the one whose work the agent tries again. */
  blockedByMessageId: string | null;
  error: string | null;
  failureCode: string | null;
  terminalReason: string | null;
  attemptCount: number;
  providerTurnId: string | null;
  retry: DesktopRoomAgentDeliveryAttention["retry"] | null;
  /** The agent's automatic attempt for the work this message began, while it waits for its time. */
  scheduledRetry: AgentScheduledRetry | null;
  /** The follow-up of the work this message began, when it waits for its owner or ended with nothing started. */
  followUpNote: RoomMessageFollowUpNote | null;
}

/**
 * Every agent's receipts, by the room message each one shows on.
 *
 * A follow-up of failed work has no room message of its own: it shows on the
 * message the failed work began with, beside what failed. That is so while it
 * waits for its time, while it waits for its owner, and after it ended with
 * nothing started. A message that arrived in the meantime says what it waits
 * for, and names that message.
 */
export function roomMessageDeliveryReceipts(
  entries: readonly Pick<DesktopSupervisorManifestEntry, "id" | "displayName" | "desiredState" | "deliveryReceipts" | "deliveryAttention">[],
): Record<string, RoomMessageDeliveryReceipt[]> {
  const grouped: Record<string, RoomMessageDeliveryReceipt[]> = {};
  for (const entry of entries) {
    const receipts = entry.deliveryReceipts ?? [];
    // An agent that its owner paused or stopped does not try again at the saved time, so nothing counts down for it.
    const scheduledRetry = entry.desiredState === "running" ? agentScheduledRetry(receipts) : null;
    const attention = entry.deliveryAttention;
    // One series of follow-ups has at most one that waits or that ended unstarted: the last of the series.
    const followUpOf = new Map<string, (typeof receipts)[number]>();
    const originOf = new Map<string, string>();
    for (const receipt of receipts) {
      const origin = receipt.followUp?.forMessageId;
      if (!origin) continue;
      originOf.set(receipt.sourceMessageId, origin);
      if ((followUpOf.get(origin)?.fifoSequence ?? -1) < receipt.fifoSequence) followUpOf.set(origin, receipt);
    }
    for (const receipt of receipts) {
      const behindRetry = waitsBehindScheduledRetry(receipt, scheduledRetry);
      const followUp = followUpOf.get(receipt.sourceMessageId);
      const waitsForOwner = followUp?.followUp?.state === "waiting_for_owner";
      const followUpRetry = followUp && attention?.sourceMessageId === followUp.sourceMessageId ? attention.retry : "start_turn";
      (grouped[receipt.sourceMessageId] ??= []).push({
        agentId: entry.id,
        agentName: supervisedAgentDisplayLabel(entry.displayName, entry.id),
        state: behindRetry ? "queued_behind_retry" : receipt.state,
        blockedByMessageId: behindRetry ? scheduledRetry!.forMessageId
          : receipt.blockedByMessageId ? originOf.get(receipt.blockedByMessageId) ?? receipt.blockedByMessageId : null,
        error: receipt.error,
        failureCode: receipt.failureCode,
        terminalReason: receipt.terminalReason,
        attemptCount: receipt.attemptCount,
        providerTurnId: receipt.providerTurnId,
        retry: receipt.state === "blocked" && attention?.sourceMessageId === receipt.sourceMessageId ? attention.retry : null,
        scheduledRetry: scheduledRetry?.forMessageId === receipt.sourceMessageId ? scheduledRetry : null,
        followUpNote: followUp && (waitsForOwner || followUp.followUp?.state === "ended") ? {
          state: waitsForOwner ? "waiting_for_owner" : "ended",
          sourceMessageId: followUp.sourceMessageId,
          text: followUp.error,
          canRetry: waitsForOwner && followUp.failureCode !== "provider_continuation_missing" && followUpRetry === "start_turn",
        } : null,
      });
    }
  }
  return grouped;
}
