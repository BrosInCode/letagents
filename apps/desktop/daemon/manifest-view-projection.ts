import type { SupervisedInboxReceiptProjection } from "./supervised-agent-inbox-store.js";
import { FOLLOW_UP_ENDED, MAX_AUTOMATIC_FOLLOW_UPS, NO_REPLY_FOLLOW_UP_DETAIL } from "./task-continuity.js";
import type { DaemonManifestEntryView } from "./types.js";

const FOLLOW_UP_SOURCE = "task-continuation:";
/** How far back a follow-up is traced to its room message: the automatic ones, and the ones its owner retried after them. */
const FOLLOW_UP_CHAIN_LIMIT = 8;
const ENDED_UNSTARTED: readonly string[] = Object.values(FOLLOW_UP_ENDED);

export function projectDeliveryReceipts(
  receipts: readonly SupervisedInboxReceiptProjection[],
  restoringInboxItemId: string | null,
): DaemonManifestEntryView["delivery_receipts"] {
  const sourceMessageByInboxId = new Map(receipts.map((receipt) => [receipt.inbox_item_id, receipt.source_message_id]));
  // A follow-up has no room message of its own. While it waits for its time or for its owner, and when it ended
  // with nothing started, it says which room message the failed work began with: that is where its owner looks.
  // Each follow-up names the item it follows, so the chain back to a room message also says which attempt this is.
  const followUp = (receipt: SupervisedInboxReceiptProjection): NonNullable<DaemonManifestEntryView["delivery_receipts"]>[number]["follow_up"] => {
    if (!receipt.source_message_id.startsWith(FOLLOW_UP_SOURCE)) return undefined;
    const state = receipt.receipt_state === "pending" && receipt.next_attempt_at_ms !== null ? "scheduled" as const
      : receipt.receipt_state === "blocked" ? "waiting_for_owner" as const
      // Ended with nothing started, for a reason it says itself. A blocked follow-up that its owner skipped is not one.
      : !receipt.provider_turn_id && (receipt.receipt_state === "cancelled_by_user" || receipt.receipt_state === "acknowledged_no_reply")
        && ENDED_UNSTARTED.includes(receipt.last_error ?? "") ? "ended" as const
      : null;
    if (!state) return undefined;
    let attempt = 0;
    let source: string | undefined = receipt.source_message_id;
    while (source?.startsWith(FOLLOW_UP_SOURCE) && attempt < FOLLOW_UP_CHAIN_LIMIT) {
      attempt += 1;
      source = sourceMessageByInboxId.get(source.slice(FOLLOW_UP_SOURCE.length));
    }
    // A turn that ended without a reply gets one automatic attempt. A short provider fault gets three.
    const kind = receipt.last_error === NO_REPLY_FOLLOW_UP_DETAIL ? "no_reply" as const : "provider_fault" as const;
    return { for_message_id: source && !source.startsWith(FOLLOW_UP_SOURCE) ? source : null, state,
      scheduled: state === "scheduled" ? { at_ms: receipt.next_attempt_at_ms!, attempt, attempts: kind === "no_reply" ? 1 : MAX_AUTOMATIC_FOLLOW_UPS, kind } : null };
  };
  return receipts.map((receipt) => ({
    inbox_item_id: receipt.inbox_item_id,
    source_message_id: receipt.source_message_id,
    fifo_sequence: receipt.fifo_sequence,
    reply_client_message_id: receipt.reply_client_message_id,
    canonical_message_id: receipt.canonical_message_id,
    state: receipt.inbox_item_id === restoringInboxItemId ? "restoring_conversation" : receipt.receipt_state,
    attempt_count: receipt.attempt_count,
    provider_turn_id: receipt.provider_turn_id,
    // Inbox ids are daemon-private. Project only the public source message id.
    blocked_by_message_id: receipt.blocked_by_inbox_item_id
      ? sourceMessageByInboxId.get(receipt.blocked_by_inbox_item_id) ?? null
      : null,
    error: receipt.last_error,
    failure_code: receipt.failure_code,
    terminal_reason: receipt.terminal_reason,
    updated_at: receipt.updated_at,
    timeline: receipt.timeline,
    ...withFollowUp(followUp(receipt)),
  }));
}

function withFollowUp<FollowUp>(follow_up: FollowUp | undefined): { follow_up?: FollowUp } {
  return follow_up ? { follow_up } : {};
}

export function projectDeliveryTurn(
  head: SupervisedInboxReceiptProjection | null,
  activeTurn: { inboxItemId: string; sourceMessageId: string; phase: "dispatching" | "responding" | "publishing" } | null,
): NonNullable<DaemonManifestEntryView["room_agent_state"]>["turn"] {
  if (!head) return { state: "idle", inbox_item_id: null, source_message_id: null, provider_turn_id: null, detail: null };
  // A persisted dispatch marker is recovery evidence, not proof that this
  // daemon is currently running the provider turn.
  if (!activeTurn || activeTurn.inboxItemId !== head.inbox_item_id) {
    return {
      state: head.state === "blocked" ? "failed" : head.state === "result_recovery" ? "retrying" : "idle",
      inbox_item_id: head.inbox_item_id,
      source_message_id: head.source_message_id,
      provider_turn_id: head.provider_turn_id,
      detail: head.last_error ?? "No current delivery operation is running.",
    };
  }
  return {
    state: activeTurn.phase,
    inbox_item_id: head.inbox_item_id,
    source_message_id: head.source_message_id,
    provider_turn_id: head.provider_turn_id,
    // The receipt retains prior failures for diagnostics; the active delivery
    // owns current progress and has not reported a failure of its own.
    detail: null,
  };
}
