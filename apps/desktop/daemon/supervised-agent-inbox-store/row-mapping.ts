import type { FollowUpKind } from "../task-continuity.js";
import type { SupervisedInboxState, InboxActivation, SupervisedInboxItem, SupervisedProviderTurnBinding, SupervisedInboxEvent, SupervisedInboxItemMetadata, AgentInspectorDetail, Row, ProviderContinuationRepair } from "./types.js";

export function rowToItem(row: Row): SupervisedInboxItem {
  return { ...rowToItemMetadata(row), source_message: JSON.parse(String(row.source_message_json)), activation: JSON.parse(String(row.activation_json)) };
}
export function rowToReceiptProjectionMetadata(row: Row): SupervisedInboxItemMetadata & { follow_up_kind?: FollowUpKind } {
  const metadata = rowToItemMetadata(row);
  return row.follow_up_kind === "provider_fault" || row.follow_up_kind === "no_reply" ? { ...metadata, follow_up_kind: row.follow_up_kind } : metadata;
}
export function rowToItemMetadata(row: Row): SupervisedInboxItemMetadata {
  return { inbox_item_id: String(row.inbox_item_id), agent_id: String(row.agent_id), room_id: String(row.room_id), source_message_id: String(row.source_message_id), fifo_sequence: Number(row.fifo_sequence), state: String(row.state) as SupervisedInboxState, attempt_count: Number(row.attempt_count), action_id: String(row.action_id), reply_client_message_id: String(row.reply_client_message_id), provider_turn_id: row.provider_turn_id === null ? null : String(row.provider_turn_id), outcome: row.outcome === null ? null : String(row.outcome), last_error: row.last_error === null ? null : String(row.last_error), failure_code: row.failure_code === null || row.failure_code === undefined ? null : String(row.failure_code) as "provider_continuation_missing", blocked_by_inbox_item_id: row.blocked_by_inbox_item_id === null ? null : String(row.blocked_by_inbox_item_id), next_attempt_at_ms: row.next_attempt_at_ms === null ? null : Number(row.next_attempt_at_ms), terminal_reason: row.terminal_reason === null || row.terminal_reason === undefined ? null : String(row.terminal_reason) as "upgrade_authority_unavailable", created_at: String(row.created_at), updated_at: String(row.updated_at), acknowledged_at: row.acknowledged_at === null ? null : String(row.acknowledged_at) };
}
export function rowToProviderTurnBinding(row: Row): SupervisedProviderTurnBinding {
  return {
    inbox_item_id: String(row.inbox_item_id),
    agent_id: String(row.agent_id),
    room_id: String(row.room_id),
    work_attempt_id: String(row.work_attempt_id),
    origin_execution_generation_id: String(row.origin_execution_generation_id),
    provider_continuation_id: String(row.provider_continuation_id),
    provider_turn_id: String(row.provider_turn_id),
  };
}
export function sameProviderTurnBinding(left: SupervisedProviderTurnBinding, right: SupervisedProviderTurnBinding): boolean {
  return left.inbox_item_id === right.inbox_item_id
    && left.agent_id === right.agent_id
    && left.room_id === right.room_id
    && left.work_attempt_id === right.work_attempt_id
    && left.origin_execution_generation_id === right.origin_execution_generation_id
    && left.provider_continuation_id === right.provider_continuation_id
    && left.provider_turn_id === right.provider_turn_id;
}
export function rowToEvent(row: Row): SupervisedInboxEvent { return { event_sequence: Number(row.event_sequence), phase: String(row.phase) as SupervisedInboxEvent["phase"], observed_at: String(row.observed_at), detail: row.detail === null ? null : String(row.detail) }; }
export function rowToInspectorItem(row: Row): AgentInspectorDetail["items"][number] { const source = safeSource(JSON.parse(String(row.source_message_json)), String(row.source_message_id), "", {}); return { source_message_id: String(row.source_message_id), inbox_item_id: String(row.inbox_item_id), state: String(row.state) as SupervisedInboxState, attempt_count: Number(row.attempt_count), updated_at: String(row.updated_at), sender: source?.sender ?? null, text_preview: source?.text ? source.text.slice(0, 240) : null, created_at: source?.created_at ?? null, outcome: safeOutcome(row.outcome === null ? null : String(row.outcome)), provider_turn_id: row.provider_turn_id === null ? null : String(row.provider_turn_id), last_error: row.last_error === null ? null : String(row.last_error), failure_code: row.failure_code === null || row.failure_code === undefined ? null : String(row.failure_code) as "provider_continuation_missing", terminal_reason: row.terminal_reason === null || row.terminal_reason === undefined ? null : String(row.terminal_reason) as "upgrade_authority_unavailable", canonical_message_id: row.canonical_message_id === null ? null : String(row.canonical_message_id) }; }
export function rowToContinuationRepair(row: Row): ProviderContinuationRepair {
  return {
    repair_id: String(row.repair_id),
    agent_id: String(row.agent_id),
    room_id: String(row.room_id),
    inbox_item_id: String(row.inbox_item_id),
    daemon_generation: Number(row.daemon_generation),
    execution_generation_id: String(row.execution_generation_id),
    work_attempt_id: String(row.work_attempt_id),
    expected_pid: Number(row.expected_pid),
    expected_process_identity: String(row.expected_process_identity),
    missing_continuation: String(row.missing_continuation),
    replacement_continuation: row.replacement_continuation === null ? null : String(row.replacement_continuation),
    phase: String(row.phase) as ProviderContinuationRepair["phase"],
    attempt_count: Number(row.attempt_count),
    last_error: row.last_error === null ? null : String(row.last_error),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
export function safeOutcome(outcome: string | null): unknown { try { return outcome ? JSON.parse(outcome) : null; } catch { return null; } }
export function safeSource(source: unknown, id: string, roomId: string, activation: InboxActivation): AgentInspectorDetail["source_message"] { const value = source && typeof source === "object" ? source as Record<string, unknown> : {}; const reply = value.reply_to && typeof value.reply_to === "object" ? value.reply_to as Record<string, unknown> : {}; return { id, room_id: roomId, sender: typeof value.sender === "string" ? value.sender : null, text: typeof value.text === "string" ? value.text : null, created_at: typeof value.timestamp === "string" ? value.timestamp : null, reply_to: typeof value.thread_reply_to_id === "string" ? value.thread_reply_to_id : typeof reply.id === "string" ? reply.id : null, thread_root_id: typeof value.thread_root_id === "string" ? value.thread_root_id : null, activation }; }
export function boundaryToDetail(row: Row): NonNullable<AgentInspectorDetail["history_boundary"]> { return { earliest_retained_observed_message_id: row.earliest_retained_observed_message_id === null ? null : String(row.earliest_retained_observed_message_id), earliest_retained_inbox_message_id: row.earliest_retained_inbox_message_id === null ? null : String(row.earliest_retained_inbox_message_id), earliest_retained_receipt_sequence: row.earliest_retained_receipt_sequence === null ? null : Number(row.earliest_retained_receipt_sequence), pruned_before_message_id: row.pruned_before_message_id === null ? null : String(row.pruned_before_message_id), pruned_at: row.pruned_at === null ? null : String(row.pruned_at) }; }
