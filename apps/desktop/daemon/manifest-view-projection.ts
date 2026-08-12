import type { SupervisedInboxReceiptWithTimeline } from "./supervised-agent-inbox-store.js";
import type { DaemonManifestEntryView } from "./types.js";

export function projectDeliveryReceipts(
  receipts: readonly SupervisedInboxReceiptWithTimeline[],
  restoringInboxItemId: string | null,
): DaemonManifestEntryView["delivery_receipts"] {
  const sourceMessageByInboxId = new Map(receipts.map((receipt) => [receipt.inbox_item_id, receipt.source_message_id]));
  return receipts.map((receipt) => ({
    inbox_item_id: receipt.inbox_item_id,
    source_message_id: receipt.source_message_id,
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
  }));
}

export function projectDeliveryTurn(
  head: SupervisedInboxReceiptWithTimeline | null,
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
    detail: head.last_error,
  };
}
